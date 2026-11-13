// Wraps raw sound samples in a WAV header, so any player or speech service can read them.

function pcmToWav(pcmBytes, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const buf = Buffer.alloc(44 + pcmBytes.length);
  buf.write('RIFF', 0);         buf.writeUInt32LE(36 + pcmBytes.length, 4);
  buf.write('WAVE', 8);         buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);    buf.writeUInt16LE(1, 20);  // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  buf.writeUInt16LE(channels * bitsPerSample / 8, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);        buf.writeUInt32LE(pcmBytes.length, 40);
  pcmBytes.copy(buf, 44);
  return buf;
}

module.exports = { pcmToWav };
