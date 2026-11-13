// The settings of the three built-in backgrounds (aurora, still, grid) as saved, each number
// within its limits.

const { clampNumber, normalizeHex } = require('../settings/values.js');
const { BG_STATIC_STYLES } = require('./background-values.js');
const { DEFAULT_HUB_SETTINGS } = require('../settings/defaults.js');

function normalizeBgAurora(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.bgAurora;
  return {
    enabled: source.enabled !== false,
    intensity: clampNumber(source.intensity, 0, 100, defaults.intensity),
    speed: clampNumber(source.speed, 0, 100, defaults.speed),
  };
}

function normalizeBgStatic(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.bgStatic;
  return {
    style: BG_STATIC_STYLES.includes(source.style) ? source.style : 'none',
    intensity: clampNumber(source.intensity, 0, 100, defaults.intensity),
  };
}

function normalizeBgGrid(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.bgGrid;
  return {
    enabled: source.enabled !== false,
    color: normalizeHex(source.color, defaults.color),
    intensity: clampNumber(source.intensity, 0, 100, defaults.intensity),
    speed: clampNumber(source.speed, 0, 100, defaults.speed),
  };
}

module.exports = { normalizeBgAurora, normalizeBgStatic, normalizeBgGrid };
