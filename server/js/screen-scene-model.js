'use strict';

// The Ambient scene outside the dashboard: behind the desktop icons (an
// animated wallpaper) and full screen after the PC sits idle (a screensaver).
// Both are windows of the native shell (apps/native/src-tauri/src/layers),
// asked for in the same sync as the widget layers (js/layers-shell.js); this
// decides which ones exist right now. Pure, so the rules are tested alone.
//
// Screens: like Bit's edge glow on `auto` (js/ai-edge-glow.js), every screen
// but the one the dashboard is on, which has its own Ambient; all of them when
// there is no dashboard ("widgets only") or it is the only screen.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ScreenSceneModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const SAVER_MINUTES = Object.freeze([0, 5, 10, 15, 30, 60]);
  const KINDS = Object.freeze(['wallpaper', 'saver']);
  // The same printable rule as the shell's key check (layers/spec.rs).
  const MONITOR_RE = /^[\x20-\x7e]{0,64}$/;

  function settingsOf(s) {
    const a = (s && s.ambientMode) || {};
    return {
      on: a.enabled !== false,
      wallpaper: a.wallpaper === true,
      saverMinutes: SAVER_MINUTES.includes(Number(a.saverMinutes)) ? Number(a.saverMinutes) : 0,
    };
  }

  function screensFor(displays, active, noDashboard) {
    const ids = (Array.isArray(displays) ? displays : [])
      .map((d) => String((d && d.id) || ''))
      .filter((id) => id && MONITOR_RE.test(id));
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

  // ctx: { settings, displays, active, noDashboard, status }
  function surfaces(ctx) {
    const c = ctx || {};
    const cfg = settingsOf(c.settings);
    if (!cfg.on) return [];
    const screens = screensFor(c.displays, String(c.active || ''), !!c.noDashboard);
    const out = [];
    const gaming = !!(c.status && c.status.gaming);
    if (cfg.wallpaper && !gaming) for (const id of screens) out.push({ key: 'wallpaper:' + id, kind: 'wallpaper', monitor: id });
    if (saverDue(cfg, c.status)) for (const id of screens) out.push({ key: 'saver:' + id, kind: 'saver', monitor: id });
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

  return Object.freeze({ SAVER_MINUTES, surfaces, screensFor, saverDue, wantsIdle, isSceneKey, settingsOf, readingsFor });
});
