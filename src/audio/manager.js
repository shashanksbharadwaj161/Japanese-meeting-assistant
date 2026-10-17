// ============================================================================
// Audio Manager — Dual-source: Loopback (interviewer) + Mic (candidate)
// ============================================================================
// Runs in the RENDERER process. Captures TWO streams simultaneously:
//   1. System audio (getDisplayMedia) → 'loopback-chunk' + 'loopback-level'
//   2. Microphone (getUserMedia)      → 'mic-chunk'      + 'mic-level'
// Each stream gets its own AudioWorklet for independent PCM16 processing.
// ============================================================================

'use strict';

const WORKLET_URL = './pcm-worklet.js';

class DualAudioManager {
  constructor() {
    this._loopbackStream = null;
    this._micStream = null;
    this._loopbackCtx = null;
    this._micCtx = null;
    this._loopbackWorklet = null;
    this._micWorklet = null;
    this._running = false;

    // Callbacks
    this._onLoopbackChunk = null;
    this._onLoopbackLevel = null;
    this._onMicChunk = null;
    this._onMicLevel = null;
    this._onError = null;
  }

  get isRunning() { return this._running; }

  /** Set event handlers (called from overlay.js) */
  on(event, fn) {
    if (event === 'loopback-chunk') this._onLoopbackChunk = fn;
    else if (event === 'loopback-level') this._onLoopbackLevel = fn;
    else if (event === 'mic-chunk') this._onMicChunk = fn;
    else if (event === 'mic-level') this._onMicLevel = fn;
    else if (event === 'error') this._onError = fn;
  }

  /**
   * Start both audio captures. Loopback may fail (falls back gracefully).
   */
  async start() {
    if (this._running) await this.stop();
    this._running = true;

    // Start both in parallel
    const results = await Promise.allSettled([
      this._startLoopback(),
      this._startMic()
    ]);

    const loopOk = results[0].status === 'fulfilled';
    const micOk = results[1].status === 'fulfilled';

    console.log('[audio] Loopback:', loopOk ? 'OK' : 'FAILED', '| Mic:', micOk ? 'OK' : 'FAILED');

    if (!loopOk && !micOk) {
      this._emit('error', 'No audio sources available');
      return { loopback: false, mic: false };
    }

    return { loopback: loopOk, mic: micOk };
  }

  // ---- Loopback (system audio = interviewer) ----
  async _startLoopback() {
    try {
      this._loopbackStream = await navigator.mediaDevices.getDisplayMedia({
        audio: { channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 },
                 autoGainControl: false, noiseSuppression: false, echoCancellation: false },
        video: false
      });
    } catch (err) {
      console.warn('[audio] Loopback getDisplayMedia failed:', err.message);
      throw err;
    }

    const tracks = this._loopbackStream.getAudioTracks();
    if (!tracks.length) throw new Error('No loopback audio tracks');

    tracks[0].onended = () => {
      console.warn('[audio] Loopback track ended');
      this._emit('error', 'System audio track ended');
    };

    this._loopbackCtx = new AudioContext({ sampleRate: tracks[0].getSettings().sampleRate || 48000, latencyHint: 'interactive' });
    await this._loopbackCtx.audioWorklet.addModule(WORKLET_URL);

    const src = this._loopbackCtx.createMediaStreamSource(this._loopbackStream);
    this._loopbackWorklet = new AudioWorkletNode(this._loopbackCtx, 'pcm-chunker', {
      processorOptions: { targetRate: 16000 },
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit'
    });

    this._loopbackWorklet.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'audio') {
        if (this._onLoopbackChunk) this._onLoopbackChunk(d.buffer);
        if (this._onLoopbackLevel) this._onLoopbackLevel(d.level);
      }
    };

    src.connect(this._loopbackWorklet);
    this._loopbackWorklet.connect(this._loopbackCtx.destination);
    console.log('[audio] Loopback pipeline active');
  }

  // ---- Mic (candidate) ----
  async _startMic() {
    try {
      this._micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 },
                 noiseSuppression: true, echoCancellation: true, autoGainControl: true }
      });
    } catch (err) {
      console.warn('[audio] Mic getUserMedia failed:', err.message);
      throw err;
    }

    const tracks = this._micStream.getAudioTracks();
    if (!tracks.length) throw new Error('No mic audio tracks');

    tracks[0].onended = () => {
      console.warn('[audio] Mic track ended');
    };

    this._micCtx = new AudioContext({ sampleRate: tracks[0].getSettings().sampleRate || 48000, latencyHint: 'interactive' });
    await this._micCtx.audioWorklet.addModule(WORKLET_URL);

    const src = this._micCtx.createMediaStreamSource(this._micStream);
    this._micWorklet = new AudioWorkletNode(this._micCtx, 'pcm-chunker', {
      processorOptions: { targetRate: 16000 },
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit'
    });

    this._micWorklet.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'audio') {
        if (this._onMicChunk) this._onMicChunk(d.buffer);
        if (this._onMicLevel) this._onMicLevel(d.level);
      }
    };

    src.connect(this._micWorklet);
    this._micWorklet.connect(this._micCtx.destination);
    console.log('[audio] Mic pipeline active');
  }

  _emit(event, data) {
    if (event === 'error' && this._onError) this._onError(data);
  }

  async stop() {
    this._running = false;
    // Loopback cleanup
    if (this._loopbackWorklet) { this._loopbackWorklet.port.onmessage = null; this._loopbackWorklet.disconnect(); this._loopbackWorklet = null; }
    if (this._loopbackCtx && this._loopbackCtx.state !== 'closed') { try { await this._loopbackCtx.close(); } catch {} this._loopbackCtx = null; }
    if (this._loopbackStream) { this._loopbackStream.getTracks().forEach(t => t.stop()); this._loopbackStream = null; }
    // Mic cleanup
    if (this._micWorklet) { this._micWorklet.port.onmessage = null; this._micWorklet.disconnect(); this._micWorklet = null; }
    if (this._micCtx && this._micCtx.state !== 'closed') { try { await this._micCtx.close(); } catch {} this._micCtx = null; }
    if (this._micStream) { this._micStream.getTracks().forEach(t => t.stop()); this._micStream = null; }
    console.log('[audio] All sources stopped');
  }
}

// Export for use in overlay.js (renderer)
if (typeof module !== 'undefined') module.exports = { DualAudioManager };
