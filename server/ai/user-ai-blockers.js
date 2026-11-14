// Why the AI the user set cannot answer right now, look at a picture, or translate lyrics, said
// before any request is made.

const aiLocal = require('../ai-local.js');
const aiLocalServer = require('../ai-local-server.js');
const aiXenon = require('../ai-xenon-credits.js');
const aiCli = require('../ai-cli.js');
const { DATA_DIR } = require('../engine/paths.js');
const { readHubSettings } = require('../settings/read.js');
const { hub } = require('../settings/current.js');
const { geminiKeyFor } = require('./gemini-key-for.js');

// 'no_ai' when the AI set for Bit cannot answer (no key, no Sparks code), or ''.
// Checked before any request is made, so a missing key never costs a round trip.
// A Sparks code is the pass OR a Sparks-only buyer's wallet code.
async function userAiBlocker() {
  const settings = await readHubSettings().catch(() => null) || {};
  const provider = aiLocal.sanitizeProvider(settings.aiProvider);
  if (provider === 'openai' && !settings.openaiApiKey) return 'no_ai';
  if (provider === 'anthropic' && !settings.anthropicApiKey) return 'no_ai';
  if (provider === 'xenon' && !(await aiXenon.hasCode(DATA_DIR))) return 'no_ai';
  if (provider === 'gemini' && !(await geminiKeyFor(''))) return 'no_ai';
  return '';
}

// userAiBlocker(), then 'no_vision' when that AI cannot look at a picture: a
// plan run through its own program, an Ollama model without eyes, or a local
// server whose model the user has not said can see.
async function userAiVisionBlocker() {
  const blocked = await userAiBlocker();
  if (blocked) return blocked;
  const settings = await readHubSettings().catch(() => null) || {};
  const provider = aiLocal.sanitizeProvider(settings.aiProvider);
  if (aiCli.isCliProvider(provider)) return 'no_vision';
  if (provider === 'localapi' && !aiLocalServer.configFrom(settings).vision) return 'no_vision';
  if (provider === 'ollama') {
    const model = aiLocal.resolveModel(aiLocal.sanitizeModel(settings.ollamaModel), settings.hardwareScan);
    const sees = await aiLocal.supportsVisionLive(aiLocal.sanitizeOllamaUrl(settings.ollamaUrl), model).catch(() => false);
    if (!sees) return 'no_vision';
  }
  return '';
}

// Why translation cannot run right now, or '' when it can.
async function lyricsTranslateBlocker() {
  if (hub.settings.lyricsTranslate !== true) return 'off';
  return userAiBlocker();
}

module.exports = { userAiBlocker, userAiVisionBlocker, lyricsTranslateBlocker };
