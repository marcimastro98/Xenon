'use strict';

// What each pump screen shows and when: the face it shows normally, the moments that
// change it by themselves ("when I play, the game face"), the alerts that come over it,
// what the pump's lights follow, and how the screen is mounted. One owner for the
// rules: the server's store (require), the menu, Bit, the Deck and the tests.
//
//   { v: 1, screens: { pump: { base, moments: [{ when, show }], alerts, leds, look } },
//     seen: { pump: { shape, w, h, via } } }
//
// A screen nobody set up yet shows the 'game' setup, so a pump is never blank.
((root, factory) => {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PumpModel = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const inNode = typeof module !== 'undefined' && module.exports && typeof require === 'function';
  const Faces = inNode ? require('./pump-faces.js') : globalThis.PumpFaces;
  const When = inNode ? require('../layers/layer-when.js') : globalThis.LayerWhen;

  const VERSION = 1;
  const SHAPES = Object.freeze(['round', 'square', 'wide']);
  // How the screen reaches Xenon: iCUE's widget, NZXT CAM's web page, a screen
  // Windows sees as a monitor, or a plain browser tab (a test, or a screen we do not know).
  const VIAS = Object.freeze(['icue', 'cam', 'monitor', 'browser']);
  const MAX_SCREENS = 8;
  const MAX_MOMENTS = 6;
  const ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
  const NAME_MAX = 32;
  const ALERTS = Object.freeze(['notify', 'call', 'timer', 'discord', 'hot']);
  const ALERT_SECONDS = Object.freeze([4, 8, 15, 30]);
  const LED_FOLLOW = Object.freeze(['screen', 'theme', 'lights', 'off']);
  const ROTATIONS = Object.freeze([0, 90, 180, 270]);
  const DIM_MIN = 10;
  const SIZE_MIN = 64;
  const SIZE_MAX = 4096;
  const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
  // The order a new moment takes among the others: a call beats a game, a game beats
  // music, a span of hours comes last. The person can still reorder them.
  const RANK = Object.freeze(['call', 'game', 'live', 'recording', 'music', 'app', 'appOpen', 'timer', 'dnd', 'busy', 'idle', 'battery', 'time']);

  const pick = (value, list, fallback) => (list.includes(value) ? value : fallback);
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const intIn = (v, lo, hi, fallback) => (Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : fallback);

  // "Pump 2" -> "pump-2": the name typed in iCUE's widget settings, made an id.
  function screenId(raw) {
    const id = String(raw == null ? '' : raw).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+/, '').slice(0, 24);
    return ID_RE.test(id) ? id : '';
  }

  function normalizeMoment(raw) {
    const r = obj(raw);
    const when = When.normalize(r.when);
    const show = Faces.normalizeFace(r.show);
    return when && !when.hide && show ? { when, show } : null;
  }

  const rankOf = (m) => Math.min(...m.when.any.map((r) => (RANK.indexOf(r.c) + 1) || RANK.length));

  // Where a new moment goes: before the first one that ranks after it.
  function insertMoment(moments, moment) {
    const at = moments.findIndex((m) => rankOf(m) > rankOf(moment));
    return at < 0 ? [...moments, moment] : [...moments.slice(0, at), moment, ...moments.slice(at)];
  }

  function normalizeAlerts(raw) {
    const r = obj(raw);
    const out = {};
    for (const k of ALERTS) out[k] = r[k] !== false;
    out.seconds = pick(Number(r.seconds), ALERT_SECONDS, 8);
    // The pump is often on camera: what a notification says stays off it unless asked.
    out.hideText = r.hideText !== false;
    return out;
  }

  function normalizeNight(raw) {
    const r = obj(raw);
    if (!HHMM_RE.test(String(r.from || '')) || !HHMM_RE.test(String(r.to || '')) || r.from === r.to) return null;
    return { from: r.from, to: r.to, dim: intIn(r.dim, DIM_MIN, 100, 30) };
  }

  function normalizeLook(raw) {
    const r = obj(raw);
    return {
      rotate: pick(Number(r.rotate), ROTATIONS, 0),
      dim: intIn(r.dim, DIM_MIN, 100, 100),
      night: normalizeNight(r.night),
      fade: r.fade !== false,
    };
  }

  // pulse: the ring breathes with the sound the PC plays (lights/pump-ring.js); turning it on is the consent to read it.
  const normalizeLeds = (raw) => ({ follow: pick(obj(raw).follow, LED_FOLLOW, 'screen'), all: obj(raw).all === true, pulse: obj(raw).pulse === true });

  function normalizeMoments(raw) {
    const out = [];
    const seen = new Set();
    for (const m of Array.isArray(raw) ? raw : []) {
      const moment = normalizeMoment(m);
      const key = moment && When.format(moment.when);
      if (!moment || seen.has(key)) continue;
      seen.add(key);
      out.push(moment);
      if (out.length >= MAX_MOMENTS) break;
    }
    return out;
  }

  function normalizeScreen(raw) {
    const r = obj(raw);
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, NAME_MAX) : '';
    return {
      ...(name ? { name } : {}),
      base: Faces.normalizeFace(r.base) || Faces.defaultFace('sensors'),
      moments: normalizeMoments(r.moments),
      alerts: normalizeAlerts(r.alerts),
      leds: normalizeLeds(r.leds),
      look: normalizeLook(r.look),
    };
  }

  function normalizeSeen(raw) {
    const r = obj(raw);
    return {
      shape: pick(r.shape, SHAPES, 'round'),
      w: intIn(r.w, SIZE_MIN, SIZE_MAX, 480),
      h: intIn(r.h, SIZE_MIN, SIZE_MAX, 480),
      via: pick(r.via, VIAS, 'browser'),
    };
  }

  // Keeps the first MAX_SCREENS valid ids of `raw`, each shaped by `shape`.
  function cleanMap(raw, shape) {
    const out = {};
    for (const [key, value] of Object.entries(obj(raw))) {
      if (Object.keys(out).length >= MAX_SCREENS) break;
      if (screenId(key) === key) out[key] = shape(value);
    }
    return out;
  }

  function normalize(raw) {
    const r = obj(raw);
    return { v: VERSION, screens: cleanMap(r.screens, normalizeScreen), seen: cleanMap(r.seen, normalizeSeen) };
  }

  const moment = (c, show) => ({ when: { any: [{ c }] }, show });
  const GAME = Object.freeze({ face: 'game' });

  // The one-tap setups: each fills the face, the moments and the lights at once.
  const SETUPS = Object.freeze({
    game: () => ({ base: { face: 'sensors', style: 'rings' }, moments: [moment('game', GAME), moment('music', { face: 'music', style: 'cover' })] }),
    music: () => ({ base: { face: 'clock', style: 'digital' }, moments: [moment('game', GAME), moment('music', { face: 'music', style: 'vinyl' })] }),
    picture: () => ({ base: { face: 'picture', items: ['art:aurora'] }, moments: [moment('game', GAME), moment('music', { face: 'music', style: 'pulse' })] }),
    clock: () => ({ base: { face: 'clock', style: 'analog' }, moments: [moment('game', GAME)] }),
    monitor: () => ({ base: { face: 'sensors', style: 'bars', readings: ['cpu', 'cpuTemp', 'gpu', 'gpuTemp'] }, moments: [moment('game', GAME)] }),
  });
  const SETUP_NAMES = Object.freeze(Object.keys(SETUPS));
  const DEFAULT_SETUP = 'game';

  // A setup over a screen: the mounting, the name and the alerts the person chose stay.
  function withSetup(screen, name) {
    const make = SETUPS[name];
    if (!make) return null;
    const cur = screen ? normalizeScreen(screen) : null;
    return normalizeScreen({ ...(cur || {}), ...make(), leds: { ...(cur ? cur.leds : {}), follow: 'screen' } });
  }

  // What a screen shows: its own setup, or the default one until the person picks.
  function screenFor(model, id) {
    const m = normalize(model);
    return m.screens[id] || withSetup(null, DEFAULT_SETUP);
  }

  return Object.freeze({
    VERSION, SHAPES, VIAS, MAX_SCREENS, MAX_MOMENTS, ALERTS, ALERT_SECONDS, LED_FOLLOW, ROTATIONS, SETUP_NAMES,
    DEFAULT_SETUP, screenId, normalize, normalizeScreen, normalizeMoment, normalizeSeen, insertMoment, withSetup, screenFor,
  });
});
