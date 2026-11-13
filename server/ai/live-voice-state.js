// Whether a live voice session is open.

const liveVoice = {
  // ── Voce Live (Gemini Live realtime, opt-in beta) ────────────────────────────
  // At most one full-duplex Live session at a time (it owns the single mic). While
  // active the wake word stays suspended and the one-shot STT recorder is refused,
  // since dshow cannot share the capture device. See _handleLiveClient below.
  active: false,
};

module.exports = { liveVoice };
