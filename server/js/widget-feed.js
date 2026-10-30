'use strict';

// The live data the dashboard hands to Store widgets (main.js), for the pages
// that run widgets without it: a layer window (js/layer-lite.js) and the
// hidden widget host of "widgets only" (js/sdk-service.js). One table, so a
// stream added to the dashboard is added to both (layer-lite.test.mjs).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WidgetFeed = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Events whose payload goes to widgets unchanged, by stream name.
  const PLAIN_STREAMS = Object.freeze({
    status: 'status', media: 'media', system: 'system', battery: 'battery', processes: 'processes',
    sensors: 'sensors', audio: 'audio', discord: 'discord', homeassistant: 'homeassistant',
    script_states: 'scriptStates', wavelink: 'wavelink', voicemeeter: 'voicemeeter', stocks: 'stocks', football: 'football',
    claude: 'claude', news: 'news', tasks: 'tasks', notes: 'notes', agenda: 'agenda', obs: 'obs',
    streamerbot: 'streamerbot', perf: 'perf',
  });
  // Events with their own shape or their own entry point. Hooks and Deck
  // handlers are not here: only the page that owns the background frames
  // answers them, or two windows would run them twice.
  const SHAPED_STREAMS = Object.freeze({
    audiolevels: (cw, d) => cw.onData('audioLevels', d && d.problem
      ? { peaks: {}, problem: d.problem, minVersion: d.minVersion || '' }
      : ((d && d.peaks) || {})),
    codex: (cw, d) => { if (d && d.sdk) cw.onData('codex', d.sdk); },
    discord_notification: (cw, d) => cw.onDiscordNotification(d),
    sdk_store: (cw, d) => cw.onStoreChanged(d),
    widget_auto_updated: (cw, d) => cw.onAutoUpdated(d),
  });

  function relay(getCw, handle) {
    return (e) => {
      const cw = getCw();
      if (!cw) return;
      try { handle(cw, JSON.parse(e.data)); } catch (err) { /* one bad event never stops the stream */ }
    };
  }

  // Every relay on one stream; `getCw` is read per event (the widget code may
  // load after the stream opens).
  function listen(es, getCw) {
    for (const [event, stream] of Object.entries(PLAIN_STREAMS)) {
      es.addEventListener(event, relay(getCw, (cw, d) => cw.onData(stream, d)));
    }
    for (const [event, handle] of Object.entries(SHAPED_STREAMS)) es.addEventListener(event, relay(getCw, handle));
  }

  // The weather is client-polled on every surface (see main.js): the query the
  // dashboard sends for the same settings and language.
  function weatherQuery(settings, lang) {
    const params = new URLSearchParams({ lang });
    const w = (settings && settings.weather) || {};
    if (w.mode === 'manual' && w.city) { params.set('mode', 'manual'); params.set('city', w.city); }
    else params.set('mode', 'auto');
    return params.toString();
  }

  // On the dashboard's epoch grid, so every surface shows the same reading.
  function weatherDelay(settings, now) {
    const periodMs = Math.max(10, Number(settings && settings.weather && settings.weather.refreshMin) || 30) * 60 * 1000;
    let delay = periodMs - (now % periodMs);
    if (delay < 1000) delay += periodMs;
    return delay;
  }

  return Object.freeze({ PLAIN_STREAMS, SHAPED_STREAMS, listen, weatherQuery, weatherDelay });
});
