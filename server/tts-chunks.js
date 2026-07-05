'use strict';

// Split a reply into sentence-sized chunks for pipelined text-to-speech, so the
// server can synth + play the FIRST sentence while it generates the rest — the
// time-to-first-sound becomes the synth time of one sentence instead of the whole
// reply. Pure and side-effect free so it is unit-testable in isolation.

const MAX = 260;      // hard cap per chunk (bounds a punctuation-less run-on's synth)
const FOLD_MIN = 16;  // fold only genuinely tiny fragments ("Ok.", "Certo!") forward

function splitSentences(text) {
  const pieces = String(text || '').replace(/\s+/g, ' ').trim()
    // One "sentence" = run of non-terminators followed by any terminators
    // (Latin . ! ? … and CJK 。！？).
    .match(/[^.!?…。！？]+[.!?…。！？]*/g) || [];
  const chunks = [];
  for (let piece of pieces) {
    piece = piece.trim();
    if (!piece) continue;
    while (piece.length > MAX) { // split an over-long sentence on a word boundary
      const cut = piece.lastIndexOf(' ', MAX);
      const at = cut > MAX * 0.5 ? cut : MAX;
      chunks.push(piece.slice(0, at).trim());
      piece = piece.slice(at).trim();
    }
    if (piece) chunks.push(piece);
  }
  // Fold a trivially short fragment into the previous chunk so we don't synth
  // "Ok." on its own when more follows (a lone short reply stays its own chunk).
  const merged = [];
  for (const c of chunks) {
    if (merged.length && merged[merged.length - 1].length < FOLD_MIN) merged[merged.length - 1] += ' ' + c;
    else merged.push(c);
  }
  return merged.length ? merged : [String(text || '').trim()].filter(Boolean);
}

module.exports = { splitSentences, MAX };
