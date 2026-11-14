// Says which Gemini model a role uses now: the one chosen in Settings when there is one, else
// the default for the key.

const aiModels = require('../ai-models.js');
const { GEMINI_MODEL_KEYS } = require('./gemini-model-keys.js');
const { hub } = require('../settings/current.js');

// Reads the in-memory settings mirror (`hub.settings`, kept fresh by every
// writer) rather than the disk, because these are read per AI request and several
// of the callers below are small sync helpers that only ever receive an API key.
function geminiModelFor(role) {
  const s = hub.settings || {};
  return aiModels.resolve('gemini', role, s[GEMINI_MODEL_KEYS[role]], s.geminiApiKey);
}

module.exports = { geminiModelFor };
