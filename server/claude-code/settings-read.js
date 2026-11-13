// The Claude tile's settings, or its defaults when none were saved.

const claudeUsage = require('../claude-usage.js');
const { hub } = require('../settings/current.js');

function _claudeSettings() {
  const s = hub.settings && hub.settings.claude;
  return (s && typeof s === 'object') ? s : claudeUsage.DEFAULT_CLAUDE;
}

module.exports = { _claudeSettings };
