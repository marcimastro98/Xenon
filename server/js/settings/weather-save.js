// Sends the weather settings to the engine through a save of their own, with retries.
'use strict';

// ── weather config: its OWN save channel, not the whole-settings blob ────────
// Weather (location/mode/provider/tile prefs) is edited from Settings on any
// surface, but the whole-blob transport is shared with high-frequency automatic
// saves (a Vitals/Bit heartbeat) and the unload beacon. A blob push from a
// surface that still holds the OLD location would clobber a change just made
// here via last-writer-wins — the empirically-reported "XENON stays on the wrong
// weather location, browser only fixes on Ctrl+R" bug (GitHub #109). So weather
// is persisted like the stocks watchlist / news feeds: a dedicated endpoint the
// server treats as the sole writer (POST /settings keeps prev.weather). The
// server bumps rev + broadcasts, so peer surfaces re-hydrate and refetch (#72).
let weatherConfigSaveTimer = null;
let _weatherConfigSaveToken = 0;
let _weatherConfigSavePending = false;  // a change made before the first hydrate
// True from the moment a weather change is committed on THIS surface until the
// server acknowledges it. Weather is server-owned (POST /api/weather/config is
// its sole writer; the whole-blob POST /settings keeps the stored copy —
// server.js keep-prev guard, GitHub #109), so a hydrate adopts the SERVER's
// weather as authoritative — EXCEPT while this flag is set, when an as-yet-
// unacknowledged local edit must not be clobbered by the copy we just fetched
// (the app-vs-browser location divergence / "reverts to auto on restart"
// follow-up of GitHub #88).
let _weatherConfigDirty = false;
// The rev MUST travel with the weather block, exactly like the whole-blob save
// sends its own. commitWeatherChange() bumps the local rev on every keystroke in
// the city field while only the last one survives the 250ms debounce, so a server
// that re-derived the rev from its own stored copy (prevRev + 1) would fall
// several revisions BEHIND this surface. That gap is not cosmetic: a lower server
// rev makes _runSettingsSseHydrate() skip every incoming broadcast, and makes the
// boot hydrate treat the local copy as newer and ignore the server's — so this
// surface stops adopting a location set on another one (the "browser keeps auto
// location" residual of GitHub #109).
function weatherConfigPayload() {
  return {
    weather: normalizeWeatherSettings(hubSettings && hubSettings.weather),
    rev: Number.isFinite(hubSettings && hubSettings.rev) ? hubSettings.rev : 0,
  };
}
function postWeatherConfigToServer() {
  return fetch('/api/weather/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(weatherConfigPayload()),
  }).then(async (res) => {
    // Read (not just drain) the slim { ok, weather, rev } ack so we can adopt the
    // server-assigned rev. nextSettingsRev() always returns a rev strictly
    // greater than the stored one, so after our save the server sits ABOVE this
    // surface's local rev. Left unread, that gap makes our own later broadcasts
    // look "already held" and, at the next boot, can flip this surface to
    // localNewer and resurrect a stale location — the divergence this fix closes.
    // json() consumes the body either way (an unread body would pin the socket).
    let ack = null;
    try { ack = await res.json(); } catch { /* empty/non-JSON body — nothing to adopt */ }
    if (!res.ok) { const e = new Error('weather save failed: HTTP ' + res.status); e.status = res.status; throw e; }
    return ack;
  });
}
// Adopt the server's ack after a weather save: raise this surface's rev to the
// server's (never lower it — a newer local edit may have raced) and mirror the
// server-normalized weather block. Local-only (saveLocalHubSettings): the server
// already holds this exact state, so it must NOT trigger another save.
function _adoptWeatherConfigAck(ack) {
  if (!ack || typeof ack !== 'object') return;
  const serverRev = Number.isFinite(ack.rev) ? ack.rev : 0;
  const localRev = Number.isFinite(hubSettings && hubSettings.rev) ? hubSettings.rev : 0;
  const nextRev = Math.max(localRev, serverRev);
  const curWeather = hubSettings && hubSettings.weather;
  const nextWeather = (ack.weather && typeof ack.weather === 'object') ? ack.weather : curWeather;
  if (nextRev === localRev && nextWeather === curWeather) return;
  hubSettings = normalizeSettings({ ...hubSettings, weather: nextWeather, rev: nextRev });
  saveLocalHubSettings();
}
function _postWeatherConfigWithRetry(token, attempt) {
  if (token !== _weatherConfigSaveToken) return;               // superseded by a newer save
  postWeatherConfigToServer().then((ack) => {
    if (token !== _weatherConfigSaveToken) return;             // a newer save is pending → stay dirty
    _weatherConfigDirty = false;                               // server now holds our latest weather
    _adoptWeatherConfigAck(ack);                               // keep our rev in step with the server's
  }).catch((err) => {
    if (token !== _weatherConfigSaveToken) return;
    if (!_settingsSaveRetryable(err)) {                         // permanent client error → stop
      console.error('weather: server rejected the save and won\'t accept it, giving up', err);
      return;
    }
    setTimeout(() => _postWeatherConfigWithRetry(token, attempt + 1), Math.min(800 * Math.pow(2, attempt), 10000));
  });
}
function queueWeatherConfigServerSave() {
  clearTimeout(weatherConfigSaveTimer);
  const token = ++_weatherConfigSaveToken;
  weatherConfigSaveTimer = setTimeout(() => {
    weatherConfigSaveTimer = null;
    _postWeatherConfigWithRetry(token, 0);
  }, 250);
}

// Persist a weather-block change: bump rev + mirror locally (so this surface
// shows it at once), exactly like saveHubSettings — but push ONLY the weather
// block through its dedicated endpoint instead of the whole-settings blob. Every
// weather control calls this in place of saveHubSettings(); see the note above.
function commitWeatherChange() {
  const cur = Number.isFinite(hubSettings && hubSettings.rev) ? hubSettings.rev : 0;
  hubSettings = normalizeSettings({ ...hubSettings, rev: cur + 1 });
  saveLocalHubSettings();
  _weatherConfigDirty = true;              // unacknowledged local edit until the server confirms
  if (_hubHydratedFromServer) queueWeatherConfigServerSave();
  else _weatherConfigSavePending = true;   // flushed right after the first hydrate
}
