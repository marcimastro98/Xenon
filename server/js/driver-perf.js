'use strict';

// Performance Mode in "widgets only" (js/shell-driver.js). On the dashboard,
// js/performance.js watches the activity, suggests optimizing, runs the
// session and ends it when its game is gone. With no dashboard none of that
// ran: a session started earlier kept the power plan on High for good, and the
// suggestion never came. The hidden driver page is the only owner while there
// is no dashboard, so it runs the same file, loaded only once Performance Mode
// is on (it is off by default) or a session is running.
//
// What the dashboard draws goes to the on-screen alerts window instead
// (window.PerfModeSurface -> POST /api/performance/screen -> SSE perf_screen,
// js/screen-alerts.js), and the choices come back the same way. Its saves are
// the `performance` block only (POST /api/performance/state): this page has no
// settings.js and never writes anything else.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DriverPerf = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const SCRIPTS = Object.freeze(['js/perf-settings.js', 'js/performance.js']);
  const SCREEN_PATH = '/api/performance/screen';
  const STATE_PATH = '/api/performance/state';
  // What the user set, as opposed to what a session writes while it runs: a
  // change here starts the suggestion over (PerfMode.refresh), as on the dashboard.
  const CONFIG_KEYS = Object.freeze(['enabled', 'autoSuggest', 'autoMode', 'autoActivities', 'activityApps', 'opts']);

  function perfOf(settings) {
    const p = settings && typeof settings === 'object' ? settings.performance : null;
    return p && typeof p === 'object' ? p : null;
  }

  function wanted(settings) {
    const p = perfOf(settings);
    return !!(p && (p.enabled === true || p.active === true));
  }

  function configKey(settings) {
    const p = perfOf(settings) || {};
    return JSON.stringify(CONFIG_KEYS.map((k) => (p[k] === undefined ? null : p[k])));
  }

  // env: { win, doc, post(path, body) -> Promise, read() -> the page's hubSettings }
  function create(env) {
    const { win, doc, post, read } = env;
    let loading = null;
    let config = null;
    let queued = false;
    let busy = 0;
    let saving = Promise.resolve();

    // performance.js persists a session in a few quick steps: one save at a
    // time, each sending the latest block, and none queued twice.
    function save() {
      if (queued) return;
      queued = true;
      busy++;
      saving = saving
        .then(() => { queued = false; return post(STATE_PATH, { performance: perfOf(read()) || {} }); })
        .catch(() => { /* the next save sends the whole block again */ })
        .then(() => { busy--; });
    }

    // performance.js reads these as globals, the way the dashboard's settings.js provides them.
    function installShims() {
      win.normalizeSettings = (s) => s;   // the server normalizes what it is sent
      win.saveHubSettings = save;
      win.PerfModeSurface = Object.freeze({
        suggest: (activity) => post(SCREEN_PATH, { kind: 'prompt', activity }),
        hide: () => post(SCREEN_PATH, { kind: 'prompt', activity: '' }),
        toast: (note, tone) => post(SCREEN_PATH, { kind: 'toast', note, tone }),
      });
    }

    function inject(src) {
      return new Promise((resolve, reject) => {
        const s = doc.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        doc.body.appendChild(s);
      });
    }

    function load() {
      if (win.PerfMode) return Promise.resolve();
      if (!loading) {
        installShims();
        loading = SCRIPTS.reduce((p, src) => p.then(() => inject(src)), Promise.resolve())
          .then(() => { config = configKey(read()); })
          .catch((e) => { loading = null; throw e; });
      }
      return loading;
    }

    // A fresh copy of the settings, while a save of ours is still on its way,
    // keeps our block: it is newer than what the server had.
    function merge(next) {
      const mine = perfOf(read());
      return busy > 0 && mine && next && typeof next === 'object' ? { ...next, performance: mine } : next;
    }

    // After every settings read (shell-driver.js refresh).
    function sync(settings) {
      if (!win.PerfMode) {
        if (wanted(settings)) load().catch(() => { /* tried again on the next settings read */ });
        return;
      }
      const key = configKey(settings);
      if (key !== config) { config = key; win.PerfMode.refresh(); } else win.PerfMode.applyState();
    }

    const parse = (e) => { try { return JSON.parse(e.data); } catch (err) { return null; } };

    function onStatus(e) {
      const d = parse(e);
      // Only a full payload says whether a game runs (see main.js).
      if (!d || !win.PerfMode || (d.gaming == null && d.gameRunning == null)) return;
      win.PerfMode.onStatus(d.activity, d.process, d.gameRunning === true);
    }

    function onObs(e) {
      const d = parse(e);
      if (d && win.PerfMode) win.PerfMode.onObs(d);
    }

    // The card's buttons, and Bit ("optimize the PC"): loaded on demand, since
    // optimizing by hand works with the suggestion off, as on the dashboard.
    function onScreen(e) {
      const d = parse(e);
      if (!d || d.kind !== 'answer') return;
      load().then(() => win.PerfMode.answer(d.choice)).catch(() => { /* nothing ran, nothing to undo */ });
    }

    function listen(es) {
      es.addEventListener('status', onStatus);
      es.addEventListener('obs', onObs);
      es.addEventListener('perf_screen', onScreen);
    }

    return Object.freeze({ sync, listen, merge, load, loaded: () => !!win.PerfMode });
  }

  return Object.freeze({ SCRIPTS, CONFIG_KEYS, wanted, configKey, create });
});
