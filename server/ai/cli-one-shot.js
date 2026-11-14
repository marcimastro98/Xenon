// One question to the Claude Code or Codex program with the model the user chose for it.

const aiCli = require('../ai-cli.js');
const { readHubSettings } = require('../settings/read.js');

async function cliOneShot(provider, systemText, userText, settings) {
  const s = settings || (await readHubSettings().catch(() => null)) || {};
  const model = provider === 'claudecode' ? s.claudeCodeModel : s.codexModel;
  return aiCli.oneShot({ provider, model, systemText, userText });
}

module.exports = { cliOneShot };
