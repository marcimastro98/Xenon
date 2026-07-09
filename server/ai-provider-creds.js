'use strict';

// openaiApiKey / anthropicApiKey are SERVER-ONLY secrets: the OpenAI (ChatGPT)
// and Anthropic (Claude) providers are called from the server (ai-openai.js /
// ai-anthropic.js), so — unlike geminiApiKey, which the browser needs — these
// keys must never reach the browser. Same preserve-on-save + redact-on-wire
// contract as stream-creds.js (obs/streamerbot passwords).
//
// Both halves are REQUIRED together. Redact without preserve and the next normal
// client save (which never carries the real key) wipes it; preserve without
// redact and the secret keeps leaking to the browser. Do not add just one.

const AI_PROVIDER_SECRET_KEYS = ['openaiApiKey', 'anthropicApiKey'];

// Carry a persisted key over when an incoming client save omits/empties it, so a
// routine settings save can never wipe a key the client never received — UNLESS
// the client explicitly cleared it. The redacted round-trip sends key='' with
// its `*Set` flag still true; a deliberate reset sends key='' with `*Set` false,
// which we honour by NOT preserving (so the key is actually removed).
function preserveAiProviderCreds(incoming, prev) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  if (!prev || typeof prev !== 'object') return incoming;
  for (const key of AI_PROVIDER_SECRET_KEYS) {
    const cleared = incoming[key + 'Set'] === false; // explicit reset from the UI
    if (!incoming[key] && prev[key] && !cleared) incoming[key] = prev[key];
  }
  return incoming;
}

// Blank the keys before settings reach the browser and expose only a `*Set`
// boolean so the UI can show a "saved" placeholder. Returns a shallow copy.
function redactAiProviderCreds(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  return {
    ...settings,
    openaiApiKey: '',
    openaiApiKeySet: !!settings.openaiApiKey,
    anthropicApiKey: '',
    anthropicApiKeySet: !!settings.anthropicApiKey,
  };
}

module.exports = { preserveAiProviderCreds, redactAiProviderCreds };
