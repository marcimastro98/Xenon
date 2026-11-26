'use strict';
// The person's own Bit's prefs, kept inside bit.json (model.js): where it lives and how, each one checked
// as it comes in, so a file edited by hand or an old version's never breaks a surface.

const GeneTables = require('../shared/src/bit-genes.js');
const Pocket = require('./pocket.js');

// A display id as the shell gives them (printable, as layers/bit_desk.rs takes them).
const SCREEN_ID = /^[\x20-\x7e]{1,64}$/;
// Prefs that may be sent as null: back to their usual value.
const CLEARABLE = new Set(['spot', 'deskX', 'deskY']);

// Where the companion lives (off: only where the app already shows Bit), how
// often it reacts (bitDirector's hourly cap), and the classic Bit in the app.
const PLACES = Object.freeze(['corner', 'topbar', 'both', 'off']);
const REACTIONS = Object.freeze({ normal: 6, few: 2, off: 0 });
const DEFAULT_PREFS = Object.freeze({
  place: 'corner', reactions: 'normal', sounds: false, classic: false, pose: '', card: 'plain', roam: 'mix', warp: 'any', spot: null,
  desk: 'main', deskX: null, deskY: null, deskScreen: '', tap: 'pocket', keys: [], setup: false,
});
// In the corner it strolls along the bottom now and then, sometimes teleporting (mix), only on foot, or
// stays where it stands; warp: how it teleports (js/bit-companion/warp.js), 'any' a different way each
// time. setup: the person went through the guided setup (js/bit-companion/room-setup.js). spot: where
// the person dragged it, as fractions of the room the screen leaves it ({x: 0 left, y: 0 bottom}), or null for its corner.
const ROAMS = Object.freeze(['mix', 'walk', 'stay']);
const WARPS = Object.freeze(['any', 'crumble', 'beam', 'packet', 'glitch']);
// On the desktop (the shell's own window on the taskbar, layers/bit_desk.rs): on one screen, one Bit that
// travels across every screen now and then, or not at all. Where the person dropped it: deskX along the bar
// (0 left, 1 right; null its usual place), deskY how high when dropped away from the bar (0 top, 1 bottom of
// the desktop; null on the bar), deskScreen the screen (the shell's display id; '' the main one).
const DESKS = Object.freeze(['main', 'all', 'off']);
// A tap on it opens its pocket (js/bit-companion/pocket.js), the chat or its room. keys: the pocket's
// quick keys (pocket.js here), [] for the usual ones.
const TAPS = Object.freeze(['pocket', 'chat', 'room']);
// The ground of its card: plain ink, or its theatre (room-scenery.js).
const CARDS = Object.freeze(['plain', 'stage']);
// The pose its card and video end on: '' is its own (its favourite fidget, from the DNA), or one of
// the fidgets or the classic photo pose, chosen in the sheet.
const POSES = Object.freeze([...GeneTables.QUIRKS.map((q) => q.id), 'pose']);

function normalizeSpot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const ok = (n) => Number.isFinite(n) && n >= 0 && n <= 1;
  return ok(x) && ok(y) ? { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 } : null;
}

function normalizeFraction(raw) {
  const n = typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? Math.round(n * 1000) / 1000 : null;
}

function normalizePrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    place: PLACES.includes(p.place) ? p.place : DEFAULT_PREFS.place,
    reactions: Object.hasOwn(REACTIONS, p.reactions) ? p.reactions : DEFAULT_PREFS.reactions,
    sounds: p.sounds === true,
    classic: p.classic === true,
    pose: POSES.includes(p.pose) ? p.pose : '',
    card: CARDS.includes(p.card) ? p.card : DEFAULT_PREFS.card,
    roam: ROAMS.includes(p.roam) ? p.roam : DEFAULT_PREFS.roam,
    warp: WARPS.includes(p.warp) ? p.warp : DEFAULT_PREFS.warp,
    spot: normalizeSpot(p.spot),
    desk: DESKS.includes(p.desk) ? p.desk : DEFAULT_PREFS.desk,
    deskX: normalizeFraction(p.deskX),
    deskY: normalizeFraction(p.deskY),
    deskScreen: typeof p.deskScreen === 'string' && SCREEN_ID.test(p.deskScreen) ? p.deskScreen : '',
    tap: TAPS.includes(p.tap) ? p.tap : DEFAULT_PREFS.tap,
    keys: Pocket.normalizeKeys(p.keys),
    setup: p.setup === true,
  };
}

/** prev with the keys of `patch` (each one checked): { prefs } or { error }. */
function merge(prev, patch) {
  if (!patch || typeof patch !== 'object') return { error: 'bad_request' };
  const next = normalizePrefs({ ...prev, ...patch });
  for (const k of Object.keys(patch)) {
    const kept = CLEARABLE.has(k) ? patch[k] === null || next[k] !== null
      : Array.isArray(next[k]) ? JSON.stringify(next[k]) === JSON.stringify(patch[k]) : next[k] === patch[k];
    if (Object.hasOwn(DEFAULT_PREFS, k) && !kept) return { error: 'bad_value' };
  }
  return { prefs: next };
}

module.exports = { PLACES, REACTIONS, ROAMS, WARPS, DESKS, TAPS, CARDS, POSES, DEFAULT_PREFS, normalizePrefs, merge };
