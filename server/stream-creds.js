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

// The key list is shared with the dashboard's localStorage mirror (js/settings-secrets.js).
const { SECRET_KEY_GROUPS } = require('./js/settings-secrets.js');
const STREAM_SECRET_KEYS = SECRET_KEY_GROUPS.stream;

// Each password belongs to the WebSocket server it was typed for. The defaults
// mirror the clients (actions/obs.js / streamerbot.js connect to 127.0.0.1 when
// the host is blank) and the settings normaliser's default ports.
const STREAM_DESTINATIONS = {
  obsPassword: { host: 'obsHost', port: 'obsPort', defaultPort: 4455 },
  streamerbotPassword: { host: 'streamerbotHost', port: 'streamerbotPort', defaultPort: 8080 },
};

// "host:port" as the WebSocket client will dial it. Blank, localhost and the
// loopback addresses all reach this PC, so they count as one destination.
function streamDestination(settings, key) {
  const d = STREAM_DESTINATIONS[key];
  const s = (settings && typeof settings === 'object') ? settings : {};
  let host = String(s[d.host] == null ? '' : s[d.host]).trim().toLowerCase();
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') host = 'loopback';
  const port = parseInt(s[d.port], 10) || d.defaultPort;
  return host + ':' + port;
}

// preserveStreamCreds: when an incoming client payload omits (or empties) a
// stream password, carry the persisted one over so a client save can never wipe
// a password the client never received — but only while host and port are
// unchanged. A save or an imported backup that points OBS / Streamer.bot at a
// different machine must not send it the saved password. Mutates and returns
// `incoming`.
function preserveStreamCreds(incoming, prev) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  if (!prev || typeof prev !== 'object') return incoming;
  for (const key of STREAM_SECRET_KEYS) {
    if (!incoming[key] && prev[key] && streamDestination(incoming, key) === streamDestination(prev, key)) {
      incoming[key] = prev[key];
    }
  }
  return incoming;
}

// redactStreamCreds: blank the stream passwords before settings reach the
// browser and expose only a `*Set` boolean so the UI can show a "saved"
// placeholder. Returns a shallow copy (persisted/in-memory settings keep the
// real values).
function redactStreamCreds(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const out = { ...settings };
  for (const key of STREAM_SECRET_KEYS) { out[key] = ''; out[key + 'Set'] = !!settings[key]; }
  return out;
}

module.exports = { preserveStreamCreds, redactStreamCreds, streamDestination, STREAM_SECRET_KEYS };
