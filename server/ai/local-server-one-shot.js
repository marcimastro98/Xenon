// One plain answer from the AI server the user runs on this PC.

const aiLocalServer = require('../ai-local-server.js');

// One answer through the user's Claude Code / Codex subscription (ai-cli.js),
// for the features a person starts themselves: a search, a button, the fold of
// their own conversation. Automatic background ones never come here; the two
// exceptions, lyrics translation and a widget granted `ai`, are each the user's
// explicit opt-in under a cap, on the plan's small model (completeWithUserAi).
// One plain answer from the server the user runs on this PC (ai-local-server.js).
function localServerOneShot(settings, systemText, userText, maxTokens) {
  return aiLocalServer.oneShot({ config: aiLocalServer.configFrom(settings), systemText, userText, maxTokens });
}

module.exports = { localServerOneShot };
