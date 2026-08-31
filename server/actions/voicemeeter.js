'use strict';
// Voicemeeter Remote API client — strips, buses and routing, straight from the
// mixer rather than through the virtual sound cards Windows sees.
//
// WHY THIS EXISTS. Voicemeeter publishes its own devices ("Voicemeeter Output",
// "Voicemeeter Aux Input", …) and Windows reports them like any other card, so
// Xenon could already pick one and set its volume. What it could not reach was
// anything INSIDE the mixer: the gain of one strip, its mute, and above all the
// A1/A2/B1/B2 routing buttons that decide where each source goes. Those are the
// controls people actually bind to a Deck key, and they exist only behind the
// Remote API. Asked for on Discord by a supporter running Potato.
//
// HOW IT TALKS. VoicemeeterRemote64.dll, loaded through koffi — the same
// mechanism lighting.js already uses for the iCUE SDK, so nothing new is being
// introduced here. The API is deliberately small: every control in the mixer is
// a NAMED PARAMETER, read and written as a float.
//
//     Strip[0].Mute = 1          Strip[3].A1 = 0        Bus[1].Gain = -6.0
//
// That is the whole model, which is why one generic action covers everything
// and the named ones are conveniences on top of it.
//
// THREE EDITIONS, THREE SIZES. Voicemeeter (3 strips, 2 buses), Banana (5, 5)
// and Potato (8, 8). The DLL reports which one is running, and every index is
// checked against THAT edition rather than against the biggest: writing
// Strip[7] on plain Voicemeeter is not an error the DLL reports, it is a write
// that goes nowhere, and a Deck key that silently does nothing is worse than
// one that says why.
//
// LOGIN IS NOT A CONNECTION. VBVMR_Login returns 0 when the mixer is already
// running and 1 when the DLL is there but Voicemeeter is NOT — a success code
// meaning "nothing to talk to". Both are treated here as "logged in", because
// the answer to 1 is to keep the session and let the next call fail cleanly;
// what must never happen is treating 1 as an error and logging in again on
// every press, which leaks a session per key.
//
// Nothing here throws out of the public surface: every entry point answers
// {ok:false, error} and the Deck reports it on the key.

const path = require('path');
const fs = require('fs');

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

function createClient(deps = {}) {
  const platform = deps.platform || process.platform;
  const exists = deps.fileExists || ((p) => { try { return fs.existsSync(p); } catch { return false; } });
  const loadKoffi = deps.loadKoffi || (() => require('koffi'));

  let lib = null, fns = null, dllPath = null;
  let loggedIn = false;
  let lastError = null;
  let cachedType = 0;

  function resolveDll() {
    for (const p of dllCandidates()) if (exists(p)) return p;
    return null;
  }

  function load() {
    if (fns) return true;
    if (platform !== 'win32') { lastError = 'voicemeeter_windows_only'; return false; }
    dllPath = resolveDll();
    if (!dllPath) { lastError = 'voicemeeter_not_installed'; return false; }
    try {
      const koffi = loadKoffi();
      lib = koffi.load(dllPath);
      fns = {
        login: lib.func('long __stdcall VBVMR_Login()'),
        logout: lib.func('long __stdcall VBVMR_Logout()'),
        getType: lib.func('long __stdcall VBVMR_GetVoicemeeterType(_Out_ long*)'),
        dirty: lib.func('long __stdcall VBVMR_IsParametersDirty()'),
        getFloat: lib.func('long __stdcall VBVMR_GetParameterFloat(const char*, _Out_ float*)'),
        setFloat: lib.func('long __stdcall VBVMR_SetParameterFloat(const char*, float)'),
        macroSet: lib.func('long __stdcall VBVMR_MacroButton_SetStatus(long, float, long)'),
        macroGet: lib.func('long __stdcall VBVMR_MacroButton_GetStatus(long, _Out_ float*, long)'),
      };
      return true;
    } catch (e) {
      lastError = 'voicemeeter_dll_failed: ' + (e && e.message ? e.message : e);
      lib = null; fns = null;
      return false;
    }
  }

  function login() {
    if (loggedIn) return true;
    if (!load()) return false;
    try {
      const rc = fns.login();
      // 0 = logged in, 1 = logged in but Voicemeeter is not running. Both keep
      // the session: re-logging in on every press leaks one per key.
      if (rc !== 0 && rc !== 1) { lastError = 'voicemeeter_login_rc_' + rc; return false; }
      loggedIn = true;
      // The first read after a login is stale by design — the API says to poll
      // IsParametersDirty until it clears before trusting a value. One call is
      // enough in practice and costs nothing.
      try { fns.dirty(); } catch { /* not fatal */ }
      return true;
    } catch (e) {
      lastError = 'voicemeeter_login_failed: ' + (e && e.message ? e.message : e);
      return false;
    }
  }

  /** Which Voicemeeter is running, as an edition record, or null. */
  function edition() {
    if (!login()) return null;
    try {
      const out = [0];
      const rc = fns.getType(out);
      if (rc !== 0) { lastError = 'voicemeeter_not_running'; cachedType = 0; return null; }
      cachedType = Number(out[0]) || 0;
      const ed = editionFor(cachedType);
      if (!ed) { lastError = 'voicemeeter_unknown_type_' + cachedType; return null; }
      return ed;
    } catch (e) {
      lastError = 'voicemeeter_type_failed: ' + (e && e.message ? e.message : e);
      return null;
    }
  }

  function getParam(name) {
    if (!isSafeParam(name)) return { ok: false, error: 'voicemeeter_bad_param' };
    if (!login()) return { ok: false, error: lastError || 'voicemeeter_unavailable' };
    try {
      const out = [0];
      const rc = fns.getFloat(name, out);
      if (rc !== 0) return { ok: false, error: 'voicemeeter_read_failed' };
      return { ok: true, value: Number(out[0]) };
    } catch (e) {
      return { ok: false, error: 'voicemeeter_read_failed' };
    }
  }

  function setParam(name, value) {
    if (!isSafeParam(name)) return { ok: false, error: 'voicemeeter_bad_param' };
    const v = Number(value);
    if (!Number.isFinite(v)) return { ok: false, error: 'voicemeeter_bad_value' };
    if (!login()) return { ok: false, error: lastError || 'voicemeeter_unavailable' };
    try {
      const rc = fns.setFloat(name, v);
      if (rc !== 0) return { ok: false, error: 'voicemeeter_write_failed' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'voicemeeter_write_failed' };
    }
  }

  function macroButton(index, mode) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i > 79) return { ok: false, error: 'voicemeeter_bad_macro' };
    if (!login()) return { ok: false, error: lastError || 'voicemeeter_unavailable' };
    try {
      let want = 1;
      if (mode === 'off') want = 0;
      else if (mode !== 'on') {
        const cur = [0];
        // Mode 1 = the button's own state, which is what the panel shows.
        if (fns.macroGet(i, cur, 1) !== 0) return { ok: false, error: 'voicemeeter_read_failed' };
        want = Number(cur[0]) > 0.5 ? 0 : 1;
      }
      const rc = fns.macroSet(i, want, 1);
      if (rc !== 0) return { ok: false, error: 'voicemeeter_write_failed' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'voicemeeter_write_failed' };
    }
  }

  /**
   * What the Deck editor's pickers are filled from, and what the settings page
   * shows. Never throws; an absent Voicemeeter is a state, not a failure.
   */
  function state() {
    if (platform !== 'win32') return { ok: true, available: false, running: false, reason: 'voicemeeter_windows_only' };
    if (!resolveDll()) return { ok: true, available: false, running: false, reason: 'voicemeeter_not_installed' };
    const ed = edition();
    if (!ed) return { ok: true, available: true, running: false, reason: lastError || 'voicemeeter_not_running' };
    const strips = [];
    for (let i = 0; i < ed.strips; i++) {
      // A strip carries the name its owner typed in Voicemeeter. Falling back to
      // the mixer's own wording keeps the picker readable on a fresh install,
      // where every label is empty.
      strips.push({
        index: i,
        label: i < ed.physical
          ? 'Hardware Input ' + (i + 1)
          : 'Virtual Input ' + (i - ed.physical + 1),
      });
    }
    const buses = busLabels(ed.id).map((label, index) => ({
      index,
      label,
      name: label[0] === 'A' ? 'Physical out ' + label : 'Virtual out ' + label,
    }));
    return { ok: true, available: true, running: true, type: ed.id, edition: ed.name, strips, buses };
  }

  function close() {
    if (!loggedIn || !fns) return;
    try { fns.logout(); } catch { /* ignore */ }
    loggedIn = false;
  }

  // ── The Deck actions ──────────────────────────────────────────────────────
  async function runAction(action) {
    const a = action || {};
    // validateAction (js/deck-actions.js) returns the params FLAT on the action,
    // the same shape every other provider here reads. Reaching for a .params
    // bag that never exists made every key answer bad_strip.
    const p = a;
    const ed = edition();
    if (!ed) return { ok: false, error: lastError || 'voicemeeter_not_running' };

    const stripIdx = () => {
      const i = Number(p.strip);
      if (!Number.isInteger(i) || i < 0 || i >= ed.strips) return -1;
      return i;
    };

    switch (a.type) {
      case 'vmStripMute': {
        const i = stripIdx();
        if (i < 0) return { ok: false, error: 'voicemeeter_bad_strip' };
        return flip(paramName('strip', i, 'Mute'), p.mode);
      }
      case 'vmStripGain': {
        const i = stripIdx();
        if (i < 0) return { ok: false, error: 'voicemeeter_bad_strip' };
        return nudge(paramName('strip', i, 'Gain'), p.mode, p.value);
      }
      case 'vmStripBus': {
        const i = stripIdx();
        if (i < 0) return { ok: false, error: 'voicemeeter_bad_strip' };
        // The bus is stored as its LABEL (A1, B2) because that is what the
        // buttons say and what survives a move between editions.
        if (busIndex(p.bus, ed.id) < 0) return { ok: false, error: 'voicemeeter_bad_bus' };
        return flip(paramName('strip', i, String(p.bus).toUpperCase()), p.mode);
      }
      case 'vmBusMute': {
        const b = busIndex(p.bus, ed.id);
        if (b < 0) return { ok: false, error: 'voicemeeter_bad_bus' };
        return flip(paramName('bus', b, 'Mute'), p.mode);
      }
      case 'vmBusGain': {
        const b = busIndex(p.bus, ed.id);
        if (b < 0) return { ok: false, error: 'voicemeeter_bad_bus' };
        return nudge(paramName('bus', b, 'Gain'), p.mode, p.value);
      }
      case 'vmMacro':
        return macroButton(p.index, p.mode);
      case 'vmParam': {
        // The escape hatch, and the reason this integration is one file: every
        // control in Voicemeeter is a named parameter, so anything the named
        // actions above do not cover can still be bound without new code.
        const name = String(p.param || '').trim();
        if (!isSafeParam(name)) return { ok: false, error: 'voicemeeter_bad_param' };
        if (p.mode === 'toggle') return flip(name, 'toggle');
        if (p.mode === 'up' || p.mode === 'down') return nudge(name, p.mode, p.value);
        return setParam(name, p.value);
      }
      default:
        return { ok: false, error: 'voicemeeter_unknown_action' };
    }
  }

  function flip(name, mode) {
    if (!name) return { ok: false, error: 'voicemeeter_bad_param' };
    if (mode === 'on' || mode === 'off') return setParam(name, nextFlag(mode, 0));
    const cur = getParam(name);
    if (!cur.ok) return cur;
    return setParam(name, nextFlag('toggle', cur.value));
  }

  function nudge(name, mode, value) {
    if (!name) return { ok: false, error: 'voicemeeter_bad_param' };
    if (mode === 'set') {
      const v = clampGain(value);
      if (v == null) return { ok: false, error: 'voicemeeter_bad_value' };
      return setParam(name, v);
    }
    const cur = getParam(name);
    if (!cur.ok) return cur;
    const v = nextGain(mode === 'down' ? 'down' : 'up', cur.value, value);
    if (v == null) return { ok: false, error: 'voicemeeter_bad_value' };
    return setParam(name, v);
  }

  return { state, runAction, edition, getParam, setParam, macroButton, close, get lastError() { return lastError; } };
}

module.exports = {
  createClient,
  // Pure, and tested as such: none of these need a DLL, Windows, or a mixer.
  EDITIONS, editionFor, busLabels, busIndex, stripCount,
  clampGain, isSafeParam, paramName, nextFlag, nextGain,
  GAIN_MIN, GAIN_MAX, DLL_NAME, dllCandidates,
};
