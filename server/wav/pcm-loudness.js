// Measures how loud raw sound samples are: over the whole clip, at its loudest moment, and in
// decibels.

function _pcmRms(pcm) {
  if (!pcm || pcm.length < 2) return 0;
  const n = pcm.length - (pcm.length % 2);
  let sum = 0;
  for (let i = 0; i < n; i += 2) sum += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(sum / (n / 2));
}

function _pcmRmsStats(pcm, sampleRate = 16000, frameMs = 80) {
  const full = _pcmRms(pcm);
  const n = pcm ? pcm.length - (pcm.length % 2) : 0;
  const frameBytes = Math.max(2, Math.floor(sampleRate * frameMs / 1000) * 2);
  let peak = 0;
  for (let offset = 0; offset < n; offset += frameBytes) {
    const end = Math.min(n, offset + frameBytes);
    const frame = pcm.slice(offset, end - ((end - offset) % 2));
    if (frame.length >= 2) peak = Math.max(peak, _pcmRms(frame));
  }
  return { rms: full, peak: Math.max(peak, full) };
}

function _dbFromRms(rms) {
  if (!Number.isFinite(rms) || rms <= 0) return -60;
  return 20 * Math.log10(Math.max(1, rms) / 32768);
}

module.exports = { _pcmRms, _pcmRmsStats, _dbFromRms };
