'use strict';

// The readings a desktop scene draws (scene.html), kept in the globals the
// dashboard's own renderers read (js/state.js), so lockscreen.js and
// ambient-canvas.js run here unchanged. Media, system and audio come on the
// stream; the rest is fetched only while the scene on screen draws it
// (ScreenSceneModel.readingsFor), on the dashboard's own cadence.
const SceneFeed = (function () {
  const FETCH_DEADLINE_MS = 20 * 1000;
  const CALENDAR_EVERY_MS = 10 * 60 * 1000;
  const NETWORK_EVERY_MS = 3000;   // the System tile's /network poll

  let wanted = new Set();
  const timers = new Map();
  let cover = { key: '', thumb: '' };
  let opens = 0;

  async function getJson(path) {
    const res = await fetchWithDeadline(SERVER + path, FETCH_DEADLINE_MS);
    if (!res.ok) throw new Error('http ' + res.status);
    return res.json();
  }

  const READERS = {
    // system.js: the dashboard's fetch, with its stale fallback and widget relay.
    weather: { every: () => WidgetFeed.weatherDelay(hubSettings, Date.now()), run: () => fetchWeather() },
    calendar: {
      every: () => CALENDAR_EVERY_MS,
      run: async () => { const d = await getJson('/events'); calendarEvents = Array.isArray(d.events) ? d.events : []; },
    },
    network: {
      every: () => NETWORK_EVERY_MS,
      run: async () => { if (!document.hidden) lastNetworkData = await getJson('/network'); },
    },
    // Kept current by the stream after the first read.
    tasks: { run: async () => { const d = await getJson('/tasks'); tasksData = Array.isArray(d.tasks) ? d.tasks : []; } },
    notes: { run: async () => applyNotes(await getJson('/notes/list')) },
  };

  function applyNotes(d) {
    if (!d || !Array.isArray(d.notes)) return;
    notesState = { v: 1, activeId: typeof d.activeId === 'string' ? d.activeId : '', notes: d.notes };
  }

  function start(name) {
    const reader = READERS[name];
    clearTimeout(timers.get(name));
    timers.delete(name);
    const tick = async () => {
      try { await reader.run(); } catch (e) { /* the scene keeps its last reading */ }
      if (wanted.has(name) && reader.every) timers.set(name, setTimeout(tick, reader.every()));
    };
    tick();
  }

  // names: what the scene on screen draws. New ones start, gone ones stop.
  function want(names) {
    const before = wanted;
    wanted = new Set(Array.from(names || []).filter((n) => Object.prototype.hasOwnProperty.call(READERS, n)));
    for (const [name, timer] of timers) {
      if (!wanted.has(name)) { clearTimeout(timer); timers.delete(name); }
    }
    for (const name of wanted) if (!before.has(name)) start(name);
  }

  // Read again now (the weather settings or the language changed, or the
  // stream came back: it has no replay).
  function refresh(names) {
    for (const name of (names || wanted)) if (wanted.has(name)) start(name);
  }

  function parse(e) {
    try { return JSON.parse(e.data); } catch (err) { return null; }
  }

  function listen(es) {
    es.addEventListener('media', (e) => {
      const d = parse(e);
      if (!d) return;
      // The server leaves the ~80 KB cover out while the track is unchanged.
      cover = DriverAlbumLights.coverFor(cover, d);
      mediaData = cover.thumb && !d.thumbnail ? Object.assign({}, d, { thumbnail: cover.thumb }) : d;
    });
    es.addEventListener('system', (e) => { const d = parse(e); if (d) lastSystemData = d; });
    es.addEventListener('audio', (e) => {
      const d = parse(e);
      if (!d) return;
      audioData = d;
      speakerMuted = !!(d.speaker && d.speaker.muted);
    });
    es.addEventListener('tasks', (e) => {
      const d = parse(e);
      if (wanted.has('tasks') && d && Array.isArray(d.tasks)) tasksData = d.tasks;
    });
    es.addEventListener('notes', (e) => { if (wanted.has('notes')) applyNotes(parse(e)); });
    // The first open is the connection itself; the readers already ran.
    es.addEventListener('open', () => { opens += 1; if (opens > 1) refresh(); });
  }

  return Object.freeze({ want, refresh, listen });
})();
