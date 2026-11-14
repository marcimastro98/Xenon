// The microphone the speech input is bound to and how ffmpeg reaches it on this system.

const sttDevice = {
  // STT via ffmpeg — WASAPI preferred (fast init), dshow fallback; avfoundation
  // on macOS, where the device is addressed by index rather than by name.
  ready: false,
  useWasapi: false,
  dshowDevice: null,
  avfIndex: null, // macOS avfoundation audio device index, as a string
  linuxFormat: null, // 'pulse' | 'alsa' — which one this ffmpeg knows
  micLabel: null, // mic label we last bound to. Drives re-init on device changes.
};

module.exports = { sttDevice };
