// Fetches the settings the engine holds and keeps this page in step with them, at start and after a
// reconnect.
'use strict';

// Hydrate could not read the server copy (offline at boot, server restarting):
// keep retrying in the background — server-bound saves stay parked until one
// attempt succeeds, so a blind client can never clobber the stored settings.
let _hubHydrateRetryTimer = null;
function scheduleHubHydrateRetry() {
  if (_hubHydrateRetryTimer || _hubHydratedFromServer) return;
  _hubHydrateRetryTimer = setTimeout(() => {
    _hubHydrateRetryTimer = null;
    // A reconnect reconcile may have hydrated us in the meantime — don't re-fetch.
    if (_hubHydratedFromServer) return;
    hydrateHubSettingsFromServer();
  }, 4000);
}

// Does this browser's settings mirror belong to a DIFFERENT store than the one
// the server is serving? Pure, so the rule is unit-testable
// (test/settings-store-identity.test.mjs).
//
// The mirror is keyed by ORIGIN, and an origin is an address, not an install: a
// reinstalled PC that gets the same LAN address back is the same origin as the
// one that was wiped, so every surface still holds a full mirror of a store that
// no longer exists. `rev` cannot see that — it counts from 0 per store, so the
// new store loses to any old mirror and gets overwritten by it. Reported on
// Discord after a clean Windows install: the phone paired before the wipe
// republished its months-old layout over the fresh install. It landed well that
// time; the same mechanism aimed at a dashboard the user has just rebuilt is a
// silent loss of their work.
//
// An UNKNOWN id on either side answers false, and that is deliberate rather than
// cautious: absent means "this side cannot say" (a mirror written before this
// build, a server too old to mint one), never "different". Answering true there
// would throw away the one case the rev comparison exists for — a save that
// never reached the server before a shutdown — for every surface at once, on the
// single load after the update. Every surface stamps its store on its first
// hydrate, so the window is one load wide.
function settingsMirrorIsForeign(serverStoreId, knownStoreId) {
  const server = typeof serverStoreId === 'string' ? serverStoreId : '';
  const known = typeof knownStoreId === 'string' ? knownStoreId : '';
  if (!server || !known) return false;
  return server !== known;
}

function readKnownSettingsStore() {
  try { return localStorage.getItem(SETTINGS_STORE_KEY) || ''; } catch { return ''; }
}
function rememberSettingsStore(storeId) {
  if (!storeId) return;
  try { localStorage.setItem(SETTINGS_STORE_KEY, storeId); } catch { /* private mode / quota */ }
}

let _hubHydrateInflight = null;
// Dedupe concurrent hydrates. es.onopen fires on the FIRST SSE connect too, so the
// module-load hydrate and the SSE-onopen reconcile can both start before either
// finishes — that would run two overlapping fetch+normalize+save passes (and a
// redundant server POST) on every normal load. Share the in-flight promise instead.
function hydrateHubSettingsFromServer() {
  if (_hubHydrateInflight) return _hubHydrateInflight;
  _hubHydrateInflight = _hydrateHubSettingsImpl().finally(() => { _hubHydrateInflight = null; });
  return _hubHydrateInflight;
}

// Live settings sync across surfaces: the server broadcasts an SSE `settings`
// event (with the new rev) after every accepted save. When ANOTHER surface
// (Xeneon Edge screen / external browser / native app — different origins, so
// the `storage` event never fires across them) saved, our local rev is older →
// re-hydrate so this dashboard adopts the change live instead of clobbering it
// wholesale with its own stale blob on its next edit. Our own save comes back
// with a rev we already hold and is ignored.
//
// Coalesced and deferred, never dropped: a burst of broadcasts (a slider drag
// on another surface saves ~4×/sec) runs ONE trailing hydrate, and an event
// arriving while a local save is debounce-pending or a hydrate is in flight is
// retried shortly after instead of being lost (the server assigns strictly
// increasing revs, so a stale local rev always sees a newer one eventually).
let _settingsSsePendingRev = 0;
let _settingsSseTimer = null;
let _settingsSseHydrating = false;
function _onServerSettingsRev(rev) {
  const serverRev = Number(rev) || 0;
  if (serverRev > _settingsSsePendingRev) _settingsSsePendingRev = serverRev;
  if (!_settingsSseTimer) _settingsSseTimer = setTimeout(_runSettingsSseHydrate, 400);
}
window._onServerSettingsRev = _onServerSettingsRev;

// Reconcile settings after the SSE stream (re)connects. SSE has no replay: a
// `settings` broadcast that fired while our EventSource was down is gone for
// good, so a surface whose stream dropped can stay on stale — or, on a fresh
// native WebView whose initial hydrate raced a backend restart, factory —
// settings forever (GitHub #72: the native app stuck on the default theme +
// intro while the browser showed the real config). On every (re)connect, pull
// the current server rev: if it's ahead of ours, run the same coalesced hydrate
// the live broadcast would have; if we never completed the initial hydrate at
// all, force one now that the backend is clearly answering. No-op when in sync.
async function reconcileSettingsAfterReconnect() {
  try {
    const res = await fetch('/settings', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    const serverRev = (data && data.settings && Number.isFinite(data.settings.rev)) ? data.settings.rev : 0;
    const localRev = (hubSettings && Number.isFinite(hubSettings.rev)) ? hubSettings.rev : 0;
    // Only act when the server is genuinely ahead of us — that IS the missed
    // broadcast. Route it through the same coalesced path the live SSE `settings`
    // event uses; never a second direct hydrate here, which could run
    // concurrently with the boot-time hydrate (no in-flight guard) and double the
    // pager rebuild. If we never completed the initial hydrate at all, that isn't
    // this function's job: the boot hydrate's own 4s retry loop
    // (scheduleHubHydrateRetry) is already handling it, and a fresh surface with
    // no local settings has rev 0 < the server's, so it lands here anyway.
    if (serverRev > localRev) _onServerSettingsRev(serverRev);
  } catch { /* transient — the next reconnect's onopen will try again */ }
}

function _runSettingsSseHydrate() {
  _settingsSseTimer = null;
  const localRev = (hubSettings && Number.isFinite(hubSettings.rev)) ? hubSettings.rev : 0;
  if (_settingsSsePendingRev <= localRev) { _settingsSsePendingRev = 0; return; }
  if (settingsServerSaveTimer || _settingsSseHydrating) {
    // Defer, don't drop: our own pending save may still be OLDER than the
    // broadcast rev (the server bumps past it), so re-check shortly.
    _settingsSseTimer = setTimeout(_runSettingsSseHydrate, 400);
    return;
  }
  // Never hydrate while the layout editor is open: hydrate ends in
  // applyDashboardLayout(), whose grid.update() on a tile the user is actively
  // dragging/resizing kills the gesture and snaps the geometry back to the
  // last-saved state (the "my resize didn't stick" bug — typical when another
  // surface, e.g. the Xeneon screen, saves in the background). Deferred, not
  // dropped: it re-checks and lands as soon as the editor closes.
  if (typeof document !== 'undefined' && document.body
      && document.body.classList.contains('layout-editing')) {
    _settingsSseTimer = setTimeout(_runSettingsSseHydrate, 1000);
    return;
  }
  _settingsSseHydrating = true;
  Promise.resolve(hydrateHubSettingsFromServer())
    .catch(() => {})
    .finally(() => {
      _settingsSseHydrating = false;
      // A newer rev may have arrived mid-hydrate — re-check instead of dropping it.
      if (!_settingsSseTimer) _settingsSseTimer = setTimeout(_runSettingsSseHydrate, 400);
    });
}
