// ============================================================================
// AssemblyAI Universal-3 Streaming — Fallback STT Provider
// ============================================================================
// Drop-in replacement for DeepgramTranscriber with the same event interface.
// Used when Deepgram fails or times out for > 2 seconds.
//
// Protocol:
//   1. POST /v2/realtime/token to get a temporary auth token
//   2. Open WebSocket to wss://api.assemblyai.com/v2/realtime/ws
//   3. Send base64-encoded PCM audio frames
//   4. Receive PartialTranscript / FinalTranscript messages
//
// Emits same events as deepgram.js:
//   'interim-transcript', 'final-transcript', 'connected',
//   'disconnected', 'error', 'reconnecting'
// ============================================================================

const { EventEmitter } = require('events');
const WebSocket = require('ws');

const ASSEMBLYAI_TOKEN_URL = 'https://api.assemblyai.com/v2/realtime/token';
const ASSEMBLYAI_WS_URL = 'wss://api.assemblyai.com/v2/realtime/ws';

class AssemblyAITranscriber extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.apiKey          - AssemblyAI API key (from config)
   * @param {number} options.sampleRate      - Audio sample rate (default 16000)
   * @param {number} options.maxReconnects   - Max reconnect attempts (default 8)
   */
  constructor(options = {}) {
    super();

    this.apiKey = options.apiKey || '';
    this.sampleRate = options.sampleRate || 16000;
    this.maxReconnects = options.maxReconnects || 8;

    this._ws = null;
    this._isConnected = false;
    this._isConnecting = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._shouldReconnect = true;
    this._sessionId = null;

    this._stats = {
      totalTranscripts: 0,
      totalInterims: 0,
      bytesSent: 0,
      reconnects: 0
    };
  }

  get isConnected() { return this._isConnected; }
  get providerName() { return 'assemblyai'; }
  get stats() { return { ...this._stats }; }

  // -----------------------------------------------------------------------
  // Connection lifecycle
  // -----------------------------------------------------------------------

  async connect() {
    if (this._isConnected || this._isConnecting) return;
    if (!this.apiKey) {
      this.emit('error', { message: 'AssemblyAI API key not configured.', fatal: true });
      return;
    }

    this._isConnecting = true;
    this._shouldReconnect = true;

    // Step 1: Get a temporary session token
    let token;
    try {
      const resp = await fetch(ASSEMBLYAI_TOKEN_URL, {
        method: 'POST',
        headers: {
          authorization: this.apiKey,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ expires_in: 3600 })
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Token request failed (${resp.status}): ${errText}`);
      }

      const body = await resp.json();
      token = body.token;
      if (!token) throw new Error('No token in response');
    } catch (err) {
      this._isConnecting = false;
      this.emit('error', { message: `AssemblyAI auth failed: ${err.message}`, fatal: false });
      this._scheduleReconnect();
      return;
    }

    // Step 2: Open the streaming WebSocket
    const wsUrl = `${ASSEMBLYAI_WS_URL}?sample_rate=${this.sampleRate}&token=${token}`;

    try {
      this._ws = new WebSocket(wsUrl);
    } catch (err) {
      this._isConnecting = false;
      this.emit('error', { message: `AssemblyAI WS creation failed: ${err.message}`, fatal: false });
      this._scheduleReconnect();
      return;
    }

    this._ws.on('open', () => {
      this._isConnected = true;
      this._isConnecting = false;
      this._reconnectAttempts = 0;
      this.emit('connected', { provider: 'assemblyai' });
    });

    this._ws.on('message', (raw) => {
      this._handleMessage(raw);
    });

    this._ws.on('close', (code, reason) => {
      this._isConnected = false;
      this._isConnecting = false;
      this.emit('disconnected', {
        code,
        reason: reason?.toString() || '',
        willReconnect: this._shouldReconnect
      });
      if (this._shouldReconnect) {
        this._scheduleReconnect();
      }
    });

    this._ws.on('error', (err) => {
      this._isConnected = false;
      this._isConnecting = false;
      this.emit('error', { message: `AssemblyAI WS error: ${err.message}`, fatal: false });
    });
  }

  disconnect() {
    this._shouldReconnect = false;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;

    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try {
        this._ws.send(JSON.stringify({ terminate_session: true }));
      } catch { /* ignore */ }
      setTimeout(() => {
        if (this._ws) { this._ws.close(); this._ws = null; }
      }, 300);
    } else {
      if (this._ws) { this._ws.close(); this._ws = null; }
    }

    this._isConnected = false;
    this._isConnecting = false;
    this._sessionId = null;
  }

  // -----------------------------------------------------------------------
  // Audio input
  // -----------------------------------------------------------------------

  /**
   * Send PCM audio to AssemblyAI. Must be base64-encoded.
   * @param {ArrayBuffer|Buffer} pcmBuffer - 16kHz mono Int16 PCM
   */
  sendAudio(pcmBuffer) {
    if (!this._isConnected || !this._ws || this._ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      const base64 = Buffer.from(pcmBuffer).toString('base64');
      this._ws.send(JSON.stringify({ audio_data: base64 }));
      this._stats.bytesSent += pcmBuffer.byteLength;
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Message handling
  // -----------------------------------------------------------------------

  _handleMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch { return; }

    if (data.message_type === 'SessionBegins') {
      this._sessionId = data.session_id;
      return;
    }

    if (data.message_type === 'PartialTranscript') {
      const text = data.text || '';
      if (!text) return;

      this._stats.totalInterims++;
      this.emit('interim-transcript', {
        text,
        isFinal: false,
        speechFinal: false,
        confidence: data.confidence || 0,
        language: 'auto',  // AssemblyAI doesn't expose per-word language
        words: (data.words || []).map(w => ({
          word: w.text,
          start: w.start / 1000,
          end: w.end / 1000,
          confidence: w.confidence
        })),
        provider: 'assemblyai',
        timestamp: Date.now()
      });
    }

    if (data.message_type === 'FinalTranscript') {
      const text = data.text || '';
      if (!text) return;

      this._stats.totalTranscripts++;
      this.emit('final-transcript', {
        text,
        isFinal: true,
        speechFinal: true,
        confidence: data.confidence || 0,
        language: 'auto',
        words: (data.words || []).map(w => ({
          word: w.text,
          start: w.start / 1000,
          end: w.end / 1000,
          confidence: w.confidence
        })),
        provider: 'assemblyai',
        timestamp: Date.now()
      });
    }

    if (data.message_type === 'SessionTerminated') {
      this._sessionId = null;
    }

    if (data.error) {
      this.emit('error', {
        message: `AssemblyAI: ${data.error}`,
        fatal: false
      });
    }
  }

  // -----------------------------------------------------------------------
  // Reconnection
  // -----------------------------------------------------------------------

  _scheduleReconnect() {
    if (!this._shouldReconnect) return;
    if (this._reconnectAttempts >= this.maxReconnects) {
      this.emit('error', {
        message: `AssemblyAI: max reconnect attempts (${this.maxReconnects}) reached.`,
        fatal: true
      });
      return;
    }

    this._reconnectAttempts++;
    this._stats.reconnects++;
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts - 1), 16000);

    this.emit('reconnecting', {
      attempt: this._reconnectAttempts,
      maxAttempts: this.maxReconnects,
      delayMs: delay
    });

    this._reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  destroy() {
    this.disconnect();
    this.removeAllListeners();
  }
}

module.exports = { AssemblyAITranscriber };
