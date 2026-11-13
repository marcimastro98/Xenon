// Loads the settings kept in this browser and saves them, here and to the engine, without losing a
// change.
'use strict';

let settingsServerSaveTimer = null;

function loadHubSettings() {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}'));
  } catch {
    return normalizeSettings(null);
  }
}

function saveLocalHubSettings() {
  if (_settingsReadOnly) return;
  // Server-only secrets stay OUT of localStorage: every key in the shared list
  // (js/settings-secrets.js — the same list the server's redaction uses: API
  // keys, OBS / Streamer.bot / UniFi passwords, the Home Assistant token, the
  // Sunshine login) plus private calendar links. They stay in memory only long
  // enough for the pending POST to reach the server, which then redacts them
  // back to '' on the next hydrate. The *Set flags are kept so the readiness
  // checks and the "saved" placeholders survive a reload.
  // Without the shared list the mirror is skipped rather than written with
  // secrets in it: the server copy is the authoritative one anyway.
  if (!window.SettingsSecrets) return;
  const forLocal = window.SettingsSecrets.stripSettingsSecrets(hubSettings);
  // Asset-carrying backgrounds/theme cards can push the blob past the origin
  // quota; a thrown setItem must not abort the save flow (the server copy —
  // written right after — is the authoritative one and still gets the change).
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(forLocal));
  } catch (err) {
    console.warn('settings: local mirror skipped (storage quota?)', err);
  }
}

function postHubSettingsToServer() {
  if (_settingsReadOnly) return Promise.resolve(null);
  // NO keepalive here: keepalive caps the request body at 64KB across the whole
  // page, and a settings blob with imported themes / Ambient scenes / decor easily
  // exceeds that — the fetch then rejects IMMEDIATELY ("Failed to fetch") and the
  // save never reaches the server, while the localStorage mirror makes everything
  // look saved on this screen. That silent divergence is exactly how UniFi camera
  // credentials kept "un-saving" for customized installs (same lesson as the Deck
  // outbox flush in deck.js). This POST runs while the page is alive (debounced
  // 250ms after the change), so it doesn't need to outlive an unload —
  // sendHubSettingsBeacon covers that case. A non-2xx answer rejects too, so
  // callers/retries can tell a failed save from a landed one.
  const body = JSON.stringify({ settings: normalizeSettings(hubSettings) });
  return fetch('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }).then(async (res) => {
    // Always drain the response, success or error: an UNREAD body bigger than
    // the network buffer keeps its connection permanently checked out of the
    // browser's 6-per-host pool. When the save ack still echoed the full
    // settings (multi-MB with imported themes), five discarded echoes + the
    // SSE stream starved the whole pool and every later request on the page
    // queued forever — the proven "dashboard deaf after importing a heavy
    // theme" wedge. The ack is slim now ({ok, rev}); the drain stays as the
    // client-side guarantee that no response can ever pin a connection again.
    try { await res.arrayBuffer(); } catch { /* stream already closed — the connection is free either way */ }
    if (!res.ok) { const e = new Error('settings save failed: HTTP ' + res.status); e.status = res.status; throw e; }
    return res;
  });
}

// A 4xx means the SERVER rejected this body and always will (malformed/oversized
// settings) — retrying can only loop forever, so give up and say so once. 408/429
// are the retryable exceptions (request timeout / rate limit). Anything without a
// status is a transport error (offline, server mid-restart) → retryable.
function _settingsSaveRetryable(err) {
  const s = err && err.status;
  if (!(typeof s === 'number' && s >= 400 && s < 500)) return true;
  return s === 408 || s === 429;
}

// Retry a failed background save with capped backoff for as long as the page
// lives (the change is already safe in the localStorage mirror; a one-shot POST
// to a server mid-restart is exactly what used to lose it). Token-superseded:
// a newer queued save or an explicit flush cancels the chain, and every attempt
// re-serializes the CURRENT settings, so a retry can never push stale state.
let _settingsSaveToken = 0;
function _postHubSettingsWithRetry(token, attempt) {
  if (token !== _settingsSaveToken) return;          // superseded by a newer save
  postHubSettingsToServer().catch((err) => {
    if (token !== _settingsSaveToken) return;
    if (!_settingsSaveRetryable(err)) {              // permanent client error → stop
      console.error('settings: server rejected the save and won\'t accept it, giving up', err);
      return;
    }
    if (attempt === 4) console.warn('settings: server save keeps failing, still retrying', err);
    setTimeout(() => _postHubSettingsWithRetry(token, attempt + 1), Math.min(800 * Math.pow(2, attempt), 10000));
  });
}

function queueHubSettingsServerSave() {
  clearTimeout(settingsServerSaveTimer);
  const token = ++_settingsSaveToken;
  settingsServerSaveTimer = setTimeout(() => {
    settingsServerSaveTimer = null;
    _postHubSettingsWithRetry(token, 0);
  }, 250);
}

// Immediate, awaitable save: cancel the debounced duplicate AND any retry chain
// (both would only re-post the same current state after us), then POST now.
// For callers that need the server to have the change before their next step —
// the browser-adblock relaunch, the Cameras connect flow refreshing its tiles.
function flushHubSettingsToServer() {
  clearTimeout(settingsServerSaveTimer);
  settingsServerSaveTimer = null;
  _settingsSaveToken++;
  return postHubSettingsToServer();
}
window.flushHubSettingsToServer = flushHubSettingsToServer;

// POST /settings overwrites the server copy wholesale (last-writer-wins), so a
// client that has not yet merged with the server MUST NOT push: a freshly wiped
// localStorage (app reinstall, WebView profile reset) would push factory
// defaults over the user's entire configuration — which is exactly what once
// destroyed a real install's theme/pages/settings. Until the first hydrate
// completes, server-bound saves are parked local-only and flushed (now carrying
// the merged, server-informed state) right after the hydrate.
let _hubHydratedFromServer = false;

// Hydration finished (with the server's copy, or with the legacy seed path that
// proves there is nothing to hydrate FROM). Both endings run through here so the
// startup cards below have exactly one moment to wait for.
function markHubHydrated() {
  if (_hubHydratedFromServer) return;
  _hubHydratedFromServer = true;
  if (window.BootSplash) window.BootSplash.ready('settings');
  // …which is also the first moment "the server has no dismissal stored" can be
  // told apart from "we have not asked yet", so the pre-v4.11.6 per-device
  // dismissals can be promoted now and never before.
  try { promoteLegacySeenFlags(); } catch { /* a migration must never break hydration */ }
  try { flushStartupCardWaiters(); } catch { /* nor must a waiter */ }
}
let _hubServerSavePending = false;

function saveHubSettings(options = {}) {
  const toServer = options.server !== false;
  // Bump the save revision only on a real, server-bound save (a user change).
  // Local-only mirrors (hydrate, lighting sync) must NOT bump it, or they'd make
  // the local copy look spuriously newer than the server's and re-push needlessly.
  if (toServer) {
    const cur = Number.isFinite(hubSettings && hubSettings.rev) ? hubSettings.rev : 0;
    hubSettings = normalizeSettings({ ...hubSettings, rev: cur + 1 });
  } else {
    hubSettings = normalizeSettings(hubSettings);
  }
  saveLocalHubSettings();
  if (toServer && !_settingsReadOnly) {
    if (_hubHydratedFromServer) queueHubSettingsServerSave();
    else _hubServerSavePending = true;
  }
}

// The Lighting page persists RGB config directly via /api/lighting/*. Mirror that
// change into the client settings store (local only — the server already saved it)
// so a later full-settings save can't push a stale `lighting` back over it.
function syncHubLighting(lighting) {
  if (!lighting || typeof lighting !== 'object') return;
  hubSettings = normalizeSettings({ ...hubSettings, lighting });
  saveLocalHubSettings();
}
window.syncHubLighting = syncHubLighting;

function sendHubSettingsBeacon() {
  // Same wipe guard as saveHubSettings: a page that never merged with the
  // server (fresh storage, server down at boot) must not beacon its defaults
  // over the user's stored configuration on unload.
  if (!_hubHydratedFromServer || _settingsReadOnly) return;
  // A weather change still inside its 250ms debounce would be lost on unload: the
  // whole-blob beacon below no longer carries weather (POST /settings keeps
  // prev.weather), so flush it through its own endpoint. sendBeacon first, then a
  // keepalive fetch — the only requests that survive the page tearing down.
  if (weatherConfigSaveTimer) {
    weatherConfigSaveTimer = null;
    try {
      const wbody = JSON.stringify(weatherConfigPayload());   // carries the rev too — see the note there
      if (!(navigator.sendBeacon && navigator.sendBeacon('/api/weather/config', new Blob([wbody], { type: 'application/json' })))) {
        fetch('/api/weather/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: wbody, keepalive: true }).catch(() => {});
      }
    } catch { /* best-effort on unload */ }
  }
  try {
    const body = JSON.stringify({ settings: normalizeSettings(hubSettings) });
    // sendBeacon refuses bodies over its ~64KB queue limit (returns false), and a
    // settings blob with imported themes/scenes exceeds it. When it refuses, fall
    // back to a KEEPALIVE fetch — on unload that's the only request that survives
    // the page tearing down (a plain fetch is cancelled). Keepalive shares the same
    // ~64KB cap, but a >64KB body simply can't be delivered on unload by any method,
    // so that rejects harmlessly here; the live-page debounced save (no keepalive,
    // no cap) is what covers large blobs before it ever gets to unload.
    if (navigator.sendBeacon
        && navigator.sendBeacon('/settings', new Blob([body], { type: 'application/json' }))) {
      return;
    }
    fetch('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {}
}
