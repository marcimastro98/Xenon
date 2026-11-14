// Whether the search for the microphone has started, and the clock that binds it again after
// the device changes.

const sttStart = {
  started: false,
  // Re-bind the STT capture device when the user changes their default microphone.
  // The dshow path pins a device name at startup, so without this, selecting a
  // different mic (e.g. plugging in a headset) had no effect and recordings kept
  // reading the old — often silent — device ("detected and active but doesn't hear
  // me"). The WASAPI path uses "default" and already follows the change on its own,
  // so we only rebind for the paths that pin a device: dshow by name, avfoundation
  // by index. Debounced and skipped while a recording is live.
  rebindTimer: null,
};

module.exports = { sttStart };
