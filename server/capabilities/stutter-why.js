'use strict';
// "Why does it stutter?" (server/stutter-why.js): the answer now, for a Deck
// key or Bit, and the same answer as a toast on this PC's screens.
//
// deps.stutter (injected):
//   explain ()       → the answer (or { ok: false, error })
//   onAnswer (shown) shows it (SSE `stutter_why`, worded on the client)
//
// Only an answer is shown: an error already reaches whoever asked (the Deck's
// error line, Bit's turn). The English sentence stays with Bit; the screens get
// ids and numbers and word them in the user's language.

async function run(d) {
  const s = d && d.stutter;
  if (!s || typeof s.explain !== 'function') return { ok: false, error: 'unavailable' };
  const r = await s.explain();
  if (r && r.ok && typeof s.onAnswer === 'function') {
    const { summary, ...shown } = r;
    try { s.onAnswer(shown); } catch { /* the answer stands */ }
  }
  return r;
}

module.exports = { run };
