// Which widgets the lock screen shows, read from saved settings: each switch is kept only when
// it is a yes or a no.

const { DEFAULT_HUB_SETTINGS } = require('./defaults.js');

function normalizeLockWidgets(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.lockWidgets;
  return {
    clock: source.clock !== undefined ? !!source.clock : defaults.clock,
    weather: source.weather !== undefined ? !!source.weather : defaults.weather,
    media: source.media !== undefined ? !!source.media : defaults.media,
    calendar: source.calendar !== undefined ? !!source.calendar : defaults.calendar,
  };
}

module.exports = { normalizeLockWidgets };
