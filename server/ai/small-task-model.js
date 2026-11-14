// The light model a small task runs on with the AI the user set.

const aiXenon = require('../ai-xenon-credits.js');
const aiCli = require('../ai-cli.js');
const aiModels = require('../ai-models.js');
const { SMALL_TASK_FAMILY } = require('./small-task-models.js');
const { geminiKeyFor } = require('./gemini-key-for.js');

async function smallTaskModel(provider, settings) {
  if (aiCli.isCliProvider(provider)) return aiCli.lightModel(provider);
  if (provider === 'xenon') return aiXenon.HELPER_MODEL_ID;
  const family = SMALL_TASK_FAMILY[provider];
  if (!family) return '';
  const apiKey = provider === 'gemini' ? await geminiKeyFor('')
    : provider === 'openai' ? settings.openaiApiKey : settings.anthropicApiKey;
  return aiModels.resolve(provider, 'chat', family, apiKey);
}

module.exports = { smallTaskModel };
