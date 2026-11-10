'use strict';

// The Ambient scene outside the dashboard: behind the desktop icons (an
// animated wallpaper) and full screen after the PC sits idle (a screensaver).
// Both are windows of the native shell (apps/native/src-tauri/src/layers),
// asked for in the same sync as the widget layers (js/layers-shell.js); this
// decides which ones exist right now. Pure, so the rules are tested alone.
//
// Screens: each screen's own scene once one is picked for it (`ambientMode.byScreen`,
// per kind). Before that, the ones the person chose (`ambientMode.screens`). With none chosen,
// or none of them plugged in, like Bit's edge glow on `auto` (js/ai-edge-glow.js):
// every screen but the one the dashboard is on, which has its own Ambient; all of
// them when there is no dashboard ("widgets only") or it is the only screen.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ScreenSceneModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const SAVER_MINUTES = Object.freeze([0, 5, 10, 15, 30, 60]);
  const KINDS = Object.freeze(['wallpaper', 'saver', 'preview']);
  // The same printable rule as the shell's key check (layers/spec.rs).
  const MONITOR_RE = /^[\x20-\x7e]{0,64}$/;

  const ON_SCREEN = Object.freeze(['wallpaper', 'saver']);

  // `byScreen`: what each screen shows, { <monitor>: { wallpaper, saver } }, a scene
  // id or '' for nothing. Normalized with the settings (normalizeAmbientMode); read
  // defensively here, it is also handed raw settings.
  function byScreenOf(value) {
    const out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [key, entry] of Object.entries(value)) {
      if (!key || !MONITOR_RE.test(key) || !entry || typeof entry !== 'object') continue;
      out[key] = Object.fromEntries(ON_SCREEN.map((k) => [k, typeof entry[k] === 'string' ? entry[k] : '']));
    }
    return out;
  }

  function settingsOf(s) {
    const a = (s && s.ambientMode) || {};
    return {
      on: a.enabled !== false,
      sceneId: typeof a.sceneId === 'string' && a.sceneId ? a.sceneId : 'builtin',
      wallpaper: a.wallpaper === true,
      saverMinutes: SAVER_MINUTES.includes(Number(a.saverMinutes)) ? Number(a.saverMinutes) : 0,
      screens: Array.isArray(a.screens) ? a.screens.map(String) : [],
      byScreen: byScreenOf(a.byScreen),
    };
  }

  const MAX_SCREENS = 8;
  function normalizeScreens(value) {
    return Array.isArray(value) ? [...new Set(value.filter((id) => typeof id === 'string' && id && MONITOR_RE.test(id)))].slice(0, MAX_SCREENS) : [];
  }

  // For normalizeAmbientMode on the client and the server: only real scene ids
  // stay (`isScene`), and a screen that shows nothing is left out.
  function normalizeByScreen(value, isScene) {
    const out = {};
    for (const [key, entry] of Object.entries(byScreenOf(value))) {
      if (Object.keys(out).length >= MAX_SCREENS) break;
      const kept = Object.fromEntries(ON_SCREEN.map((k) => [k, isScene(entry[k]) ? entry[k] : '']));
      if (ON_SCREEN.some((k) => kept[k])) out[key] = kept;
    }
    return out;
  }

  // A screen picked its own scene for this kind: from then on each screen says what
  // it shows. Before that, the one Ambient scene goes on `screens` (or `auto`).
  const perScreen = (cfg, kind) => Object.values(cfg.byScreen).some((e) => e[kind]);

  const idsOf = (displays) => (Array.isArray(displays) ? displays : [])
    .map((d) => String((d && d.id) || ''))
    .filter((id) => id && MONITOR_RE.test(id));

  function screensFor(displays, active, noDashboard, chosen) {
    const ids = idsOf(displays);
    const picked = ids.filter((id) => (chosen || []).includes(id));
    if (picked.length) return picked;
    if (noDashboard) return ids;
    const others = ids.filter((id) => id !== active);
    return others.length ? others : ids;
  }

  // `status`: the last full status payload ({ gaming, idleSec }), or null.
  // A game closes both: the wallpaper gives its memory back while nobody sees
  // the desktop, and a screensaver never sits over a game.
  function saverDue(cfg, status) {
    if (!cfg.saverMinutes || !status || status.gaming) return false;
    const idle = Number(status.idleSec);
    return status.idleSec != null && Number.isFinite(idle) && idle >= cfg.saverMinutes * 60;
  }

  // What every screen is set to show, in the shell's order, whether or not the
  // wallpaper is paused or the screensaver due: { key, dashboard, wallpaper, saver }.
  // The dashboard's screen has its own Ambient, so it takes a scene of its own only
  // when it is the only screen.
  // ctx: { settings, displays, active, noDashboard }
  function plan(ctx) {
    const c = ctx || {};
    const cfg = settingsOf(c.settings);
    const ids = idsOf(c.displays);
    const active = String(c.active || '');
    const dash = !c.noDashboard && ids.includes(active) ? active : '';
    const auto = screensFor(c.displays, active, !!c.noDashboard, cfg.screens);
    const own = (id) => id !== dash || ids.length === 1;
    const pick = (id, kind) => {
      if (!perScreen(cfg, kind)) return auto.includes(id) ? cfg.sceneId : '';
      return own(id) && cfg.byScreen[id] ? cfg.byScreen[id][kind] : '';
    };
    return ids.map((id) => ({ key: id, dashboard: id === dash, wallpaper: pick(id, 'wallpaper'), saver: pick(id, 'saver') }));
  }

  // The scene a wallpaper or screensaver window shows on its monitor.
  function sceneFor(settings, kind, monitor) {
    const cfg = settingsOf(settings);
    if (!ON_SCREEN.includes(kind) || !perScreen(cfg, kind)) return cfg.sceneId;
    const entry = cfg.byScreen[String(monitor || '')];
    return (entry && entry[kind]) || cfg.sceneId;
  }

  // ctx: { settings, displays, active, noDashboard, status }
  function surfaces(ctx) {
    const c = ctx || {};
    const cfg = settingsOf(c.settings);
    if (!cfg.on) return [];
    const rows = plan(c);
    const out = [];
    const gaming = !!(c.status && c.status.gaming);
    if (cfg.wallpaper && !gaming) for (const r of rows) if (r.wallpaper) out.push({ key: 'wallpaper:' + r.key, kind: 'wallpaper', monitor: r.key });
    if (saverDue(cfg, c.status)) for (const r of rows) if (r.saver) out.push({ key: 'saver:' + r.key, kind: 'saver', monitor: r.key });
    return out;
  }

  // Whether the server must read the PC's idle time for the screensaver.
  function wantsIdle(settings) {
    const cfg = settingsOf(settings);
    return cfg.on && cfg.saverMinutes > 0;
  }

  // A surface key of this file's, as /scene accepts it.
  function isSceneKey(key) {
    if (typeof key !== 'string') return false;
    const i = key.indexOf(':');
    return i > 0 && i < key.length - 1 && KINDS.includes(key.slice(0, i)) && MONITOR_RE.test(key.slice(i + 1));
  }

  // The readings the scene page has to fetch for itself (js/screen-scene.js);
  // media, system and audio arrive on the stream anyway. `scene` is what
  // resolveAmbientScene picked (js/ambient-resolve.js). A Store scene gets the
  // weather its permission lets it read: only the dashboard polls it.
  const CANVAS_READINGS = Object.freeze({ weather: 'weather', agenda: 'calendar', tasks: 'tasks', notes: 'notes', network: 'network' });
  function readingsFor(scene, lockWidgets) {
    const out = new Set();
    if (!scene) return out;
    if (scene.canvas) {
      const comps = (scene.scene && Array.isArray(scene.scene.components)) ? scene.scene.components : [];
      for (const c of comps) {
        const r = c && Object.prototype.hasOwnProperty.call(CANVAS_READINGS, c.type) ? CANVAS_READINGS[c.type] : '';
        if (r) out.add(r);
      }
    } else if (scene.pkg) {
      out.add('weather');
    } else {
      const lw = lockWidgets || {};
      if (lw.weather !== false) out.add('weather');
      if (lw.calendar !== false) out.add('calendar');
    }
    return out;
  }

  return Object.freeze({ SAVER_MINUTES, ON_SCREEN, normalizeScreens, normalizeByScreen, surfaces, plan, sceneFor, perScreen, screensFor, saverDue, wantsIdle, isSceneKey, settingsOf, readingsFor });
});
