// How much Xenon AI boosts the microphone before it listens, from the sensitivity slider in the
// settings.

const { hub } = require('../settings/current.js');

// Input gain applied to the captured audio. A Bluetooth hands-free mic produces
// a very low signal (the browser's getUserMedia hides this with automatic gain
// control; our raw ffmpeg capture does not), so we boost it both for end-of-
// speech detection and so Gemini receives an audible clip. The "Microphone
// sensitivity" slider drives the amount: 0 → 1.5×, 50 → ~3.25×, 100 → 5×.
function _sttGain() {
  const s = (hub.settings && Number.isFinite(hub.settings.aiMicSensitivity))
    ? hub.settings.aiMicSensitivity : 50;
  return Math.round((1.5 + (s / 100) * 3.5) * 10) / 10;
}

module.exports = { _sttGain };
