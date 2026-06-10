'use strict';

// Normalizes and validates the `remoteControl` settings sub-object.
// Strips unknown keys, coerces wrong types to safe defaults, and never
// returns undefined — callers can destructure the result unconditionally.
// sunshinePass is stored as a local secret (like geminiApiKey); never log it.
function normalizeRemoteControl(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const arr = Array.isArray(src.selectedMonitors)
    ? src.selectedMonitors.filter((v) => Number.isInteger(v) && v >= 0 && v <= 15).slice(0, 16)
    : [];
  return {
    enabled: src.enabled === true,
    sunshineInstalled: src.sunshineInstalled === true,
    tailscaleInstalled: src.tailscaleInstalled === true,
    sunshineUser: typeof src.sunshineUser === 'string' ? src.sunshineUser.trim().slice(0, 120) : '',
    sunshinePass: typeof src.sunshinePass === 'string' ? src.sunshinePass : '',
    selectedMonitors: arr,
    selectedScreen: typeof src.selectedScreen === 'string' ? src.selectedScreen.slice(0, 200) : '',
  };
}

// Remote-control credentials (sunshineUser/sunshinePass) are SERVER-ONLY secrets:
// they are configured server-side (configureSunshine) and the browser settings
// model never carries them. Without protection, a normal client settings save
// would overwrite settings.json without the creds and wipe them — leaving
// Sunshine with a password the dashboard no longer knows, so every Sunshine API
// call returns 401 and the panel shows "Not ready / No device" forever.
//
// preserveRemoteCreds: when an incoming client payload omits (or empties) the
// creds, carry the persisted ones over so a client save can never wipe them.
// Mutates and returns `incoming` for convenience.
function preserveRemoteCreds(incoming, prev) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  const prevRc = (prev && typeof prev === 'object' && prev.remoteControl) || {};
  if (!prevRc.sunshineUser && !prevRc.sunshinePass) return incoming;
  const rc = (incoming.remoteControl && typeof incoming.remoteControl === 'object')
    ? incoming.remoteControl
    : {};
  if (!rc.sunshineUser) rc.sunshineUser = prevRc.sunshineUser || '';
  if (!rc.sunshinePass) rc.sunshinePass = prevRc.sunshinePass || '';
  incoming.remoteControl = rc;
  return incoming;
}

// redactRemoteCreds: blank the secret fields before sending settings to the
// browser, so the server-only creds are never exposed over the wire. Returns a
// shallow copy (the in-memory/persisted settings keep the real values).
function redactRemoteCreds(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const rc = settings.remoteControl;
  if (!rc || typeof rc !== 'object') return settings;
  return { ...settings, remoteControl: { ...rc, sunshineUser: '', sunshinePass: '' } };
}

module.exports = { normalizeRemoteControl, preserveRemoteCreds, redactRemoteCreds };
