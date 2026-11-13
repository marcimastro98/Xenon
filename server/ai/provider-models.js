// Which model each AI provider uses for each job, as chosen in the settings.

const aiModels = require('../ai-models.js');
const { hub } = require('../settings/current.js');

// The same resolution for the two server-mediated cloud providers. `settings` is
// passed in where the caller already read it (every one of them does, for the
// server-only key); the mirror is the fallback.
const PROVIDER_MODEL_KEYS = Object.freeze({
  openai: { chat: 'openaiModel', stt: 'openaiSttModel', tts: 'openaiTtsModel' },
  anthropic: { chat: 'anthropicModel' },
});

function providerModelFor(provider, role, settings) {
  const s = settings || hub.settings || {};
  const key = (PROVIDER_MODEL_KEYS[provider] || {})[role];
  if (!key) return '';
  const apiKey = provider === 'openai' ? s.openaiApiKey : s.anthropicApiKey;
  return aiModels.resolve(provider, role, s[key], apiKey);
}

module.exports = { PROVIDER_MODEL_KEYS, providerModelFor };
