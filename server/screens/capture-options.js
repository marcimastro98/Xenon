// The capture settings as the engine works with them: what the user saved, with every missing
// or odd value put right.

const CaptureSettings = require('../capture-settings.js');
const { hub } = require('../settings/current.js');

function captureOptions() {
  return CaptureSettings.normalizeCaptureSettings(hub.settings && hub.settings.capture);
}

module.exports = { captureOptions };
