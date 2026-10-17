// AudioWorklet processor: downsample to 16kHz PCM16 + VAD
// This file runs in the AudioWorklet thread, NOT the main renderer thread.
class PCMChunker extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = (options.processorOptions || {}).targetRate || 16000;
    this.ratio = 0;
    this.speaking = false;
    this.silentFrames = 0;
    this.speechFrames = 0;
    this.threshold = 0.015;
    this.silenceLimit = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;
    if (this.ratio === 0) {
      this.ratio = sampleRate / this.targetRate;
      this.silenceLimit = Math.ceil(300 * sampleRate / (128 * 1000));
    }
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);
    const hasSpeech = rms > this.threshold;
    if (hasSpeech) { this.speechFrames++; this.silentFrames = 0; }
    else { this.silentFrames++; this.speechFrames = 0; }
    if (!this.speaking && this.speechFrames >= 3) {
      this.speaking = true;
      this.port.postMessage({ type: 'speech' });
    }
    if (this.speaking && this.silentFrames >= this.silenceLimit) {
      this.speaking = false;
      this.port.postMessage({ type: 'silence', duration: Math.round(this.silentFrames * 128 / sampleRate * 1000) });
    }
    const outLen = Math.floor(ch.length / this.ratio);
    if (outLen === 0) return true;
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * this.ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const next = Math.min(idx + 1, ch.length - 1);
      const v = ch[idx] * (1 - frac) + ch[next] * frac;
      const c = Math.max(-1, Math.min(1, v));
      pcm[i] = c < 0 ? c * 0x8000 : c * 0x7FFF;
    }
    this.port.postMessage({ type: 'audio', buffer: pcm.buffer, level: rms }, [pcm.buffer]);
    return true;
  }
}
registerProcessor('pcm-chunker', PCMChunker);
