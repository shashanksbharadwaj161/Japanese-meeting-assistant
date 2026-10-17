// ============================================================================
// Deepgram Nova-3 — Streaming STT via WebSocket
// ============================================================================
// Each instance handles ONE audio source (interviewer OR candidate).
// The tag is set at construction and attached to every transcript event.
// ============================================================================

'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

class DeepgramTranscriber extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.tag           - 'interviewer' | 'candidate'
   * @param {string} opts.language      - 'multi' | 'ja' | 'en'
   * @param {string} opts.model         - default 'nova-3'
   * @param {number} opts.endpointing   - ms, default 200
   * @param {number} opts.sampleRate    - default 16000
   * @param {number} opts.maxReconnects - default 10
   */
  constructor(opts = {}) {
    super();
    this.apiKey        = opts.apiKey || '';
    this.tag           = opts.tag || 'interviewer';
    this.language      = opts.language || 'multi';
    this.model         = opts.model || 'nova-3';
    this.endpointing   = opts.endpointing || 200;
    this.sampleRate    = opts.sampleRate || 16000;
    this.maxReconnects = opts.maxReconnects || 10;
    this.diarize       = opts.diarize || false;   // separate speakers in one stream
    this.noDelay       = opts.noDelay || false;   // lower-latency finals

    this._ws = null;
    this._connected = false;
    this._connecting = false;
    this._reconnects = 0;
    this._reconnectTimer = null;
    this._shouldReconnect = true;
    this._keepAlive = null;
    this._connTs = 0;
    this._bytesSent = 0;
    this._msgCount = 0;
    this._transcripts = 0;
    this._interims = 0;
    this._buffer = [];          // holds chunks arriving before WS is open
    this._bufferMax = 300;

    // PCM accumulator: Deepgram silently ignores tiny chunks. The worklet
    // emits ~84-byte chunks (~2.6ms). We batch until >= 100ms of 16kHz mono
    // linear16 audio (3200 bytes) before sending so Deepgram can transcribe.
    this._accum = [];           // array of Buffers awaiting send
    this._accumBytes = 0;
    this._minSendBytes = 3200;  // 100ms @ 16kHz mono 16-bit
    this._sentBatches = 0;
  }

  get isConnected() { return this._connected; }
  get providerName() { return 'deepgram'; }

  // ------- connect -------
  connect() {
    if (this._connected || this._connecting) return;
    if (!this.apiKey) {
      this.emit('error', { message: 'Deepgram API key not configured.', fatal: true });
      return;
    }
    this._connecting = true;
    this._shouldReconnect = true;

    const params = new URLSearchParams({
      model: this.model,
      language: this.language,
      encoding: 'linear16',
      sample_rate: String(this.sampleRate),
      channels: '1',
      interim_results: 'true',
      endpointing: String(this.endpointing),
      utterance_end_ms: '1000',
      punctuate: 'true',
      smart_format: 'true',
    });
    if (this.diarize) params.set('diarize', 'true');
    if (this.noDelay) params.set('no_delay', 'true');
    const url = `${DEEPGRAM_WS_URL}?${params}`;
    console.log(`[dg:${this.tag}] Connecting...`);

    try {
      this._ws = new WebSocket(url, { headers: { Authorization: `Token ${this.apiKey}` } });
    } catch (err) {
      this._connecting = false;
      this.emit('error', { message: err.message, fatal: false });
      this._scheduleReconnect();
      return;
    }

    this._ws.on('open', () => {
      this._connected = true;
      this._connecting = false;
      this._reconnects = 0;
      this._connTs = Date.now();
      console.log(`[dg:${this.tag}] Connected`);

      // Flush buffered chunks
      if (this._buffer.length > 0) {
        console.log(`[dg:${this.tag}] Flushing ${this._buffer.length} buffered chunks`);
        for (const b of this._buffer) this._wsSend(b);
        this._buffer = [];
      }

      this._keepAlive = setInterval(() => {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
          try { this._ws.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
        }
      }, 8000);
      this.emit('connected', { provider: 'deepgram', tag: this.tag });
    });

    this._ws.on('message', (raw) => this._onMessage(raw));

    this._ws.on('close', (code) => {
      console.log(`[dg:${this.tag}] Closed code=${code}`);
      this._cleanup();
      this.emit('disconnected', { code, willReconnect: this._shouldReconnect });
      if (this._shouldReconnect) this._scheduleReconnect();
    });

    this._ws.on('error', (err) => {
      console.error(`[dg:${this.tag}] WS error:`, err.message);
      this._cleanup();
      this.emit('error', { message: err.message, fatal: false });
    });
  }

  // ------- send audio -------
  // Accumulate tiny worklet chunks into >= 100ms batches before sending.
  sendAudio(pcmBuf) {
    // Normalize to a Node Buffer (chunks arrive as ArrayBuffer over IPC).
    const buf = Buffer.from(pcmBuf);

    this._accum.push(buf);
    this._accumBytes += buf.byteLength;

    // Not enough audio yet — keep accumulating.
    if (this._accumBytes < this._minSendBytes) return true;

    // Concatenate the accumulated batch and reset the accumulator.
    const batch = this._accum.length === 1 ? this._accum[0] : Buffer.concat(this._accum, this._accumBytes);
    this._accum = [];
    this._accumBytes = 0;

    if (this._connected && this._ws && this._ws.readyState === WebSocket.OPEN) {
      return this._wsSend(batch);
    }
    // Buffer batches while connecting
    this._buffer.push(batch);
    if (this._buffer.length > this._bufferMax) this._buffer.shift();
    return false;
  }

  _wsSend(buf) {
    try {
      this._ws.send(buf);
      this._bytesSent += buf.byteLength || 0;
      this._sentBatches++;
      if (this._sentBatches === 1) {
        console.log(`[dg:${this.tag}] First batch sent, ${buf.byteLength}B (linear16 16kHz mono, ${Math.round((buf.byteLength / 2 / this.sampleRate) * 1000)}ms)`);
      }
      return true;
    } catch { return false; }
  }

  // ------- message handler -------
  _onMessage(raw) {
    let d;
    try { d = JSON.parse(raw.toString()); } catch { return; }
    this._msgCount++;

    // Detailed logging on every message from Deepgram.
    const dbgText = d.channel?.alternatives?.[0]?.transcript;
    console.log(`[dg:${this.tag}] msg type: ${d.type}`
      + ` | transcript: ${dbgText ? '"' + dbgText + '"' : '(empty)'}`
      + (d.type === 'Results' ? ` | is_final: ${d.is_final} speech_final: ${d.speech_final}` : ''));

    if (d.type === 'Metadata') {
      console.log(`[dg:${this.tag}] Metadata model=${d.model_info?.name}`);
      return;
    }

    if (d.type === 'Results' && d.channel?.alternatives?.[0]) {
      const alt = d.channel.alternatives[0];
      const text = alt.transcript || '';
      if (!text) return;

      const isFinal = d.is_final === true;
      const speechFinal = d.speech_final === true;
      const lang = alt.languages?.[0] || d.channel?.detected_language || this.language;

      // Diarization: derive the speaker tag from the per-word speaker indices.
      //   speaker 0 = first person to speak = interviewer
      //   speaker 1+ = candidate (you)
      let speakerTag = this.tag;
      if (this.diarize && Array.isArray(alt.words) && alt.words.length) {
        const counts = {};
        for (const w of alt.words) {
          if (typeof w.speaker === 'number') counts[w.speaker] = (counts[w.speaker] || 0) + 1;
        }
        const keys = Object.keys(counts);
        if (keys.length) {
          const dominant = keys.sort((a, b) => counts[b] - counts[a])[0];
          speakerTag = Number(dominant) === 0 ? 'interviewer' : 'candidate';
        }
      }

      const result = {
        text,
        isFinal,
        speechFinal,
        confidence: alt.confidence || 0,
        language: lang,
        speaker: speakerTag,         // 'interviewer' or 'candidate'
        provider: 'deepgram',
        timestamp: Date.now()
      };

      if (isFinal || speechFinal) {
        this._transcripts++;
        if (this._transcripts === 1) console.log(`[dg:${this.tag}] First final: ${text.substring(0, 60)}`);
        this.emit('final-transcript', result);
      } else {
        this._interims++;
        if (this._interims === 1) console.log(`[dg:${this.tag}] First interim: ${text.substring(0, 60)}`);
        this.emit('interim-transcript', result);
      }
    }

    if (d.type === 'UtteranceEnd') {
      this.emit('utterance-end', { tag: this.tag, timestamp: Date.now() });
    }

    if (d.type === 'Error') {
      console.error(`[dg:${this.tag}] Server error:`, d.description || d.message);
      this.emit('error', { message: d.description || d.message || 'Unknown', fatal: false });
    }
  }

  // ------- reconnect -------
  _scheduleReconnect() {
    if (!this._shouldReconnect || this._reconnects >= this.maxReconnects) {
      if (this._reconnects >= this.maxReconnects) {
        this.emit('error', { message: `Max reconnects (${this.maxReconnects}) reached`, fatal: true });
      }
      return;
    }
    this._reconnects++;
    const delay = Math.min(1000 * Math.pow(2, this._reconnects - 1), 16000);
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  _cleanup() {
    this._connected = false;
    this._connecting = false;
    if (this._keepAlive) { clearInterval(this._keepAlive); this._keepAlive = null; }
  }

  disconnect() {
    this._shouldReconnect = false;
    clearTimeout(this._reconnectTimer);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try { this._ws.send(JSON.stringify({ type: 'CloseStream' })); } catch {}
      setTimeout(() => { if (this._ws) { this._ws.close(); this._ws = null; } }, 500);
    } else if (this._ws) {
      this._ws.close(); this._ws = null;
    }
    this._cleanup();
    this._buffer = [];
  }

  destroy() {
    this.disconnect();
    this.removeAllListeners();
  }
}

module.exports = { DeepgramTranscriber };
