// The Codex tile's own choices from the settings, with their defaults.

const { hub } = require('../settings/current.js');

function _codexCfg() {
  const w = hub.settings && hub.settings.codexWidget;
  return w && typeof w === 'object' ? w : { approvals: true, waitSec: 90 };
}

module.exports = { _codexCfg };
