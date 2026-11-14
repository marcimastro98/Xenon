// Whether the speech recogniser on this computer was found ready.

const whisperState = {
  // ── Local "Hey Bit" wake word ─────────────────────────────────────────────
  // Same lifecycle discipline as the notification mirror: the ffmpeg capture
  // child runs only while the toggle is on, whisper.cpp is installed AND a
  // dashboard is open. wakeword.js owns the child, the VAD and the matcher; the
  // mic is read with the exact same device selection as the STT recorder.
  ready: false,
};

module.exports = { whisperState };
