'use strict';

// obsPassword / streamerbotPassword are SERVER-ONLY secrets: they are used only
// by the server's OBS and Streamer.bot WebSocket clients (deckObs / deckSb) and
// must never reach the browser. This mirrors the remote-control creds
// (preserveRemoteCreds / redactRemoteCreds) and the Home Assistant token
// (preserveHaToken / redactHaToken) pattern: preserve-on-save + redact-on-wire.
//
// Both halves are REQUIRED together. Redact without preserve and the next normal
// client save (which never carries the real password) wipes it; preserve without
// redact and the secret keeps leaking to the browser. Do not add just one.

const STREAM_SECRET_KEYS = ['obsPassword', 'streamerbotPassword'];

// preserveStreamCreds: when an incoming client payload omits (or empties) a
// stream password, carry the persisted one over so a client save can never wipe
// a password the client never received. Mutates and returns `incoming`.
function preserveStreamCreds(incoming, prev) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  if (!prev || typeof prev !== 'object') return incoming;
  for (const key of STREAM_SECRET_KEYS) {
    if (!incoming[key] && prev[key]) incoming[key] = prev[key];
  }
  return incoming;
}

// redactStreamCreds: blank the stream passwords before settings reach the
// browser and expose only a `*Set` boolean so the UI can show a "saved"
// placeholder. Returns a shallow copy (persisted/in-memory settings keep the
// real values).
function redactStreamCreds(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  return {
    ...settings,
    obsPassword: '',
    obsPasswordSet: !!settings.obsPassword,
    streamerbotPassword: '',
    streamerbotPasswordSet: !!settings.streamerbotPassword,
  };
}

module.exports = { preserveStreamCreds, redactStreamCreds };
