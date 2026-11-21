'use strict';
// The few words a pump face writes, in the saved language, put into the face page
// when it is served (routes.js). The page loads no table of all the app's words:
// a 480 px screen inside iCUE has no use for them.

const LayerI18n = require('../layers/layer-strings.js');

const KEYS = Object.freeze([
  'locale',
  'pump_face_nothing_playing', 'pump_face_notification', 'pump_face_call', 'pump_face_timer_done',
  'pump_face_hot', 'pump_face_no_reading', 'pump_face_reconnecting',
  'pump_reading_cpu_temp', 'pump_reading_cpu', 'pump_reading_gpu_temp', 'pump_reading_gpu',
  'pump_reading_ram', 'pump_reading_vram', 'pump_reading_power', 'pump_reading_fps',
  'pump_reading_cpu_clock', 'pump_reading_gpu_clock',
]);

async function pumpStrings(language) {
  const out = {};
  for (const key of KEYS) out[key] = await LayerI18n.text(key, language);
  return out;
}

module.exports = { pumpStrings, KEYS };
