'use strict';

async function fetchWeather() {
  if (fetchingWeather) return;
  fetchingWeather = true;
  try {
    const params = new URLSearchParams({ lang });
    // The light pages (layer-lite.html, scene.html) carry no settings.js: the
    // server already normalized the block they read, so its city still counts.
    const weatherSettings = typeof normalizeWeatherSettings === 'function'
      ? normalizeWeatherSettings(hubSettings && hubSettings.weather)
      : ((hubSettings && hubSettings.weather) || {});
    if (weatherSettings.mode === 'manual' && weatherSettings.city) {
      params.set('mode', 'manual');
      params.set('city', weatherSettings.city);
    } else {
      params.set('mode', 'auto');
    }
    // The deadline is load-bearing, not a nicety — see fetchWithDeadline in
    // utils.js for what a hung request does to a flag-guarded poller. This is
    // the tile it was reported on.
    const res = await fetchWithDeadline(`${SERVER}/weather?${params.toString()}`, WEATHER_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error('Weather unavailable');
    applyWeather(await res.json());
  } catch {
    fetchingWeather = false;   // the window reads it: a failed request is no longer "loading"
    // A request that did not arrive says nothing about the weather, so the last
    // reading is kept and marked stale rather than blanked — the tile stays
    // useful across a hiccup, and the modal shows how old it is. Only when there
    // is nothing recent to fall back on does the failure state render. A server
    // that ANSWERS ok:false is different and is not routed here: it has already
    // bridged to its own cache, so its reason is what the user needs to see.
    //
    // The failure path RENDERS, unlike the other fetchers' empty catches, so it
    // can throw in turn (a missing pill node, a widget relay). Left unguarded
    // that second throw escapes the function and `fetchingWeather` never clears,
    // with the same permanent effect as the hang above. Both halves matter —
    // the inner catch, and the finally.
    try { applyWeather(weatherStaleFallback()); } catch { /* nothing renderable on this surface */ }
  } finally {
    fetchingWeather = false;
  }
}

async function fetchSystem() {
  if (fetchingSystem) return;
  fetchingSystem = true;
  try {
    const res = await fetchWithDeadline(SERVER + '/system', POLL_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error('System unavailable');
    const data = await res.json();
    applySystem(data);
    // The answer at boot usually beats the feed's first event: the splash has its data.
    if (window.BootSplash) window.BootSplash.ready('data');
  } catch { } finally {
    // In a `finally`, and behind a deadline: this is the SSE fallback poller, so
    // one hung request would strand the dashboard on the path that exists
    // precisely because the live stream is already unavailable.
    fetchingSystem = false;
  }
}
