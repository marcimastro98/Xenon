'use strict';

// sportsDbKey is the OPTIONAL TheSportsDB Premium key. It is a SERVER-ONLY
// secret: the server's football.js uses it to call the provider (higher limits +
// the v2 livescore feed) and it must never reach the browser. Same
// preserve-on-save + redact-on-wire contract as stocks-creds.js / stream-creds.js.
//
// Both halves are REQUIRED together. Redact without preserve and the next normal
// client save (which never carries the real key) wipes it; preserve without
// redact and the secret keeps leaking to the browser. Do not add just one.

const FOOTBALL_SECRET_KEYS = ['sportsDbKey'];

// preserveFootballCreds: when an incoming client payload omits (or empties) the
// key, carry the persisted one over so a client save can never wipe a key the
// client never received. Mutates and returns `incoming`.
function preserveFootballCreds(incoming, prev) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  if (!prev || typeof prev !== 'object') return incoming;
  for (const key of FOOTBALL_SECRET_KEYS) {
    if (!incoming[key] && prev[key]) incoming[key] = prev[key];
  }
  return incoming;
}

// redactFootballCreds: blank the key before settings reach the browser and expose
// only a `*Set` boolean so the UI can show a "saved" placeholder. Returns a
// shallow copy (persisted/in-memory settings keep the real value).
function redactFootballCreds(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  return {
    ...settings,
    sportsDbKey: '',
    sportsDbKeySet: !!settings.sportsDbKey,
  };
}

module.exports = { preserveFootballCreds, redactFootballCreds };
