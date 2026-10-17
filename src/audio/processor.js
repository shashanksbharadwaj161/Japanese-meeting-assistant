// ============================================================================
// Audio Processor: Noise Suppression → Downsample → PCM16 Chunking
// ============================================================================
//
// Pipeline:
//   MediaStream (48kHz float32)
//       → AudioWorklet (rnnoise + downsample to 16kHz + float32→int16)
//           → PCM chunks emitted via 'audio-chunk'
//           → VAD (voice activity detection) via energy + rnnoise probability
//           → Reconnection buffer (holds audio if STT websocket drops)
//
// Why 16kHz:  Deepgram Nova-3 optimal format; reduces bandwidth by 3x vs 48kHz
// Why PCM16:  linear16 encoding required by Deepgram WebSocket streaming
// Why rnnoise: runs 100% locally in WASM, no network calls, ~2ms per 10ms frame
//
// ============================================================================

const { EventEmitter } = require('events');

// ---------------------------------------------------------------------------
// AudioWorklet processor code (runs on the audio thread as a string/blob)
// ---------------------------------------------------------------------------
// This worklet does three things in one pass:
//   1. Noise suppression via rnnoise-wasm (if loaded)
//   2. Downsample from source rate to 16kHz
//   3. Convert float32 → int16 PCM
//
// It posts messages back to the main thread with:
//   { type: 'audio', buffer: Int16Array, level: number, vadProb: number }
//   { type: 'silence', duration: number }
//   { type: 'speech' }
// ---------------------------------------------------------------------------

const WORKLET_CODE = `
class AudioPCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const opts = options.processorOptions || {};
    this.targetRate = opts.targetRate || 16000;
    this.silenceThresholdMs = opts.silenceThresholdMs || 300;
    this.speechThreshold = opts.speechThreshold || 0.015;

    // Resampling state
    this.resampleRatio = 0; // set on first process() call
    this.resampleBuffer = new Float32Array(0);

    // VAD state
    this.isSpeaking = false;
    this.silentFrames = 0;
    this.speechFrames = 0;
    // How many 128-sample blocks = silenceThresholdMs at sampleRate
    // Computed on first process() once sampleRate is known
    this.silenceFrameThreshold = 0;
    this.speechFrameThreshold = 0; // 3 consecutive speech frames to trigger

    // rnnoise state (loaded asynchronously)
    this.rnnoiseReady = false;
    this.rnnoiseState = null;
    this.rnnoiseModule = null;

    // Listen for rnnoise WASM delivery from main thread
    this.port.onmessage = (e) => {
      if (e.data.type === 'rnnoise-wasm') {
        this._initRnnoise(e.data.wasmBinary);
      }
    };
  }

  async _initRnnoise(wasmBinary) {
    // rnnoise-wasm integration: we receive the compiled WASM binary
    // and instantiate it here on the audio thread.
    // For now, we mark it as a TODO — the rnnoise WASM module needs
    // a custom loader. The processor works without it (just skips denoising).
    // This will be wired in a future session when rnnoise-wasm is integrated.
    this.rnnoiseReady = false;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }

    const samples = input[0]; // Float32Array, typically 128 samples

    // Initialize ratios on first call (sampleRate is global in AudioWorklet)
    if (this.resampleRatio === 0) {
      this.resampleRatio = sampleRate / this.targetRate;
      // frames per ms = sampleRate / 1000 / 128
      const framesPerMs = sampleRate / (128 * 1000);
      this.silenceFrameThreshold = Math.ceil(this.silenceThresholdMs * framesPerMs);
      this.speechFrameThreshold = 3;
    }

    // --- 1. Compute RMS energy for VAD ---
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSquares += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSquares / samples.length);

    // --- 2. Noise suppression placeholder ---
    // When rnnoise is wired, this is where we'd process 480-sample frames
    // through the rnnoise denoiser. For now, pass through.
    let processed = samples;

    // --- 3. VAD (Voice Activity Detection) based on energy ---
    const speechDetected = rms > this.speechThreshold;

    if (speechDetected) {
      this.speechFrames++;
      this.silentFrames = 0;

      if (!this.isSpeaking && this.speechFrames >= this.speechFrameThreshold) {
        this.isSpeaking = true;
        this.port.postMessage({ type: 'speech' });
      }
    } else {
      this.silentFrames++;
      this.speechFrames = 0;

      if (this.isSpeaking && this.silentFrames >= this.silenceFrameThreshold) {
        this.isSpeaking = false;
        const silenceDurationMs = Math.round(
          (this.silentFrames * 128 / sampleRate) * 1000
        );
        this.port.postMessage({ type: 'silence', duration: silenceDurationMs });
      }
    }

    // --- 4. Downsample from sampleRate to 16kHz ---
    const outputLength = Math.floor(processed.length / this.resampleRatio);
    if (outputLength === 0) return true;

    const pcm16 = new Int16Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      // Linear interpolation for smoother downsampling
      const srcPos = i * this.resampleRatio;
      const srcIndex = Math.floor(srcPos);
      const frac = srcPos - srcIndex;
      const nextIndex = Math.min(srcIndex + 1, processed.length - 1);

      const interpolated = processed[srcIndex] * (1 - frac) + processed[nextIndex] * frac;

      // Clamp to [-1, 1] then convert to int16
      const clamped = Math.max(-1, Math.min(1, interpolated));
      pcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
    }

    // --- 5. Post PCM chunk to main thread ---
    this.port.postMessage(
      {
        type: 'audio',
        buffer: pcm16.buffer,
        level: rms,
        vadProb: speechDetected ? 1.0 : 0.0
      },
      [pcm16.buffer]  // Transfer ownership for zero-copy
    );

    return true;
  }
}

registerProcessor('audio-pcm-processor', AudioPCMProcessor);
`;


// ---------------------------------------------------------------------------
// Main-thread AudioProcessor class
// ---------------------------------------------------------------------------

class AudioProcessor extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} options.targetRate       - Output sample rate (default 16000)
   * @param {number} options.silenceThresholdMs - ms of silence for endpointing (default 300)
   * @param {number} options.speechThreshold  - RMS energy threshold (default 0.015)
   * @param {boolean} options.enableNoiseSuppression - Use rnnoise (default true)
   * @param {number} options.reconnectBufferMaxMs - Max audio to buffer during reconnects (default 5000)
   */
  constructor(options = {}) {
    super();

    this.targetRate = options.targetRate || 16000;
    this.silenceThresholdMs = options.silenceThresholdMs || 300;
    this.speechThreshold = options.speechThreshold || 0.015;
    this.enableNoiseSuppression = options.enableNoiseSuppression !== false;
    this.reconnectBufferMaxMs = options.reconnectBufferMaxMs || 5000;

    // Internal state
    this._audioContext = null;
    this._sourceNode = null;
    this._workletNode = null;
    this._isProcessing = false;

    // Reconnection buffer: holds PCM chunks while STT is reconnecting
    // so we don't lose speech during brief Deepgram/AssemblyAI drops.
    this._reconnectBuffer = [];
    this._reconnectBufferDurationMs = 0;
    this._isBuffering = false;

    // Stats
    this._stats = {
      chunksProcessed: 0,
      totalSamplesProcessed: 0,
      silenceEvents: 0,
      speechEvents: 0,
      bytesProduced: 0
    };
  }

  /**
   * Whether the processor is actively processing audio.
   */
  get isProcessing() {
    return this._isProcessing;
  }

  /**
   * Processing statistics.
   */
  get stats() {
    return { ...this._stats };
  }

  /**
   * Connect a MediaStream and start processing.
   * Creates an AudioContext, loads the AudioWorklet, wires up the pipeline.
   *
   * @param {MediaStream} mediaStream - From loopback or mic
   * @returns {Promise<void>}
   */
  async connect(mediaStream) {
    if (this._isProcessing) {
      await this.disconnect();
    }

    // Create AudioContext at the source's native rate
    // (typically 48000 for both loopback and mic on Windows)
    const tracks = mediaStream.getAudioTracks();
    const trackSettings = tracks[0]?.getSettings() || {};
    const sourceSampleRate = trackSettings.sampleRate || 48000;

    this._audioContext = new AudioContext({
      sampleRate: sourceSampleRate,
      latencyHint: 'interactive'
    });

    // Register the AudioWorklet from our inline code
    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(blob);

    try {
      await this._audioContext.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }

    // Create source from the MediaStream
    this._sourceNode = this._audioContext.createMediaStreamSource(mediaStream);

    // Create the AudioWorklet node
    this._workletNode = new AudioWorkletNode(this._audioContext, 'audio-pcm-processor', {
      processorOptions: {
        targetRate: this.targetRate,
        silenceThresholdMs: this.silenceThresholdMs,
        speechThreshold: this.speechThreshold
      },
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers'
    });

    // Handle messages from the AudioWorklet
    this._workletNode.port.onmessage = (event) => {
      this._handleWorkletMessage(event.data);
    };

    // Connect the pipeline: source → worklet → destination (needed to keep pipeline alive)
    this._sourceNode.connect(this._workletNode);
    this._workletNode.connect(this._audioContext.destination);

    // If rnnoise is enabled, try to load and send the WASM binary to the worklet
    if (this.enableNoiseSuppression) {
      this._loadRnnoiseWasm();
    }

    this._isProcessing = true;
    this.emit('processing-started', {
      sourceSampleRate,
      targetRate: this.targetRate,
      silenceThresholdMs: this.silenceThresholdMs
    });
  }

  /**
   * Attempt to load rnnoise-wasm and send it to the AudioWorklet.
   * Fails silently — processor works fine without it (just no denoising).
   */
  async _loadRnnoiseWasm() {
    try {
      // rnnoise-wasm is an optional dependency. If not installed, skip.
      const rnnoise = require('rnnoise-wasm');
      const wasmBinary = await rnnoise.getWasmBinary?.();
      if (wasmBinary && this._workletNode) {
        this._workletNode.port.postMessage(
          { type: 'rnnoise-wasm', wasmBinary },
          [wasmBinary]
        );
      }
    } catch {
      // rnnoise-wasm not installed or failed to load.
      // This is expected — processor works without denoising.
      // rnnoise will be wired in a future build session.
    }
  }

  /**
   * Handle messages from the AudioWorklet processor.
   */
  _handleWorkletMessage(data) {
    switch (data.type) {
      case 'audio': {
        const pcmBuffer = data.buffer; // ArrayBuffer of Int16
        const chunkDurationMs = (pcmBuffer.byteLength / 2) / this.targetRate * 1000;

        this._stats.chunksProcessed++;
        this._stats.totalSamplesProcessed += pcmBuffer.byteLength / 2;
        this._stats.bytesProduced += pcmBuffer.byteLength;

        if (this._isBuffering) {
          // STT is reconnecting — buffer the audio so we can replay it
          this._addToReconnectBuffer(pcmBuffer, chunkDurationMs);
        } else {
          // Normal operation — emit the chunk immediately
          this.emit('audio-chunk', {
            buffer: pcmBuffer,
            level: data.level,
            vadProb: data.vadProb,
            durationMs: chunkDurationMs,
            sampleRate: this.targetRate,
            encoding: 'linear16',
            channels: 1
          });
        }

        // Always emit audio level for UI meters
        this.emit('audio-level', data.level);
        break;
      }

      case 'silence': {
        this._stats.silenceEvents++;
        this.emit('silence-detected', {
          durationMs: data.duration,
          timestamp: Date.now()
        });
        break;
      }

      case 'speech': {
        this._stats.speechEvents++;
        this.emit('speech-detected', {
          timestamp: Date.now()
        });
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reconnection buffer: holds audio during STT websocket drops
  // -------------------------------------------------------------------------

  /**
   * Start buffering audio (call this when STT websocket disconnects).
   * Buffered chunks will be replayed when flush is called.
   */
  startBuffering() {
    this._isBuffering = true;
    this._reconnectBuffer = [];
    this._reconnectBufferDurationMs = 0;
    this.emit('buffering-started');
  }

  /**
   * Stop buffering and return all buffered PCM chunks.
   * Call this when the STT websocket reconnects.
   *
   * @returns {ArrayBuffer[]} Array of PCM Int16 ArrayBuffers in order
   */
  flushBuffer() {
    this._isBuffering = false;
    const buffered = this._reconnectBuffer.map(entry => entry.buffer);
    const totalMs = this._reconnectBufferDurationMs;

    this._reconnectBuffer = [];
    this._reconnectBufferDurationMs = 0;

    this.emit('buffer-flushed', {
      chunks: buffered.length,
      durationMs: totalMs
    });

    return buffered;
  }

  /**
   * Discard the reconnection buffer (e.g., if reconnect fails permanently).
   */
  discardBuffer() {
    this._isBuffering = false;
    const discardedMs = this._reconnectBufferDurationMs;
    this._reconnectBuffer = [];
    this._reconnectBufferDurationMs = 0;

    this.emit('buffer-discarded', { durationMs: discardedMs });
  }

  /**
   * Add a chunk to the reconnection buffer, evicting oldest if over max.
   */
  _addToReconnectBuffer(buffer, durationMs) {
    this._reconnectBuffer.push({ buffer, durationMs });
    this._reconnectBufferDurationMs += durationMs;

    // Evict oldest chunks if we exceed the max buffer duration
    while (this._reconnectBufferDurationMs > this.reconnectBufferMaxMs && this._reconnectBuffer.length > 1) {
      const removed = this._reconnectBuffer.shift();
      this._reconnectBufferDurationMs -= removed.durationMs;
    }
  }

  // -------------------------------------------------------------------------
  // Configuration updates (can be called while processing)
  // -------------------------------------------------------------------------

  /**
   * Update the silence threshold for endpointing.
   */
  setSilenceThreshold(ms) {
    this.silenceThresholdMs = ms;
    // We'd need to message the worklet to update its threshold.
    // For now, the change takes effect on next connect().
  }

  /**
   * Update the speech energy threshold.
   */
  setSpeechThreshold(level) {
    this.speechThreshold = level;
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /**
   * Disconnect from the current MediaStream and clean up.
   */
  async disconnect() {
    if (this._workletNode) {
      this._workletNode.port.onmessage = null;
      this._workletNode.disconnect();
      this._workletNode = null;
    }

    if (this._sourceNode) {
      this._sourceNode.disconnect();
      this._sourceNode = null;
    }

    if (this._audioContext && this._audioContext.state !== 'closed') {
      try {
        await this._audioContext.close();
      } catch {
        // AudioContext may already be closed
      }
      this._audioContext = null;
    }

    this._isProcessing = false;
    this._isBuffering = false;
    this._reconnectBuffer = [];
    this._reconnectBufferDurationMs = 0;

    this.emit('processing-stopped');
  }

  /**
   * Full cleanup: disconnect + remove listeners.
   */
  destroy() {
    this.disconnect();
    this.removeAllListeners();
  }

  /**
   * Reset stats counters.
   */
  resetStats() {
    this._stats = {
      chunksProcessed: 0,
      totalSamplesProcessed: 0,
      silenceEvents: 0,
      speechEvents: 0,
      bytesProduced: 0
    };
  }
}

module.exports = { AudioProcessor };
