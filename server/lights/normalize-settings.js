// The lighting settings as saved: brightness, which devices and effects are on, the animation,
// the providers and the native board.

const { clampNumber } = require('../settings/values.js');
const {
  normalizeLightingAnimation, normalizeLightingProviders, normalizeLightingEvent,
} = require('./settings-normalize.js');
const { normalizeLightingDeviceModes, normalizeLightingNative } = require('./devices-normalize.js');
const { DEFAULT_HUB_SETTINGS } = require('../settings/defaults.js');

function normalizeLighting(value) {
  const v = value && typeof value === 'object' ? value : {};
  const d = DEFAULT_HUB_SETTINGS.lighting;
  const fx = v.effects && typeof v.effects === 'object' ? v.effects : {};
  const devices = {};
  if (v.devices && typeof v.devices === 'object') {
    for (const [k, on] of Object.entries(v.devices)) devices[String(k).slice(0, 128)] = on === true;
  }
  return {
    enabled: v.enabled === true,
    lightsOut: v.lightsOut === true,
    brightness: clampNumber(v.brightness, 0, 1, d.brightness),
    pauseDuringGame: v.pauseDuringGame !== false,
    devices,
    effects: {
      temperature: fx.temperature === true,
      volume: fx.volume === true,
      musicAlbum: fx.musicAlbum === true,
      timer: normalizeLightingEvent(fx.timer, d.effects.timer),
      notification: normalizeLightingEvent(fx.notification, d.effects.notification),
      reminder: normalizeLightingEvent(fx.reminder, d.effects.reminder),
      vitals: normalizeLightingEvent(fx.vitals, d.effects.vitals),
    },
    animation: normalizeLightingAnimation(v.animation, d.animation),
    manualColor: /^#[0-9a-f]{6}$/i.test(String(v.manualColor)) ? v.manualColor : '',
    providers: normalizeLightingProviders(v.providers),
    deviceModes: normalizeLightingDeviceModes(v.deviceModes),
    native: normalizeLightingNative(v.native),
  };
}

module.exports = { normalizeLighting };
