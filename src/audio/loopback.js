// ============================================================================
// WASAPI Loopback Capture via electron-audio-loopback v1.0.6
// ============================================================================
// Captures ALL system audio (speakers/headphones) including Zoom/Meet/Teams
// Works by overriding getDisplayMedia in the main process and returning a
// system-audio MediaStream to the renderer. No VB-CABLE or virtual drivers.
//
// This module runs in the MAIN process. The renderer gets a MediaStream
// piped through IPC via the electron-audio-loopback override mechanism.
// ============================================================================

const { EventEmitter } = require('events');

class LoopbackCapture extends EventEmitter {
  constructor() {
    super();
    this._stream = null;
    this._isCapturing = false;
    this._initAttempted = false;
  }

  /**
   * Whether loopback is currently capturing audio.
   */
  get isCapturing() {
    return this._isCapturing;
  }

  /**
   * Get the raw MediaStream if available (renderer-side only).
   */
  get stream() {
    return this._stream;
  }

  /**
   * Initialize the loopback override in the main process.
   * Must be called BEFORE any BrowserWindow is created (app.whenReady).
   *
   * electron-audio-loopback patches desktopCapturer / getDisplayMedia
   * so that when the renderer calls getDisplayMedia({ audio: true }),
   * it receives the WASAPI loopback stream instead of prompting the user.
   */
  initializeMainProcess() {
    if (this._initAttempted) return;
    this._initAttempted = true;

    try {
      const loopback = require('electron-audio-loopback');

      // electron-audio-loopback v1.0.6 exposes an initialize() function
      // that hooks into Electron's desktopCapturer for WASAPI capture.
      // This must be called in the main process before windows are created.
      if (typeof loopback.initialize === 'function') {
        loopback.initialize();
      } else if (typeof loopback.default === 'function') {
        loopback.default();
      } else if (typeof loopback === 'function') {
        loopback();
      }

      this.emit('initialized');
    } catch (err) {
      const message = this._classifyError(err);
      this.emit('init-failed', { error: err, message });
    }
  }

  /**
   * Start capturing system audio in the renderer process.
   * Returns a MediaStream containing system audio.
   *
   * The renderer calls navigator.mediaDevices.getDisplayMedia({ audio: true })
   * which electron-audio-loopback has overridden to return WASAPI loopback.
   */
  async startCapture() {
    if (this._isCapturing && this._stream) {
      return this._stream;
    }

    try {
      // electron-audio-loopback overrides getDisplayMedia to return
      // system audio via WASAPI loopback. Request audio-only.
      this._stream = await navigator.mediaDevices.getDisplayMedia({
        audio: {
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48000 },
          autoGainControl: false,
          noiseSuppression: false,
          echoCancellation: false
        },
        video: false
      });

      // Verify we actually got audio tracks
      const audioTracks = this._stream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error('No audio tracks in loopback stream');
      }

      this._isCapturing = true;

      // Monitor track state — if the track ends unexpectedly, emit failure
      audioTracks[0].onended = () => {
        this._handleTrackEnded();
      };

      this.emit('started', {
        trackCount: audioTracks.length,
        settings: audioTracks[0].getSettings()
      });

      return this._stream;

    } catch (err) {
      this._isCapturing = false;
      this._stream = null;

      const message = this._classifyError(err);
      this.emit('loopback-failed', { error: err, message, fallbackToMic: true });

      throw err;
    }
  }

  /**
   * Stop loopback capture and release all tracks.
   */
  stopCapture() {
    if (this._stream) {
      this._stream.getTracks().forEach(track => {
        track.onended = null;
        track.stop();
      });
      this._stream = null;
    }
    this._isCapturing = false;
    this.emit('stopped');
  }

  /**
   * Handle unexpected track termination.
   */
  _handleTrackEnded() {
    this._isCapturing = false;
    this._stream = null;
    this.emit('loopback-failed', {
      error: new Error('Loopback audio track ended unexpectedly'),
      message: 'System audio capture stopped. Switching to microphone.',
      fallbackToMic: true
    });
  }

  /**
   * Classify errors into user-friendly messages.
   */
  _classifyError(err) {
    const msg = (err.message || '').toLowerCase();

    if (msg.includes('not a function') || msg.includes('cannot find module')) {
      return 'electron-audio-loopback is not installed or incompatible with this Electron version. '
           + 'Falling back to microphone capture.';
    }

    if (msg.includes('permission') || msg.includes('denied') || msg.includes('not allowed')) {
      return 'System audio capture was denied. Check Windows audio privacy settings. '
           + 'Falling back to microphone capture.';
    }

    if (msg.includes('no audio') || msg.includes('audio track')) {
      return 'No system audio detected. Make sure audio is playing through your speakers/headphones. '
           + 'Falling back to microphone capture.';
    }

    if (msg.includes('device') || msg.includes('wasapi')) {
      return 'Audio device error. Your audio output device may not support loopback capture. '
           + 'Falling back to microphone capture.';
    }

    return `System audio capture failed: ${err.message}. Falling back to microphone capture.`;
  }

  /**
   * Clean up all resources.
   */
  destroy() {
    this.stopCapture();
    this.removeAllListeners();
    this._initAttempted = false;
  }
}

module.exports = { LoopbackCapture };
