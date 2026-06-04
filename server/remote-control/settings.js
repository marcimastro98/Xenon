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

module.exports = { normalizeRemoteControl };
