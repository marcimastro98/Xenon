'use strict';

// Every AI provider key is a SERVER-ONLY secret. Same preserve-on-save +
// redact-on-wire contract as stream-creds.js (obs/streamerbot passwords).
//
// geminiApiKey joined this list in v4.11.0, and the reason it was outside it was
// never true: the client "needing" it meant putting it in the body of a request
// to OUR OWN server, which then called Google. Nothing in server/js/ has ever
// talked to generativelanguage.googleapis.com — an inventory of every use found
// eight, all of them either a presence gate or a `key:` field posted back to the
// endpoint that already had the key on disk. So the secret made a round trip to
// the browser for nothing, and on the paired-device door (R1.1) that round trip
// crossed the LAN in cleartext. The server-side half of the swap is
// `geminiKeyFor()` in server.js: an empty `key` falls back to the stored one, so
// the client sends nothing and every AI surface behaves exactly as before.
//
// Both halves are REQUIRED together. Redact without preserve and the next normal
// client save (which never carries the real key) wipes it; preserve without
// redact and the secret keeps leaking to the browser. Do not add just one.

const AI_PROVIDER_SECRET_KEYS = ['openaiApiKey', 'anthropicApiKey', 'geminiApiKey'];

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
    geminiApiKey: '',
    geminiApiKeySet: !!settings.geminiApiKey,
  };
}

module.exports = { preserveAiProviderCreds, redactAiProviderCreds };
