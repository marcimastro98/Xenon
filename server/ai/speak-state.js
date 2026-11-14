// The player of the voice that is speaking and the number that tells a stopped answer from the
// current one.

const speakState = {
  // ── Server-side audio output (voice + chimes) ──────────────────────────────
  // Plays through the system default device so audio works regardless of which
  // window has focus (the browser WebView blocks autoplay without a user gesture).
  proc: null,
  genToken: 0, // incremented on each stopServerSpeak to abort in-flight generation
};

module.exports = { speakState };
