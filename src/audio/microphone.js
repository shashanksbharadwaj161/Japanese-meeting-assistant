// ============================================================================
// Microphone Capture via Web Audio getUserMedia
// ============================================================================
// Two roles:
//   1. Fallback when WASAPI loopback fails
//   2. Primary capture when interviewer is physically in the same room
//
// Enumerates available mic devices so user can pick in Settings.
// Runs in the RENDERER process (getUserMedia is a browser API).
// ============================================================================

const { EventEmitter } = require('events');

class MicrophoneCapture extends EventEmitter {
  constructor() {
    super();
    this._stream = null;
    this._isCapturing = false;
    this._activeDeviceId = null;
  }

  /**
   * Whether mic is currently capturing.
   */
  get isCapturing() {
    return this._isCapturing;
  }

  /**
   * The active MediaStream.
   */
  get stream() {
    return this._stream;
  }

  /**
   * The device ID currently in use.
   */
  get activeDeviceId() {
    return this._activeDeviceId;
  }

  /**
   * Enumerate all available audio input devices.
   * Returns an array of { deviceId, label, groupId }.
   *
   * NOTE: On first call, labels may be empty strings until the user
   * grants mic permission. After startCapture(), re-calling this
   * will return full labels.
   */
  async listDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter(d => d.kind === 'audioinput')
        .map(d => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone (${d.deviceId.slice(0, 8)}...)`,
          groupId: d.groupId
        }));
    } catch (err) {
      this.emit('error', {
        error: err,
        message: 'Could not enumerate audio devices. Check browser permissions.'
      });
      return [];
    }
  }

  /**
   * Enumerate all audio output devices (for loopback device selection in settings).
   */
  async listOutputDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter(d => d.kind === 'audiooutput')
        .map(d => ({
          deviceId: d.deviceId,
          label: d.label || `Speaker (${d.deviceId.slice(0, 8)}...)`,
          groupId: d.groupId
        }));
    } catch (err) {
      return [];
    }
  }

  /**
   * Start capturing from a specific microphone.
   *
   * @param {string} deviceId - The mic device ID, or 'default' for system default.
   * @param {object} options  - Override audio constraints.
   * @returns {MediaStream}
   */
  async startCapture(deviceId = 'default', options = {}) {
    // Stop any existing capture first
    if (this._isCapturing) {
      this.stopCapture();
    }

    const constraints = {
      audio: {
        deviceId: deviceId !== 'default' ? { exact: deviceId } : undefined,
        channelCount: { ideal: 1, max: 1 },
        sampleRate: { ideal: 48000 },
        // Enable built-in browser processing as a first pass;
        // our AudioWorklet does heavier rnnoise processing after this
        noiseSuppression: options.noiseSuppression !== false,
        echoCancellation: options.echoCancellation !== false,
        autoGainControl: options.autoGainControl !== false
      }
    };

    try {
      this._stream = await navigator.mediaDevices.getUserMedia(constraints);

      const audioTracks = this._stream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error('No audio tracks returned from getUserMedia');
      }

      this._isCapturing = true;
      this._activeDeviceId = deviceId;

      // Monitor track endings
      audioTracks[0].onended = () => {
        this._handleTrackEnded();
      };

      // Watch for device changes (mic unplugged, etc.)
      navigator.mediaDevices.addEventListener('devicechange', this._onDeviceChange);

      const settings = audioTracks[0].getSettings();
      this.emit('started', {
        deviceId: settings.deviceId || deviceId,
        label: audioTracks[0].label,
        sampleRate: settings.sampleRate,
        channelCount: settings.channelCount,
        settings
      });

      return this._stream;

    } catch (err) {
      this._isCapturing = false;
      this._stream = null;
      this._activeDeviceId = null;

      const message = this._classifyError(err);
      this.emit('error', { error: err, message });

      throw err;
    }
  }

  /**
   * Switch to a different mic device without full teardown.
   */
  async switchDevice(newDeviceId) {
    const wasCapturing = this._isCapturing;
    this.stopCapture();

    if (wasCapturing) {
      return this.startCapture(newDeviceId);
    }
  }

  /**
   * Stop mic capture and release all tracks.
   */
  stopCapture() {
    navigator.mediaDevices.removeEventListener('devicechange', this._onDeviceChange);

    if (this._stream) {
      this._stream.getTracks().forEach(track => {
        track.onended = null;
        track.stop();
      });
      this._stream = null;
    }
    this._isCapturing = false;
    this._activeDeviceId = null;
    this.emit('stopped');
  }

  /**
   * Arrow function so `this` is bound for addEventListener/removeEventListener.
   */
  _onDeviceChange = async () => {
    if (!this._isCapturing || !this._activeDeviceId) return;

    // Check if our active device still exists
    const devices = await this.listDevices();
    const stillExists = devices.some(d => d.deviceId === this._activeDeviceId);

    if (!stillExists) {
      this.emit('device-lost', {
        deviceId: this._activeDeviceId,
        message: 'Microphone was disconnected. Attempting to switch to default device.'
      });

      // Try to switch to default
      try {
        this.stopCapture();
        await this.startCapture('default');
        this.emit('device-switched', { newDeviceId: 'default' });
      } catch (err) {
        this.emit('error', {
          error: err,
          message: 'Failed to switch to default microphone after device was lost.'
        });
      }
    }
  };

  /**
   * Handle unexpected track end.
   */
  _handleTrackEnded() {
    const lostDevice = this._activeDeviceId;
    this._isCapturing = false;
    this._stream = null;
    this._activeDeviceId = null;
    this.emit('track-ended', {
      deviceId: lostDevice,
      message: 'Microphone audio track ended unexpectedly.'
    });
  }

  /**
   * Classify errors into user-friendly messages.
   */
  _classifyError(err) {
    const name = err.name || '';
    const msg = (err.message || '').toLowerCase();

    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'Microphone permission denied. Please allow microphone access in your system settings '
           + 'and restart the app.';
    }

    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No microphone found. Please connect a microphone and try again.';
    }

    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'Microphone is in use by another application. Close other apps using the mic and try again.';
    }

    if (name === 'OverconstrainedError') {
      return `The requested microphone (${this._activeDeviceId}) is not available. `
           + 'Try selecting a different device in Settings.';
    }

    if (msg.includes('device') || msg.includes('hardware')) {
      return 'Microphone hardware error. Try unplugging and reconnecting your microphone.';
    }

    return `Microphone error: ${err.message}`;
  }

  /**
   * Clean up all resources.
   */
  destroy() {
    this.stopCapture();
    this.removeAllListeners();
  }
}

module.exports = { MicrophoneCapture };
