// ============================================================================
// Transcription Manager — STT Fallback Ladder + Question Detection
// ============================================================================
//
// Fallback order:
//   1. Deepgram Nova-3 Multilingual  (primary — sub-300ms, best JA/EN)
//   2. AssemblyAI Universal-3        (cloud failover — decent JA)
//   3. Vosk offline small-ja         (no internet — degraded)
//
// Health monitoring:
//   - If Deepgram fails to connect within 4s → switch to AssemblyAI
//   - If AssemblyAI also fails → switch to Vosk
//   - Periodically (every 30s) try to restore primary if it was demoted
//
// Question detection:
//   After each final transcript, asks Claude Haiku "Is this a question?"
//   Emits 'question-detected' or 'statement-detected' accordingly.
//   Sensitivity modes: 'always' | 'questions-only' | 'manual'
//
// Unified events:
//   'interim-transcript'   — live words as they come
//   'final-transcript'     — complete sentence
//   'question-detected'    — transcript is a question needing an answer
//   'statement-detected'   — transcript is a greeting/statement/filler
//   'stt-switched'         — provider changed (fallback or restore)
//   'translation-ready'    — EN translation available for a JP transcript
//   'error'                — non-fatal error info
// ============================================================================

const { EventEmitter } = require('events');
const { DeepgramTranscriber } = require('./deepgram');
const { AssemblyAITranscriber } = require('./assemblyai');
const { VoskTranscriber } = require('./vosk');

// Provider connection timeout before fallback
const CONNECT_TIMEOUT_MS = 4000;
// How often to attempt restoring the primary provider (ms)
const RESTORE_CHECK_INTERVAL_MS = 30000;

class TranscriptionManager extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.apiKeys - { deepgram, assemblyai, anthropic }
   * @param {string} options.language - 'multi', 'ja', 'en' (default 'multi')
   * @param {number} options.endpointing - Silence ms (default 300)
   * @param {string} options.sensitivity - 'always' | 'questions-only' | 'manual'
   * @param {Function} options.translateFn - async (jpText) => enText
   * @param {Function} options.classifyFn  - async (text) => 'YES'|'NO'
   */
  constructor(options = {}) {
    super();

    this._apiKeys = options.apiKeys || {};
    this._language = options.language || 'multi';
    this._endpointing = options.endpointing || 300;
    this._sensitivity = options.sensitivity || 'questions-only';

    // External functions injected from claude.js (keeps this module Claude-agnostic)
    this._translateFn = options.translateFn || null;
    this._classifyFn = options.classifyFn || null;

    // Provider instances (created lazily)
    this._providers = {};
    this._activeProvider = null;  // 'deepgram' | 'assemblyai' | 'vosk' | null
    this._isRunning = false;

    // Health monitoring
    this._restoreTimer = null;
    this._connectTimeouts = {};

    // Audio buffering during provider switches
    this._audioBuffer = [];
    this._isBuffering = false;
    this._maxBufferChunks = 200; // ~5s at default chunk rate
  }

  /** Name of the currently active STT provider. */
  get activeService() { return this._activeProvider; }

  /** Whether transcription is running. */
  get isRunning() { return this._isRunning; }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Start transcription. Creates providers, connects the primary.
   * @param {object} apiKeys - { deepgram, assemblyai, anthropic }
   */
  async start(apiKeys) {
    if (this._isRunning) await this.stop();

    if (apiKeys) this._apiKeys = apiKeys;
    this._isRunning = true;

    console.log('[stt-manager] Starting transcription manager');
    console.log('[stt-manager] API keys:', {
      deepgram: this._apiKeys.deepgram ? 'present (' + this._apiKeys.deepgram.substring(0, 6) + '...)' : 'MISSING',
      assemblyai: this._apiKeys.assemblyai ? 'present' : 'MISSING'
    });

    // Create provider instances
    this._createProviders();

    console.log('[stt-manager] Providers created:', Object.keys(this._providers).join(', '));

    // Try to connect in fallback order
    const connected = await this._connectWithFallback();
    if (!connected) {
      console.error('[stt-manager] ALL providers failed to connect!');
      this.emit('error', {
        message: 'All STT providers failed to connect.',
        allFailed: true
      });
    } else {
      console.log('[stt-manager] Connected! Active provider:', this._activeProvider);
    }

    // Start periodic restore check
    this._restoreTimer = setInterval(() => {
      this._tryRestorePrimary();
    }, RESTORE_CHECK_INTERVAL_MS);
  }

  /**
   * Stop all transcription.
   */
  async stop() {
    this._isRunning = false;

    // Clear timers
    clearInterval(this._restoreTimer);
    this._restoreTimer = null;
    Object.values(this._connectTimeouts).forEach(t => clearTimeout(t));
    this._connectTimeouts = {};

    // Disconnect all providers
    for (const [name, provider] of Object.entries(this._providers)) {
      try { provider.disconnect(); } catch { /* ignore */ }
    }

    this._activeProvider = null;
    this._audioBuffer = [];
    this._isBuffering = false;

    this.emit('stt-switched', { provider: null, reason: 'stopped' });
  }

  /**
   * Feed a PCM audio chunk to the active provider.
   * @param {ArrayBuffer|Buffer} pcmBuffer
   */
  sendAudio(pcmBuffer) {
    if (!this._isRunning) {
      if (!this._loggedNotRunning) {
        console.warn('[stt-manager] sendAudio called but manager not running');
        this._loggedNotRunning = true;
      }
      return;
    }

    this._chunkCount = (this._chunkCount || 0) + 1;

    // If we're switching providers, buffer the audio
    if (this._isBuffering) {
      this._audioBuffer.push(pcmBuffer);
      if (this._audioBuffer.length > this._maxBufferChunks) {
        this._audioBuffer.shift(); // Drop oldest
      }
      if (this._chunkCount === 1) {
        console.log('[stt-manager] Buffering audio (provider switching)');
      }
      return;
    }

    const provider = this._getActiveProvider();
    if (provider) {
      const sent = provider.sendAudio(pcmBuffer);
      if (this._chunkCount === 1) {
        console.log('[stt-manager] First chunk forwarded to provider:', this._activeProvider, 'sent:', sent);
      }
      if (this._chunkCount % 500 === 0) {
        console.log('[stt-manager] Chunks forwarded:', this._chunkCount, 'to', this._activeProvider);
      }
      if (!sent && this._activeProvider !== 'vosk') {
        // Provider rejected audio — it may have disconnected
        this._audioBuffer.push(pcmBuffer);
        if (this._audioBuffer.length === 1) {
          console.warn('[stt-manager] Provider rejected audio, buffering. Provider:', this._activeProvider);
        }
      }
    } else {
      if (this._chunkCount === 1 || this._chunkCount % 100 === 0) {
        console.warn('[stt-manager] No active provider! Chunks dropped:', this._chunkCount);
      }
    }
  }

  /**
   * Get the current active service name.
   * @returns {string|null}
   */
  getActiveService() {
    return this._activeProvider;
  }

  /**
   * Update sensitivity mode at runtime.
   */
  setSensitivity(mode) {
    this._sensitivity = mode; // 'always' | 'questions-only' | 'manual'
  }

  /**
   * Update the translation function at runtime.
   */
  setTranslateFn(fn) {
    this._translateFn = fn;
  }

  /**
   * Update the classify function at runtime.
   */
  setClassifyFn(fn) {
    this._classifyFn = fn;
  }

  // -----------------------------------------------------------------------
  // Provider creation & wiring
  // -----------------------------------------------------------------------

  _createProviders() {
    // Deepgram (primary)
    if (this._apiKeys.deepgram) {
      this._providers.deepgram = new DeepgramTranscriber({
        apiKey: this._apiKeys.deepgram,
        language: this._language,
        endpointing: this._endpointing
      });
      this._wireProvider('deepgram');
    }

    // AssemblyAI (fallback 1)
    if (this._apiKeys.assemblyai) {
      this._providers.assemblyai = new AssemblyAITranscriber({
        apiKey: this._apiKeys.assemblyai
      });
      this._wireProvider('assemblyai');
    }

    // Vosk (fallback 2 — always available, no API key needed)
    this._providers.vosk = new VoskTranscriber();
    this._wireProvider('vosk');
  }

  _wireProvider(name) {
    const provider = this._providers[name];
    if (!provider) return;

    provider.on('interim-transcript', (data) => {
      if (name !== this._activeProvider) return;
      this.emit('interim-transcript', data);

      // Start early translation on long interim transcripts (>5 words)
      const wordCount = (data.text || '').split(/\s+/).length;
      if (wordCount > 5 && this._translateFn && !this._interimTranslating) {
        this._interimTranslating = true;
        this._translateFn(data.text)
          .then(translation => {
            this.emit('translation-ready', {
              original: data.text,
              translation,
              language: data.language,
              provider: data.provider,
              interim: true,
              timestamp: Date.now()
            });
          })
          .catch(() => {})
          .finally(() => { this._interimTranslating = false; });
      }
    });

    provider.on('final-transcript', (data) => {
      if (name !== this._activeProvider) return;
      this.emit('final-transcript', data);
      this._interimTranslating = false; // Cancel any in-flight interim translation

      // Trigger translation + question detection asynchronously
      this._onFinalTranscript(data);
    });

    provider.on('error', (info) => {
      if (info.fatal && name === this._activeProvider) {
        // Active provider had a fatal error → fall to next
        this._fallToNext(name, info.message);
      }
      this.emit('error', { ...info, provider: name });
    });

    provider.on('disconnected', (info) => {
      if (name === this._activeProvider && info.willReconnect === false) {
        this._fallToNext(name, 'Provider disconnected');
      }
    });

    provider.on('connected', () => {
      // If this is the provider we were trying to activate, finalize the switch
      if (this._pendingActivation === name) {
        this._finalizeActivation(name);
      }
    });
  }

  // -----------------------------------------------------------------------
  // Connection with fallback
  // -----------------------------------------------------------------------

  async _connectWithFallback() {
    const order = this._getProviderOrder();

    for (const name of order) {
      const success = await this._tryConnect(name);
      if (success) return true;
    }

    return false;
  }

  /**
   * Try to connect a provider with a timeout.
   * @returns {boolean} true if connected successfully
   */
  async _tryConnect(name) {
    const provider = this._providers[name];
    if (!provider) return false;

    console.log('[stt-manager] Trying to connect:', name);

    return new Promise((resolve) => {
      let resolved = false;
      this._pendingActivation = name;

      const onConnected = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        this._finalizeActivation(name);
        resolve(true);
      };

      const onError = (info) => {
        if (resolved) return;
        if (info.fatal) {
          resolved = true;
          clearTimeout(timeout);
          provider.removeListener('connected', onConnected);
          resolve(false);
        }
      };

      // Timeout: if provider doesn't connect within CONNECT_TIMEOUT_MS, move on
      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        provider.removeListener('connected', onConnected);
        provider.removeListener('error', onError);
        try { provider.disconnect(); } catch { /* ignore */ }
        resolve(false);
      }, CONNECT_TIMEOUT_MS);

      provider.once('connected', onConnected);
      provider.once('error', onError);

      try {
        provider.connect();
      } catch (err) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(false);
        }
      }
    });
  }

  _finalizeActivation(name) {
    const previous = this._activeProvider;
    this._activeProvider = name;
    this._pendingActivation = null;
    console.log('[stt-manager] Provider activated:', name, '(previous:', previous, ')');

    // Flush any buffered audio to the new provider
    if (this._audioBuffer.length > 0) {
      const provider = this._providers[name];
      for (const chunk of this._audioBuffer) {
        provider.sendAudio(chunk);
      }
      this._audioBuffer = [];
    }
    this._isBuffering = false;

    if (previous !== name) {
      this.emit('stt-switched', {
        provider: name,
        previous,
        reason: previous ? 'fallback' : 'initial',
        offlineMode: name === 'vosk'
      });
    }
  }

  // -----------------------------------------------------------------------
  // Fallback
  // -----------------------------------------------------------------------

  async _fallToNext(failedName, reason) {
    if (!this._isRunning) return;

    // Start buffering audio during the switch
    this._isBuffering = true;

    const order = this._getProviderOrder();
    const failedIndex = order.indexOf(failedName);

    // Disconnect the failed provider
    try { this._providers[failedName]?.disconnect(); } catch { /* ignore */ }

    // Try remaining providers in order
    for (let i = failedIndex + 1; i < order.length; i++) {
      const name = order[i];
      const success = await this._tryConnect(name);
      if (success) return;
    }

    // All providers failed
    this._isBuffering = false;
    this._activeProvider = null;
    this.emit('error', { message: 'All STT providers failed.', allFailed: true });
    this.emit('stt-switched', { provider: null, reason: 'all-failed' });
  }

  // -----------------------------------------------------------------------
  // Primary restoration
  // -----------------------------------------------------------------------

  async _tryRestorePrimary() {
    if (!this._isRunning) return;
    const primary = this._getProviderOrder()[0];
    if (!primary || this._activeProvider === primary) return;

    // Don't try to restore if primary has no API key
    if (!this._providers[primary]) return;

    // Create a fresh instance to test connectivity
    let testProvider;
    if (primary === 'deepgram' && this._apiKeys.deepgram) {
      testProvider = new DeepgramTranscriber({
        apiKey: this._apiKeys.deepgram,
        language: this._language,
        endpointing: this._endpointing
      });
    } else if (primary === 'assemblyai' && this._apiKeys.assemblyai) {
      testProvider = new AssemblyAITranscriber({
        apiKey: this._apiKeys.assemblyai
      });
    }

    if (!testProvider) return;

    // Try to connect the primary with a timeout
    const connected = await new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) { resolved = true; resolve(false); }
      }, CONNECT_TIMEOUT_MS);

      testProvider.once('connected', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(true);
        }
      });
      testProvider.once('error', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(false);
        }
      });
      testProvider.connect();
    });

    if (connected && this._isRunning && this._activeProvider !== primary) {
      // Primary is back! Switch to it.
      const oldProvider = this._activeProvider;
      this._isBuffering = true;

      // Replace the old instance
      try { this._providers[primary]?.disconnect(); } catch { /* ignore */ }
      this._providers[primary] = testProvider;
      this._wireProvider(primary);
      this._finalizeActivation(primary);

      // Disconnect the old active provider
      if (oldProvider && oldProvider !== primary) {
        try { this._providers[oldProvider]?.disconnect(); } catch { /* ignore */ }
      }

      this.emit('stt-switched', {
        provider: primary,
        previous: oldProvider,
        reason: 'restored'
      });
    } else {
      // Primary still down, destroy the test instance
      testProvider.destroy();
    }
  }

  // -----------------------------------------------------------------------
  // Post-transcript processing: Translation + Question Detection
  // -----------------------------------------------------------------------

  async _onFinalTranscript(data) {
    const text = data.text;
    if (!text || text.trim().length < 2) return;

    // Run translation and question detection in parallel
    const tasks = [];

    // Translation (JP → EN)
    if (this._translateFn) {
      tasks.push(
        this._translateFn(text)
          .then(translation => {
            this.emit('translation-ready', {
              original: text,
              translation,
              language: data.language,
              provider: data.provider,
              timestamp: Date.now()
            });
          })
          .catch(() => {
            // Claude API down — skip translation, show JP only
          })
      );
    }

    // Question detection
    if (this._sensitivity !== 'manual' && this._classifyFn) {
      tasks.push(
        this._classifyFn(text)
          .then(answer => {
            const isQuestion = answer.trim().toUpperCase().startsWith('YES');

            if (isQuestion) {
              this.emit('question-detected', {
                text,
                language: data.language,
                provider: data.provider,
                confidence: data.confidence,
                timestamp: Date.now()
              });
            } else {
              this.emit('statement-detected', {
                text,
                language: data.language,
                provider: data.provider,
                timestamp: Date.now()
              });
            }
          })
          .catch(() => {
            // If classification fails, treat based on sensitivity
            if (this._sensitivity === 'always') {
              this.emit('question-detected', {
                text,
                language: data.language,
                provider: data.provider,
                confidence: data.confidence,
                timestamp: Date.now()
              });
            }
          })
      );
    } else if (this._sensitivity === 'always') {
      // No classify function but sensitivity=always → treat everything as question
      this.emit('question-detected', {
        text,
        language: data.language,
        provider: data.provider,
        confidence: data.confidence,
        timestamp: Date.now()
      });
    }

    // Wait for all tasks (fire-and-forget style, errors already handled)
    await Promise.allSettled(tasks);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  _getProviderOrder() {
    const order = [];
    if (this._providers.deepgram) order.push('deepgram');
    if (this._providers.assemblyai) order.push('assemblyai');
    if (this._providers.vosk) order.push('vosk');
    return order;
  }

  _getActiveProvider() {
    if (!this._activeProvider) return null;
    return this._providers[this._activeProvider] || null;
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  destroy() {
    this.stop();
    for (const provider of Object.values(this._providers)) {
      try { provider.destroy(); } catch { /* ignore */ }
    }
    this._providers = {};
    this.removeAllListeners();
  }
}

module.exports = { TranscriptionManager };
