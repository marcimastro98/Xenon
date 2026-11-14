// What the Claude Code tile is told about the link to the terminal.

const claudeLink = require('../claude-link.js');
const { PORT } = require('../engine/port.js');
const { DATA_DIR } = require('../engine/paths.js');
const { claudeState } = require('./tile-state.js');
const { claudeRefresh } = require('./refresh-state.js');

async function _claudeLinkStatus() {
  const st = await claudeLink.repairLink(DATA_DIR, PORT);
  if (st && st.repaired) {
    claudeRefresh.linkRepairedAt = Date.now();
    claudeState.bridgeToken = await claudeLink.ensureToken(DATA_DIR);
    console.log('[claude] Claude Code link updated to the current hook set: '
      + (st.repairedMissing || []).length + ' missing, ' + (st.repairedOutdated || 0) + ' out of date');
  }
  return { ...st, repairedAt: claudeRefresh.linkRepairedAt };
}

module.exports = { _claudeLinkStatus };
