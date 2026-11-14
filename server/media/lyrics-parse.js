'use strict';
// Reads lyrics into lines: timed ones from the LRC format, and plain text.

const { cleanText } = require('./lyrics-clean.js');

const MAX_LINES = 2000;

const STAMP_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_STAMP_RE = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;
const OFFSET_RE = /^\[offset:\s*([+-]?\d{1,6})\s*\]/im;

function stampMs(min, sec, frac) {
  const f = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;
  return (Number(min) * 60 + Number(sec)) * 1000 + f;
}

// LRC → [{ t: ms, text }], sorted. Several stamps on one line repeat it; word
// stamps (enhanced LRC) are dropped; metadata tags ([ar:], [ti:], …) are
// skipped; an empty text is kept as a pause. A positive [offset:] shows lines
// earlier, per the LRC convention.
function parseLrc(input) {
  const src = typeof input === 'string' ? input : '';
  if (!src) return [];
  const om = OFFSET_RE.exec(src);
  const offset = om ? Number(om[1]) : 0;
  const lines = [];
  for (const raw of src.split(/\r?\n/)) {
    STAMP_RE.lastIndex = 0;
    const stamps = [];
    let m;
    let end = 0;
    while ((m = STAMP_RE.exec(raw)) && m.index === end) {
      stamps.push(stampMs(m[1], m[2], m[3]));
      end = STAMP_RE.lastIndex;
    }
    if (!stamps.length) continue;
    const text = cleanText(raw.slice(end).replace(WORD_STAMP_RE, ''));
    for (const t of stamps) {
      lines.push({ t: Math.max(0, t - offset), text });
      if (lines.length >= MAX_LINES) break;
    }
    if (lines.length >= MAX_LINES) break;
  }
  lines.sort((a, b) => a.t - b.t);
  // Collapse runs of pauses: one gap marker is enough.
  return lines.filter((l, i) => l.text || !i || lines[i - 1].text);
}

function parsePlain(input) {
  if (typeof input !== 'string' || !input) return [];
  const out = input.split(/\r?\n/).slice(0, MAX_LINES).map(l => cleanText(l));
  while (out.length && !out[out.length - 1]) out.pop();
  while (out.length && !out[0]) out.shift();
  return out;
}

module.exports = { MAX_LINES, STAMP_RE, WORD_STAMP_RE, OFFSET_RE, stampMs, parseLrc, parsePlain };
