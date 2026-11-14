// What the remote-control panel knows and what it asks the server: the last status, the list of
// screens, which system the words are for, and where the panel is mounted.

(() => {
  'use strict';

  const state = {
    _mounted: false,
    // `state._status` caches the last known /remote/status response so we can
    // re-render without a fresh network call when the wizard step changes.
    _status: null,
    // Whether the user has consented and the wizard is revealed.
    _wizardOpen: false,
    // Ongoing Tailscale-login poll handle — cleared on success/timeout/error.
    _pollTimer: null,
    _screensPromise: null,
    _screensAt: 0,
  };

  // Published by settings.js once /version answers (see applyPlatformGating).
  // This panel is no longer hidden off Windows, so the words in it have to be
  // right on three systems instead of one.
  function platform() { return window.XenonPlatform || ''; }

  // Suffix a key with the platform, falling back to the bare key. Undefined —
  // /version has not landed yet — deliberately yields the bare key, which is
  // the Windows wording: it is what shipped, and a flash of the wrong package
  // manager beats a flash of a missing string.
  function platformKey(key) {
    const p = platform();
    if (p === 'linux') return `${key}_linux`;
    if (p === 'darwin') return `${key}_mac`;
    return key;
  }

  async function api(path, method = 'GET', body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json().catch(() => ({}));
  }

  // The monitor list changes rarely; cache the fetch so the dashboard widget
  // (re-rendered on every layout pass) hits /remote/screens once per minute
  // instead of once per render. The short TTL (vs a session-lifetime cache)
  // means a hot-plugged/removed monitor shows up on the next render within a
  // minute. Reset on an empty/failed result so a later render retries.
  const SCREENS_TTL_MS = 60000;

  function loadRemoteScreens() {
    if (state._screensPromise && Date.now() - state._screensAt < SCREENS_TTL_MS) return state._screensPromise;
    state._screensAt = Date.now();
    state._screensPromise = api('/remote/screens').then(s => {
      const list = Array.isArray(s) ? s : [];
      if (!list.length) state._screensPromise = null;
      return list;
    }).catch(() => { state._screensPromise = null; return []; });
    return state._screensPromise;
  }

  function getMounts() {
    return Array.from(document.querySelectorAll('[data-remotef="mount"]'));
  }

  // Branches to the control panel (feature already configured) or the setup
  // wizard (first-time / incomplete setup).
  function toolsInstalled(status) {
    return !!(status && status.installed && status.installed.sunshine && status.installed.tailscale);
  }

  function stepsDone(status) {
    const s = status || {};
    return [
      toolsInstalled(s),
      !!(s.tailscale && s.tailscale.connected),
      !!s.sunshineResponding,
      Array.isArray(s.connectedClients) && s.connectedClients.length > 0,
    ];
  }

  async function refreshStatus() {
    try {
      state._status = await api('/remote/status');
    } catch {
      state._status = null;
    }
    return state._status;
  }

  async function installTool(tool) {
    return api('/remote/install', 'POST', { tool });
  }

  window.RemoteControlStatus = {
    state, platform, platformKey, api, loadRemoteScreens, getMounts, toolsInstalled, stepsDone,
    refreshStatus, installTool,
  };
})();
