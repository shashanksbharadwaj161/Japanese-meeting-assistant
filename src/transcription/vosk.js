// ============================================================================
// Vosk Offline STT — Last-Resort Fallback
// ============================================================================
// 100% offline, zero network calls.
// Model: vosk-model-small-ja-0.22 (~50 MB, ~300 MB RAM)
//
// Limitations:
//   - Japanese only (small model), mediocre conversational accuracy
//   - No interim transcripts (Vosk only emits partials and finals)
//   - CER ~9.5% on clean audio, worse on noisy interview audio
//   - Treat as "is the user speaking at all" detector, not full transcript
//
// All transcripts are marked with offlineMode: true so the UI can
// display a "degraded mode" indicator.
//
// Emits: 'final-transcript', 'partial-transcript', 'error', 'ready'
// ============================================================================

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

class VoskTranscriber extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.modelPath  - Path to Vosk model directory
   * @param {number} options.sampleRate - Audio sample rate (default 16000)
   */
  constructor(options = {}) {
    super();

    this.modelPath = options.modelPath ||
      path.join(__dirname, '..', '..', 'models', 'vosk-model-small-ja');
    this.sampleRate = options.sampleRate || 16000;

    this._vosk = null;
    this._model = null;
    this._recognizer = null;
    this._isReady = false;
    this._isInitializing = false;

    this._stats = {
      totalTranscripts: 0,
      totalPartials: 0,
      samplesProcessed: 0
    };
  }

  get isConnected() { return this._isReady; }
  get providerName() { return 'vosk'; }
  get stats() { return { ...this._stats }; }

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  /**
   * Load the Vosk model and create a recognizer.
   * Call this once at startup. Fails gracefully if model not present.
   */
  async connect() {
    if (this._isReady || this._isInitializing) return;
    this._isInitializing = true;

    // Check model directory exists
    if (!fs.existsSync(this.modelPath)) {
      this._isInitializing = false;
      this.emit('error', {
        message: `Vosk model not found at ${this.modelPath}. `
               + 'Download vosk-model-small-ja-0.22 from https://alphacephei.com/vosk/models '
               + 'and extract it to the models/ directory.',
        fatal: true,
        modelMissing: true
      });
      return;
    }

    // Check for required model files
    const requiredFiles = ['am/final.mdl', 'conf/mfcc.conf'];
    const hasModelFiles = requiredFiles.some(f =>
      fs.existsSync(path.join(this.modelPath, f))
    );

    if (!hasModelFiles) {
      // Also check for alternative structure (some Vosk models differ)
      const altCheck = fs.existsSync(path.join(this.modelPath, 'README'))
        || fs.existsSync(path.join(this.modelPath, 'graph'));

      if (!altCheck) {
        this._isInitializing = false;
        this.emit('error', {
          message: 'Vosk model directory exists but appears incomplete. '
                 + 'Re-download and extract the full model.',
          fatal: true,
          modelMissing: true
        });
        return;
      }
    }

    try {
      // Dynamic require — vosk is an optional heavy dependency
      this._vosk = require('vosk');
      this._vosk.setLogLevel(-1); // Suppress Vosk's verbose logging

      this._model = new this._vosk.Model(this.modelPath);
      this._recognizer = new this._vosk.Recognizer({
        model: this._model,
        sampleRate: this.sampleRate
      });

      this._isReady = true;
      this._isInitializing = false;

      this.emit('connected', { provider: 'vosk', model: 'vosk-model-small-ja' });
      this.emit('ready');

    } catch (err) {
      this._isReady = false;
      this._isInitializing = false;

      const message = err.message.includes('Cannot find module')
        ? 'Vosk npm package not installed. Run: npm install vosk'
        : `Vosk initialization failed: ${err.message}`;

      this.emit('error', { message, fatal: true });
    }
  }

  // -----------------------------------------------------------------------
  // Audio input
  // -----------------------------------------------------------------------

  /**
   * Process a PCM audio chunk. Vosk processes synchronously.
   * @param {ArrayBuffer|Buffer} pcmBuffer - 16kHz mono Int16 PCM
   * @returns {boolean} true if audio was accepted
   */
  sendAudio(pcmBuffer) {
    if (!this._isReady || !this._recognizer) return false;

    try {
      const buffer = Buffer.from(pcmBuffer);
      this._stats.samplesProcessed += buffer.length / 2;

      const hasResult = this._recognizer.acceptWaveform(buffer);

      if (hasResult) {
        // Final result — Vosk decided this utterance is complete
        const resultJson = this._recognizer.result();
        const result = JSON.parse(resultJson);

        if (result.text && result.text.trim()) {
          this._stats.totalTranscripts++;
          this.emit('final-transcript', {
            text: result.text.trim(),
            isFinal: true,
            speechFinal: true,
            confidence: 0.5, // Vosk small model — low confidence
            language: 'ja',
            words: [],       // Vosk small model doesn't provide word-level
            provider: 'vosk',
            offlineMode: true,
            timestamp: Date.now()
          });
        }
      } else {
        // Partial result — speech still ongoing
        const partialJson = this._recognizer.partialResult();
        const partial = JSON.parse(partialJson);

        if (partial.partial && partial.partial.trim()) {
          this._stats.totalPartials++;
          this.emit('interim-transcript', {
            text: partial.partial.trim(),
            isFinal: false,
            speechFinal: false,
            confidence: 0.3,
            language: 'ja',
            words: [],
            provider: 'vosk',
            offlineMode: true,
            timestamp: Date.now()
          });
        }
      }

      return true;
    } catch (err) {
      this.emit('error', { message: `Vosk processing error: ${err.message}`, fatal: false });
      return false;
    }
  }

  /**
   * Force-finalize any pending audio (call on silence or end of session).
   */
  flush() {
    if (!this._isReady || !this._recognizer) return;

    try {
      const resultJson = this._recognizer.finalResult();
      const result = JSON.parse(resultJson);

      if (result.text && result.text.trim()) {
        this._stats.totalTranscripts++;
        this.emit('final-transcript', {
          text: result.text.trim(),
          isFinal: true,
          speechFinal: true,
          confidence: 0.5,
          language: 'ja',
          words: [],
          provider: 'vosk',
          offlineMode: true,
          timestamp: Date.now()
        });
      }
    } catch { /* ignore flush errors */ }
  }

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  disconnect() {
    if (this._recognizer) {
      try { this._recognizer.free(); } catch { /* ignore */ }
      this._recognizer = null;
    }
    if (this._model) {
      try { this._model.free(); } catch { /* ignore */ }
      this._model = null;
    }
    this._isReady = false;
    this._isInitializing = false;
    this.emit('disconnected', { provider: 'vosk' });
  }

  destroy() {
    this.disconnect();
    this._vosk = null;
    this.removeAllListeners();
  }
}

module.exports = { VoskTranscriber };
