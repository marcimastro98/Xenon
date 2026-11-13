// How often Voicemeeter is asked whether anything on the mixer moved.

// ── Voicemeeter mixer state → SSE `voicemeeter` ──────────────────────────────
// For SDK widgets that draw the mixer rather than only pressing it. Polled, not
// pushed: the Remote API has no callback, it has IsParametersDirty(), which is
// ONE call and answers "did anything move". The full read is ~96 calls on a
// Potato and only happens on the ticks that changed something.
//
// Gated twice, like every other periodic job here: nothing runs with no
// dashboard connected, and nothing runs on a machine that has no Voicemeeter —
// where `available` is false, this never even opens a session.
const VM_POLL_MS = 250;

module.exports = { VM_POLL_MS };
