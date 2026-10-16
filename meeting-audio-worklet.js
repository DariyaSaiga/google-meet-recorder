"use strict";

// Turns the meeting mix into mono 16-bit PCM for the Meeting Audio WAV.
// It runs in an AudioContext created at 16 kHz, so Chrome has already resampled.
class MeetingAudioCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(16000); // one second per message
    this.length = 0;
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data !== "flush") return;
      this.flush();
      this.stopped = true;
      this.port.postMessage({ done: true });
    };
  }

  flush() {
    if (this.length === 0) return;
    const chunk = this.buffer.slice(0, this.length);
    this.port.postMessage({ chunk }, [chunk.buffer]);
    this.length = 0;
  }

  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i += 1) {
      let sample = 0;
      for (const channel of channels) sample += channel[i];
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      this.buffer[this.length] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.length += 1;
      if (this.length === this.buffer.length) this.flush();
    }
    return true;
  }
}

registerProcessor("meeting-audio-capture", MeetingAudioCapture);
