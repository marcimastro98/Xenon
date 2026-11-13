// Checks the saved settings of the scrolling ticker bar: where it sits, how fast it moves and
// what feeds it.

const { clampNumber } = require('../settings/values.js');

// Scrolling ticker bar config: enabled, edge position, marquee speed and which
// data sources feed it. Known-key rebuild (no untrusted spread).
function normalizeTicker(value) {
  const v = value && typeof value === 'object' ? value : {};
  const src = v.sources && typeof v.sources === 'object' ? v.sources : {};
  return {
    enabled: v.enabled === true,
    position: v.position === 'top' ? 'top' : 'bottom',
    speed: clampNumber(v.speed, 10, 100, 50),
    sources: {
      stocks: src.stocks !== false,
      football: src.football !== false,
      news: src.news !== false,
    },
  };
}

module.exports = { normalizeTicker };
