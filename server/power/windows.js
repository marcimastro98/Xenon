'use strict';
// Windows: the battery from GetSystemPowerStatus, the power mode from the
// Balanced plan's overlay (Settings, System, Power: "Power mode"). koffi only,
// no PowerShell and no powercfg; every call runs on koffi's worker thread with
// a ceiling, so a stuck power service never holds the event loop.

const P = require('./parse.js');

const CALL_TIMEOUT_MS = 2000;

let api = null;
function load() {
  if (api) return api;
  const koffi = require('koffi');
  koffi.struct('PWR_STATUS', { ac: 'uint8', flag: 'uint8', pct: 'uint8', sys: 'uint8', life: 'uint32', full: 'uint32' });
  koffi.struct('PWR_GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: 'uint8[8]' });
  const k32 = koffi.load('kernel32.dll');
  const pp = koffi.load('powrprof.dll');
  api = {
    koffi,
    status: k32.func('bool __stdcall GetSystemPowerStatus(_Out_ PWR_STATUS *)'),
    activePlan: pp.func('uint32 __stdcall PowerGetActiveScheme(void *, _Out_ void **)'),
    overlay: pp.func('uint32 __stdcall PowerGetEffectiveOverlayScheme(_Out_ PWR_GUID *)'),
    // Exported by powrprof.dll since Windows 10 1709 and what the Settings page
    // calls; not in the SDK headers, so it is looked up and may be missing.
    setOverlay: (() => { try { return pp.func('uint32 __stdcall PowerSetActiveOverlayScheme(PWR_GUID)'); } catch { return null; } })(),
    localFree: k32.func('void * __stdcall LocalFree(void *)'),
  };
  return api;
}

function call(fn, ...args) {
  let timer = null;
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('power call timed out')), CALL_TIMEOUT_MS); });
  const run = new Promise((resolve, reject) => fn.async(...args, (err, res) => (err ? reject(err) : resolve(res))));
  return Promise.race([run.finally(() => clearTimeout(timer)), guard]);
}

const hex = (n, w) => n.toString(16).padStart(w, '0');
function guidText(g) {
  const d = Array.from(g.Data4);
  return `${hex(g.Data1, 8)}-${hex(g.Data2, 4)}-${hex(g.Data3, 4)}-${d.slice(0, 2).map((b) => hex(b, 2)).join('')}-${d.slice(2).map((b) => hex(b, 2)).join('')}`;
}
function guidStruct(text) {
  const h = text.replace(/-/g, '');
  const bytes = [];
  for (let i = 16; i < 32; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
  return { Data1: parseInt(h.slice(0, 8), 16), Data2: parseInt(h.slice(8, 12), 16), Data3: parseInt(h.slice(12, 16), 16), Data4: bytes };
}

async function activePlan(a) {
  const out = [null];
  const rc = await call(a.activePlan, null, out);
  if (rc !== 0 || !out[0]) return '';
  try { return guidText(a.koffi.decode(out[0], 'PWR_GUID')); } finally { a.localFree(out[0]); }
}

function available() {
  try { load(); return true; } catch { return false; }
}

async function read() {
  const a = load();
  const st = {};
  const ok = await call(a.status, st);
  const { battery, saver } = ok ? P.windowsStatus(st) : { battery: null, saver: false };
  const plan = await activePlan(a);
  const o = {};
  const rc = await call(a.overlay, o);
  const m = P.windowsMode(plan, rc === 0 ? guidText(o) : '');
  const canSet = !!a.setOverlay && m.why !== 'plan';
  return { battery, saver, mode: m.mode, modes: canSet ? P.MODES.slice() : [], canSet, ...(m.why ? { why: m.why } : {}) };
}

async function setMode(mode) {
  const a = load();
  if (!a.setOverlay) return { ok: false, error: 'unsupported' };
  const now = await read();
  if (!now.canSet) return { ok: false, error: now.why || 'unsupported' };
  const rc = await call(a.setOverlay, guidStruct(P.WIN_OVERLAY[mode]));
  return rc === 0 ? { ok: true } : { ok: false, error: 'failed' };
}

module.exports = { available, read, setMode, _guidText: guidText, _guidStruct: guidStruct };
