'use strict';
// What a Voicemeeter action may name and set: the editions with their strips and buses, the
// parameter names that are safe to send, the range of a gain, and where the Voicemeeter library
// is looked for.

// ── Editions ────────────────────────────────────────────────────────────────
// VBVMR_GetVoicemeeterType: 1 = Voicemeeter, 2 = Banana, 3 = Potato.
// The counts are the mixer's own: `strips` includes the virtual inputs, `buses`
// the physical (A) and virtual (B) outputs, in that order.
const EDITIONS = Object.freeze({
  1: Object.freeze({ id: 1, name: 'Voicemeeter', strips: 3, buses: 2, physical: 1, virtual: 1 }),
  2: Object.freeze({ id: 2, name: 'Voicemeeter Banana', strips: 5, buses: 5, physical: 3, virtual: 2 }),
  3: Object.freeze({ id: 3, name: 'Voicemeeter Potato', strips: 8, buses: 8, physical: 5, virtual: 3 }),
});

/** The edition record for a VBVMR type code, or null for anything else. */
function editionFor(type) {
  return EDITIONS[Number(type)] || null;
}

/**
 * The bus LABELS an edition has, in mixer order: the physical outs (A1…) then
 * the virtual ones (B1…). These are the words on the buttons in Voicemeeter,
 * and they are also what a Deck key stores — an index would silently point at a
 * different bus the day somebody moves from Banana to Potato.
 */
function busLabels(type) {
  const ed = editionFor(type);
  if (!ed) return [];
  const out = [];
  for (let i = 1; i <= ed.physical; i++) out.push('A' + i);
  for (let i = 1; i <= ed.virtual; i++) out.push('B' + i);
  return out;
}

/**
 * Label → Bus[n] index for the running edition, or -1.
 * The mapping is positional, and that is exactly why it cannot be hardcoded:
 * B1 is Bus[1] on Voicemeeter, Bus[3] on Banana and Bus[5] on Potato.
 */
function busIndex(label, type) {
  const list = busLabels(type);
  const want = String(label == null ? '' : label).trim().toUpperCase();
  return list.indexOf(want);
}

/** Strip indexes an edition actually has. Used to refuse a write to nowhere. */
function stripCount(type) {
  const ed = editionFor(type);
  return ed ? ed.strips : 0;
}

// Voicemeeter's own fader range. Values outside it are accepted by the DLL and
// clamped invisibly, so they are clamped HERE instead — a key that stores 40
// should read back as the +12 it will actually produce.
const GAIN_MIN = -60;
const GAIN_MAX = 12;

function clampGain(db) {
  const n = Number(db);
  if (!Number.isFinite(n)) return null;
  // Away from zero rather than JS's half-up, which rounds -6.25 to -6.2 and
  // +6.25 to +6.3 — a fader that behaves differently either side of unity.
  const one = Math.sign(n) * Math.round(Math.abs(n) * 10) / 10;
  return Math.max(GAIN_MIN, Math.min(GAIN_MAX, one));
}

// A parameter name is a string handed to a DLL, so it is validated rather than
// trusted: Strip[i].Field, Bus[i].Field, or one of the flat namespaces
// (Command.Restart, Option.sr, Recorder.play, Patch.…). Two dotted segments are
// allowed because a few real names have them (Strip[0].EQ.on, Recorder.mode.loop).
// Strip and Bus are always indexed ("Strip.Mute" addresses nothing); the flat
// namespaces never are. Keeping the two shapes apart is what stops a typo from
// becoming a silent write.
const PARAM_INDEXED_RE = /^(?:Strip|Bus|Patch)\[\d{1,2}\](?:\.[A-Za-z][A-Za-z0-9_]{0,23}){1,3}$/;
const PARAM_FLAT_RE = /^(?:Option|Command|Recorder|Vban|FadeTo)(?:\.[A-Za-z][A-Za-z0-9_]{0,23}){1,3}$/;

function isSafeParam(name) {
  const v = String(name == null ? '' : name).trim();
  if (!v || v.length > 64) return false;
  return PARAM_INDEXED_RE.test(v) || PARAM_FLAT_RE.test(v);
}

/** Strip[3].A1 and friends, built rather than concatenated at the call site. */
function paramName(kind, index, field) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i > 15) return '';
  const f = String(field == null ? '' : field).trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(f)) return '';
  const k = kind === 'bus' ? 'Bus' : kind === 'strip' ? 'Strip' : '';
  if (!k) return '';
  return k + '[' + i + '].' + f;
}

/**
 * What a mute/route mode does to a value that is currently `cur`.
 * 'toggle' is the interesting one: it needs a READ first, which is the only
 * reason any of this is asynchronous.
 */
function nextFlag(mode, cur) {
  if (mode === 'on') return 1;
  if (mode === 'off') return 0;
  return Number(cur) > 0.5 ? 0 : 1;      // toggle
}

/** Gain modes: an absolute set, or a relative nudge off the current value. */
function nextGain(mode, cur, value) {
  const v = Number(value);
  if (mode === 'set') return clampGain(v);
  const step = Number.isFinite(v) && v !== 0 ? Math.abs(v) : 3;
  const base = Number.isFinite(Number(cur)) ? Number(cur) : 0;
  return clampGain(mode === 'down' ? base - step : base + step);
}

// ── The DLL ─────────────────────────────────────────────────────────────────
// Installed by Voicemeeter itself; the path is published in the registry, but
// the install location has been the same for every version and reading the
// registry would mean spawning reg.exe on a hot path. The env override exists
// for portable installs and for tests.
const DLL_NAME = 'VoicemeeterRemote64.dll';

function dllCandidates() {
  return [
    process.env.VOICEMEETER_DLL,
    'C:\\Program Files (x86)\\VB\\Voicemeeter\\' + DLL_NAME,
    'C:\\Program Files\\VB\\Voicemeeter\\' + DLL_NAME,
  ].filter(Boolean);
}

module.exports = {
  EDITIONS, editionFor, busLabels, busIndex, stripCount, GAIN_MIN, GAIN_MAX, clampGain,
  PARAM_INDEXED_RE, PARAM_FLAT_RE, isSafeParam, paramName, nextFlag, nextGain, DLL_NAME,
  dllCandidates,
};
