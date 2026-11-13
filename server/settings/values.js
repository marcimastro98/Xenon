// Checks of single saved values that many settings share: a number kept inside its range, a hex
// colour.

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeHex(value, fallback) {
  const raw = String(value || '').trim();
  const short = raw.match(/^#?([0-9a-f]{3})$/i);
  if (short) return '#' + short[1].split('').map(ch => ch + ch).join('').toLowerCase();
  const full = raw.match(/^#?([0-9a-f]{6})$/i);
  return full ? '#' + full[1].toLowerCase() : fallback;
}

module.exports = { clampNumber, normalizeHex };
