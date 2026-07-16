'use strict';
// iCUE SDK bridge. Sole owner of koffi + the SDK. Lazy-loaded only when enabled,
// so a user who never turns on RGB pays zero cost. Every SDK call is guarded;
// if the SDK is absent or fails, the bridge degrades to a documented no-op.
//
// Facts confirmed by the Task 1 hardware spike (iCUE SDK v4):
//   - CorsairSessionState::CSS_Connected == 6 (NOT 7).
//   - The session-state callback is void(void* ctx, CorsairSessionStateChanged* evt);
//     the state is the first field of that struct.
//   - CorsairConnect is asynchronous: it returns immediately and the callback
//     later flips the state to Connected. We must NOT busy-spin (that blocks the
//     event loop and starves koffi's callback marshalling) — enumeration happens
//     from inside the callback once we reach Connected.
//   - Releasing LEDs with alpha 0 hands control back to iCUE (verified visually).

const path = require('path');
const fs = require('fs');
const fx = require('./lighting-effects');
const external = require('./lighting-external'); // non-iCUE providers (WLED, …)

const CSS_CONNECTED = 6; // CorsairSessionState::CSS_Connected (confirmed on hardware)

// Resolve the SDK client DLL across installs. The redistributable client DLL is
// not always shipped under the Corsair path; an env override and a bundled copy
// take priority so the bridge is self-contained when possible.
function resolveDllPath() {
  const candidates = [
    process.env.ICUE_SDK_DLL,
    path.join(__dirname, 'vendor', 'iCUESDK.x64_2019.dll'),
    'C:\\Program Files\\Corsair\\CUE\\iCUESDK.x64_2019.dll',
    'C:\\Program Files\\Corsair\\CORSAIR iCUE 5 Software\\iCUESDK.x64_2019.dll',
    'C:\\Program Files\\Corsair\\CORSAIR iCUE Software\\iCUESDK.x64_2019.dll',
    'C:\\Program Files\\GIGABYTE\\Control Center\\Lib\\MBStorage\\iCUESDK.x64_2019.dll',
  ].filter(Boolean);
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch { /* ignore */ } }
  return null;
}

let koffi = null, lib = null, fns = null, stateCb = null;
let connected = false;
let connecting = false;
let lastError = null;
let dllPath = null;
let devices = [];                 // [{ id, model, type, ledCount, ledIds:[uint32] }]
let lastWrite = new Map();        // deviceId → "r,g,b" of the last colour written (on-change guard)

const gameDetect = require('./gamedetect');

let config = {
  enabled: false,
  brightness: 1.0,
  pauseDuringGame: true,
  devices: {},                                   // deviceId → bool opt-in
  // All effects are OFF by default (opt-in). Each is INDEPENDENT of the master:
  // enabling one drives the LEDs on its own, even with the master off.
  effects: {
    temperature: false,
    volume: false,
    musicAlbum: false,
    timer:        { enabled: false, color: '#ff0000', style: 'blink', durationMs: 1800 },
    notification: { enabled: false, color: '#ff0000', style: 'blink', durationMs: 1800 },
    reminder:     { enabled: false, color: '#ff0000', style: 'blink', durationMs: 1800 },
    // Bit's rage flash — gated by the Vitals→Bit "lighting" toggle, not the lighting
    // page, so it stays enabled here and the client only fires it when opted in.
    vitals:       { enabled: true,  color: '#ff2b2b', style: 'blink', durationMs: 4000 },
  },
  // Ambient animation. 'none' = reactive-only (no render loop runs). 'solid' is
  // static (no loop). The dynamic styles (breathing/cycle/wave/aurora/candle/
  // palette) run a light self-stopping ticker only while actively painting.
  // `palette` holds the user's 2–5 colours for the 'palette' style.
  animation: { style: 'none', color: '#1ed760', speed: 50, palette: ['#1ed760', '#0066ff'] },
  // Manual fixed colour (the "Colore manuale" picker). PERSISTED — restored on
  // restart. '' = none. Also feeds the "Fissa" animation.
  manualColor: '',
  // Per-device override (master mode only). deviceId → { mode, color?, anim? }.
  // mode: follow (use the dashboard colour) | color | animation | temperature |
  // album | off. Absent device = 'follow' (back-compatible).
  deviceModes: {},
};
const DEVICE_MODES = ['follow', 'color', 'animation', 'temperature', 'album', 'off'];
// Single source for the animation-style lists (keep the client mirrors in
// lighting-page.js / settings.js aligned). Every style except none/solid loops →
// drives the shared self-stopping ticker. Per-device excludes 'palette' (its
// colour list lives on the global animation only) and 'wave' (per-device renders
// uniform, which would be indistinguishable from 'cycle' — offering it there
// would just be a confusing duplicate).
const DYNAMIC_ANIM_STYLES = ['breathing', 'cycle', 'wave', 'aurora', 'candle', 'palette'];
const ANIM_STYLES = ['none', 'solid', ...DYNAMIC_ANIM_STYLES];
const PER_DEVICE_ANIM_STYLES = ['solid', ...DYNAMIC_ANIM_STYLES.filter(s => s !== 'palette' && s !== 'wave')];
let accent = { r: 30, g: 215, b: 96 };           // updated from settings
let layers = { base: null, overlay: null, album: null, animation: null, override: null };
let albumPalette = null;                         // [{r,g,b},…] 2-3 cover colours for the per-LED gradient (null = uniform)
let overlayUntil = 0;                            // ms timestamp the overlay expires
let lastVolume = null;                           // last seen speaker volume (for on-change flash)
let eventAnim = null;                            // { style, color, startMs, durationMs } while a flash plays
let eventTimer = null;                           // setInterval handle, exists only during a flash
let deckReaction = null;                         // { style, colorHex } transient Deck LED reaction (never persisted)
let animTimer = null;                            // ambient-animation ticker; exists only while a dynamic animation paints
let applyInFlight = false;                       // prevents concurrent apply() calls while an async LED write is in progress
let lastConnectAttempt = 0;                      // throttle for the apply()-driven on-demand (re)connect
let lastEnumerate = 0;                            // throttle for the apply()-driven re-enumerate when connected-but-empty
let enumerating = false;                          // guards against overlapping enumerate() calls (connect callback + retry)
let partialEnumRetries = 0;                        // bounded retries when a device enumerated with 0 LEDs (iCUE LINK boot race); reset on a complete enumeration / fresh connect
const MAX_PARTIAL_ENUM_RETRIES = 6;                // ~12s at CONNECT_RETRY_MS — long enough for iCUE to register LINK cooler/fans after a cold boot, bounded so a genuinely LED-less hub doesn't re-enumerate forever
const EVENT_DURATION_MS = 1800;
// One source for the user-configurable flash-duration bounds (mirrored by the
// slider in lighting-page.js and the settings normalizers).
const clampEventDuration = (ms, fallback) =>
  Number.isFinite(Number(ms)) ? Math.max(500, Math.min(10000, Number(ms))) : fallback;
const EVENT_TICK_MS = 60;
const ANIM_TICK_MS = 66;                         // ~15 fps; on-change guard makes most ticks a free no-op
const CONNECT_RETRY_MS = 2000;                   // min gap between on-demand reconnect attempts while an effect wants paint

function loadLib() {
  if (lib) return true;
  try {
    dllPath = resolveDllPath();
    if (!dllPath) { lastError = 'iCUE SDK DLL not found (set ICUE_SDK_DLL or install iCUE).'; return false; }
    koffi = require('koffi');
    lib = koffi.load(dllPath);
    koffi.struct('CorsairVersion', { major: 'int', minor: 'int', patch: 'int' });
    koffi.struct('CorsairSessionStateChanged', {
      state: 'int', clientVersion: 'CorsairVersion', serverVersion: 'CorsairVersion', serverHostVersion: 'CorsairVersion',
    });
    koffi.struct('CorsairDeviceInfo', { type: 'int', id: 'char[128]', serial: 'char[128]', model: 'char[128]', ledCount: 'int', channelCount: 'int' });
    koffi.struct('CorsairDeviceFilter', { deviceTypeMask: 'int' });
    koffi.struct('CorsairLedPosition', { id: 'uint32', cx: 'double', cy: 'double' });
    koffi.struct('CorsairLedColor', { id: 'uint32', r: 'uint8', g: 'uint8', b: 'uint8', a: 'uint8' });
    koffi.proto('void CorsairStateCb(void*, CorsairSessionStateChanged*)');
    fns = {
      connect: lib.func('int CorsairConnect(CorsairStateCb*, void*)'),
      disconnect: lib.func('int CorsairDisconnect()'),
      getDevices: lib.func('int CorsairGetDevices(CorsairDeviceFilter*, int, _Out_ CorsairDeviceInfo*, _Out_ int*)'),
      getLedPositions: lib.func('int CorsairGetLedPositions(const char*, int, _Out_ CorsairLedPosition*, _Out_ int*)'),
      setLedColors: lib.func('int CorsairSetLedColors(const char*, int, CorsairLedColor*)'),
      // CorsairProperty is { CorsairDataType type; union { bool; int32; double;
      // char*; {ptr,count} arrays } value; } — 24 bytes on x64 (4-byte type,
      // padding, 8-byte-aligned 16-byte union). It is read from a raw byte
      // buffer (type at offset 0, value at offset 8) instead of a koffi union:
      // only CT_Int32 (battery percent) is ever consumed, and a raw buffer
      // sidesteps output-union decoding entirely. See getBatteryLevels().
      readProperty: lib.func('int CorsairReadDeviceProperty(const char*, int, uint32, _Out_ uint8_t*)'),
      freeProperty: lib.func('int CorsairFreeProperty(uint8_t*)'),
    };
    return true;
  } catch (e) {
    lastError = 'SDK load failed: ' + e.message;
    lib = null; fns = null;
    return false;
  }
}

function connect() {
  if (connected || connecting) return true;
  if (!loadLib()) return false;
  try {
    connecting = true;
    partialEnumRetries = 0; // fresh session gets a fresh re-enumeration budget
    stateCb = koffi.register((_ctx, evt) => {
      let state = -1;
      try { state = koffi.decode(evt, 'CorsairSessionStateChanged').state; } catch (e) { lastError = 'state decode failed: ' + e.message; }
      const now = (state === CSS_CONNECTED);
      if (now && !connected) {
        connected = true; connecting = false;
        // Defer ALL SDK calls out of this callback. The SDK invokes us from its
        // own worker thread and blocks that thread until we return; making a
        // synchronous SDK call here (enumerate → CorsairGetDevices) would wait on
        // that same thread → mutual deadlock that freezes the whole Node event
        // loop. setImmediate lets the callback return first, freeing the SDK
        // thread, before we enumerate (now itself async/non-blocking).
        setImmediate(async () => { await enumerate(); onConnected(); });
      } else {
        connected = now; if (now) connecting = false;
      }
    }, koffi.pointer('CorsairStateCb'));
    const rc = fns.connect(stateCb, null);
    if (rc !== 0) { lastError = 'CorsairConnect rc=' + rc; connecting = false; return false; }
    // Connection completes asynchronously; the callback flips `connected`.
    return true;
  } catch (e) {
    lastError = 'connect failed: ' + e.message;
    connecting = false;
    return false;
  }
}

// Connect (if needed) and wait until the session reaches Connected or times out.
// Uses async sleeps so koffi's callback can be marshalled to the JS thread —
// a busy-spin would starve it and never connect.
async function ensureConnected(timeoutMs = 1800) {
  if (connected) return true;
  if (!config.enabled) return false;
  connect();
  const start = Date.now();
  while (!connected && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 50));
  }
  return connected; // the state callback already ran enumerate()/onConnected()
}

// Invoked once the session reaches Connected: paint immediately so the bridge
// reflects the latest data without waiting for the next SSE tick. `apply` is a
// hoisted declaration from the orchestration layer below.
function onConnected() { apply(); }

// Hard ceiling for any single SDK round-trip. The iCUE SDK talks to the iCUE
// service over a synchronous cross-process channel; if that service is busy or
// wedged a call can hang indefinitely. Every SDK call below goes through the
// async koffi binding (worker thread, never the event loop) AND this timeout,
// so a stuck service degrades the bridge to a no-op instead of freezing Node.
const SDK_OP_TIMEOUT_MS = 2500;

// Reject if `promise` doesn't settle within SDK_OP_TIMEOUT_MS. The underlying
// koffi async call can't be cancelled (it keeps running on a worker thread),
// but the event loop is freed immediately so the server stays responsive.
function withSdkTimeout(promise, label) {
  let t;
  const guard = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label + ' timed out after ' + SDK_OP_TIMEOUT_MS + 'ms')), SDK_OP_TIMEOUT_MS);
    if (t.unref) t.unref();
  });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(t)), guard]);
}

// Enumerate connected iCUE devices and their LED layouts.
// CRITICAL: every FFI call uses koffi's `.async` form so it runs on a worker
// thread, never the event-loop thread. A synchronous CorsairGetDevices /
// CorsairGetLedPositions here would block (and, when called from inside the SDK
// state callback, deadlock) the entire Node process — see connect()'s callback.
async function enumerate() {
  if (!fns) { devices = []; return; }
  if (enumerating) return; // a concurrent enumeration is already in flight (connect callback vs. apply-driven retry)
  enumerating = true;
  try {
    const filter = { deviceTypeMask: -1 };
    const buf = Array(64).fill(null).map(() => ({}));
    const count = [0];
    await withSdkTimeout(new Promise((resolve, reject) =>
      fns.getDevices.async(filter, 64, buf, count, err => err ? reject(err) : resolve())
    ), 'CorsairGetDevices');
    const list = [];
    for (let i = 0; i < count[0]; i++) {
      const d = buf[i];
      const pos = Array(d.ledCount).fill(null).map(() => ({}));
      const pc = [0];
      await withSdkTimeout(new Promise((resolve, reject) =>
        fns.getLedPositions.async(d.id, d.ledCount, pos, pc, err => err ? reject(err) : resolve())
      ), 'CorsairGetLedPositions');
      list.push({ id: d.id, model: d.model, type: d.type, ledCount: d.ledCount, ledIds: pos.slice(0, pc[0]).map(p => p.id) });
    }
    devices = list;
    // A complete enumeration (every device has LEDs) clears the partial-retry
    // budget, so a later 0-LED reappearance (e.g. an iCUE LINK hot-replug) gets
    // its own fresh round of retries.
    if (list.length && list.every(d => d.ledCount > 0)) partialEnumRetries = 0;
  } catch (e) {
    lastError = 'enumerate failed: ' + e.message;
    devices = [];
  } finally {
    enumerating = false;
  }
}

// --- Device battery (CDPI_BatteryLevel) ------------------------------------
// Battery percent of the enumerated wireless Corsair devices. Read-only and
// side-effect free: it NEVER connects on demand — when the RGB bridge is off
// or disconnected the caller degrades to its other sources (Bluetooth PnP).
// Values confirmed against the official iCUE SDK v4 header (CorsairOfficial/
// cue-sdk): CDPI_BatteryLevel = 9, CT_Int32 = 1, CE_Success = 0; wired or
// unsupported devices answer CE_NotAllowed and are skipped. The v4 SDK has no
// charging-state property, so only the percent is reported.
const CDPI_BATTERY_LEVEL = 9;
const CT_INT32 = 1;
const CORSAIR_PROPERTY_BYTES = 24; // sizeof(CorsairProperty) on x64 — see fns.readProperty

async function getBatteryLevels() {
  if (!connected || !fns) return { ok: false, reason: 'icue_off', devices: [] };
  const out = [];
  for (const dev of devices) {
    try {
      const buf = Buffer.alloc(CORSAIR_PROPERTY_BYTES);
      const rc = await withSdkTimeout(new Promise((resolve, reject) =>
        fns.readProperty.async(dev.id, CDPI_BATTERY_LEVEL, 0, buf, (err, rc) => err ? reject(err) : resolve(rc))
      ), 'CorsairReadDeviceProperty');
      if (rc !== 0) continue; // wired / unsupported device (CE_NotAllowed etc.)
      const dataType = buf.readInt32LE(0);
      if (dataType !== CT_INT32) {
        // Unexpected payload (string/array): free the SDK-side allocation and
        // skip. Fire-and-forget on the async worker path — no sync FFI on the
        // event loop, and nothing to wait for on a best-effort free.
        try { fns.freeProperty.async(buf, () => {}); } catch { /* best-effort */ }
        continue;
      }
      const percent = buf.readInt32LE(8);
      if (percent < 0 || percent > 100) continue;
      out.push({ name: String(dev.model || '').trim(), percent });
    } catch { /* per-device failure: skip, never fail the batch */ }
  }
  return { ok: true, devices: out.filter(d => d.name) };
}

// Write a single uniform colour to a device (on-change only).
// Async so the koffi FFI call runs on a worker thread and never blocks the Node event loop.
async function writeDevice(deviceId, color) {
  const dev = devices.find(d => d.id === deviceId);
  if (!dev || !connected) return;
  const key = `${color.r},${color.g},${color.b}`;
  if (lastWrite.get(deviceId) === key) return; // unchanged → skip
  try {
    const arr = dev.ledIds.map(id => ({ id, r: color.r, g: color.g, b: color.b, a: 255 }));
    await withSdkTimeout(new Promise((resolve, reject) =>
      fns.setLedColors.async(deviceId, arr.length, arr, (err, _rc) => err ? reject(err) : resolve())
    ), 'CorsairSetLedColors');
    lastWrite.set(deviceId, key);
  } catch (e) { lastError = 'write failed: ' + e.message; }
}

// Paint a multi-stop gradient across the device's LEDs (album palette). Same
// write path and on-change skip as writeDevice; the gradient is recomputed only
// when the palette actually changed (the cache key encodes every stop). Static —
// no ticker, zero idle cost, exactly like the uniform path.
async function writeDeviceGradient(dev, palette) {
  if (!dev || !connected) return;
  const key = 'grad:' + palette.map(c => `${c.r},${c.g},${c.b}`).join('|');
  if (lastWrite.get(dev.id) === key) return; // unchanged → skip
  try {
    const stops = fx.paletteGradient(palette, dev.ledIds.length);
    const arr = dev.ledIds.map((id, i) => ({ id, r: stops[i].r, g: stops[i].g, b: stops[i].b, a: 255 }));
    await withSdkTimeout(new Promise((resolve, reject) =>
      fns.setLedColors.async(dev.id, arr.length, arr, (err, _rc) => err ? reject(err) : resolve())
    ), 'CorsairSetLedColors');
    lastWrite.set(dev.id, key);
  } catch (e) { lastError = 'write failed: ' + e.message; }
}

// Paint the current spatial-animation frame (wave/palette) across the device's
// LEDs. Same write path as the album gradient. The caller pre-computes the
// frame key (fx.animationFrameKey — the quantized phase/shift that DEFINES the
// frame) and checks it against lastWrite BEFORE building the per-LED array, so
// unchanged frames cost zero allocations.
async function writeDeviceAnimGradient(dev, stops, key) {
  if (!dev || !connected || !stops || !stops.length) return;
  try {
    const arr = dev.ledIds.map((id, i) => {
      const c = stops[Math.min(i, stops.length - 1)];
      return { id, r: c.r, g: c.g, b: c.b, a: 255 };
    });
    await withSdkTimeout(new Promise((resolve, reject) =>
      fns.setLedColors.async(dev.id, arr.length, arr, (err, _rc) => err ? reject(err) : resolve())
    ), 'CorsairSetLedColors');
    lastWrite.set(dev.id, key);
  } catch (e) { lastError = 'write failed: ' + e.message; }
}

// Release: hand control back to iCUE (alpha-0 transparent, confirmed in Task 1)
// and to every external provider (restore / turn off / neutral).
// `idleReleased` makes the idle apply() path release ONCE per painting session:
// without it every 7s system tick would re-send the off command, which on the
// room-light providers (Home Assistant, Yeelight, Hue) would keep switching off
// lights the user just turned back on from their app or wall switch.
let idleReleased = false;
async function releaseAll() {
  if (connected) {
    for (const dev of devices) {
      try {
        const arr = dev.ledIds.map(id => ({ id, r: 0, g: 0, b: 0, a: 0 }));
        // Same timeout guard as every other SDK call — a wedged iCUE service must
        // not stall the release path (apply() awaits it while holding applyInFlight).
        await withSdkTimeout(new Promise((resolve, reject) =>
          fns.setLedColors.async(dev.id, arr.length, arr, (err, _rc) => err ? reject(err) : resolve())
        ), 'CorsairSetLedColors');
      } catch (e) { lastError = 'release failed: ' + e.message; }
    }
  }
  try { external.release(); } catch { /* external is best-effort */ }
  lastWrite.clear();
  idleReleased = true;
}

function disconnect() {
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  const wasLive = !!(lib && connected);
  connected = false;
  connecting = false;
  lastWrite.clear();
  // Unregister the koffi callback only once the SDK session is fully torn down,
  // so the SDK can't invoke a freed trampoline mid-teardown.
  const dropCallback = () => { if (koffi && stateCb) { try { koffi.unregister(stateCb); } catch { /* ignore */ } stateCb = null; } };
  // CorsairDisconnect is a synchronous cross-process call: run it off the event
  // loop so a wedged iCUE service can never block the server on teardown.
  if (wasLive) {
    try { fns.disconnect.async(() => dropCallback()); }
    catch { dropCallback(); }
  } else {
    dropCallback();
  }
}

function getDevices() { return devices.map(d => ({ id: d.id, model: d.model, type: d.type, ledCount: d.ledCount })); }
function isConnected() { return connected; }
function getLastError() { return lastError; }

// SDK is "available" if its client DLL can be resolved — checkable without
// loading it, so the UI shows controls (and a working master toggle) even while
// the bridge is OFF. Loaded lib short-circuits the filesystem probe.
function isAvailable() { return !!lib || resolveDllPath() !== null; }

// The album colour, gated by its effect toggle. `layers.album` always holds the
// last pushed cover colour (so toggling the effect on shows it without waiting
// for a re-push); this returns it only when the effect is enabled.
function effectiveAlbum() {
  return config.effects.musicAlbum !== false ? layers.album : null;
}

// True when the album effect alone wants the LEDs, independent of the master
// toggle — this is what lets "Album → LED" drive the lights on its own.
function albumActive() {
  return effectiveAlbum() != null;
}

// Paused because a game is running (and the user opted into pausing).
function gamingPaused() {
  if (!config.pauseDuringGame) return false;
  try { return gameDetect.isGaming(); } catch { return false; }
}

// Intent: does anything want the LEDs painted right now? Each effect is INDEPENDENT
// of the master toggle — the master only adds the steady "fixed" illumination
// (manual colour / animation / accent). Temperature, album, volume flash and the
// event flashes each light up on their own when enabled, even with the master OFF.
function wantsPaint() {
  if (gamingPaused()) return false;
  if (config.enabled) return true;                                    // fixed illumination
  if (config.effects.temperature && layers.base) return true;         // steady CPU-temp colour
  if (albumActive()) return true;                                     // steady album colour
  if (config.effects.volume && layers.overlay && (!overlayUntil || Date.now() <= overlayUntil)) return true; // volume flash window
  if (eventAnim) return true;                                         // a timer/notification/reminder flash is playing
  if (deckReaction) return true;                                      // a Deck key LED reaction is active
  return false;
}

// Are we actually painting somewhere? True when something wants paint AND we have
// a live sink — either an iCUE session or at least one external device. This lets
// the bridge drive WLED/etc even with no iCUE installed.
function active() {
  return wantsPaint() && (connected || external.hasDevices());
}

// Should we hold an iCUE session at all? True if the master OR ANY effect is on —
// so e.g. a timer flash can fire instantly even with the master off. When idle
// (nothing to paint) apply() releases via alpha-0, so iCUE's own lighting shows.
function shouldConnect() {
  const e = config.effects;
  return config.enabled || !!deckReaction || !!e.temperature || !!e.musicAlbum
    || (e.timer && e.timer.enabled !== false)
    || (e.notification && e.notification.enabled !== false)
    || (e.reminder && e.reminder.enabled !== false);
}

// Bring the iCUE session up / tear it down to match shouldConnect(). Called after
// any config change. Disconnect hands the LEDs back to iCUE.
function reconcileConnection() {
  if (shouldConnect()) { if (!connected && !connecting && isAvailable()) connect(); }
  else if (connected) { releaseAll(); disconnect(); }
}

// --- ambient animation ticker -------------------------------------------------
// Recompute the animation layer for the current style. Static for 'solid', live
// sample for the dynamic styles, null for 'none'. Cheap (pure math).
function refreshAnimationLayer() {
  const a = config.animation || {};
  if (!a.style || a.style === 'none') { layers.animation = null; return; }
  // "Fissa" (solid) has no colour of its own — it reuses the manual colour set
  // above (or the accent when none is set), so the user picks the colour once.
  if (a.style === 'solid') { layers.animation = layers.override || accent; return; }
  layers.animation = fx.animationColorAt({ style: a.style, color: a.color, speed: a.speed, palette: a.palette, nowMs: Date.now() });
}

// Does any per-device override run a dynamic (looping) animation?
function anyDeviceAnimationDynamic() {
  for (const id of Object.keys(config.deviceModes)) {
    const m = config.deviceModes[id];
    if (m && m.mode === 'animation') {
      const s = (m.anim && m.anim.style) || 'cycle';
      if (DYNAMIC_ANIM_STYLES.includes(s)) return true;
    }
  }
  return false;
}

// Resolve the colour for a single device given the global colour. 'follow' (and
// unknown) returns the global colour; other modes compute their own. Returns a
// brightness-applied {r,g,b}; 'off' returns black.
function colorForDevice(id, globalColor) {
  const m = config.deviceModes[id];
  if (!m || !m.mode || m.mode === 'follow') return globalColor;
  if (m.mode === 'off') return { r: 0, g: 0, b: 0 };
  if (m.mode === 'color') return fx.applyBrightness(fx.parseColorName(m.color || '') || accent, config.brightness);
  if (m.mode === 'temperature') return layers.base ? fx.applyBrightness(layers.base, config.brightness) : globalColor;
  if (m.mode === 'album') return layers.album ? fx.applyBrightness(layers.album, config.brightness) : globalColor;
  if (m.mode === 'animation') {
    const a = m.anim || {};
    const c = fx.animationColorAt({ style: a.style || 'cycle', color: a.color || '#1ed760', speed: a.speed || 50, nowMs: Date.now() });
    return c ? fx.applyBrightness(c, config.brightness) : globalColor;
  }
  return globalColor;
}

// Start/stop the render loop to match state. The loop exists ONLY while a dynamic
// animation (breathing/cycle) is actively painting somewhere — global OR a
// per-device override. Idle cost is therefore zero. Idempotent.
function syncAnimationTicker() {
  const style = config.animation && config.animation.style;
  const deckDynamic = !!deckReaction && deckReaction.style !== 'solid'; // master-independent: loops whenever the reaction is active
  const dynamic = DYNAMIC_ANIM_STYLES.includes(style) || anyDeviceAnimationDynamic() || deckDynamic;
  const shouldRun = dynamic && active();
  if (shouldRun && !animTimer) animTimer = setInterval(tickAnimation, ANIM_TICK_MS);
  else if (!shouldRun && animTimer) { clearInterval(animTimer); animTimer = null; }
}

function tickAnimation() {
  refreshAnimationLayer();
  apply();
}

// On-demand (re)connect driver for the master-INDEPENDENT effects (Deck reaction,
// album, temperature, event flashes). While something wants the LEDs but no sink is
// live yet — e.g. iCUE is still launching right after a reboot — keep retrying the
// connect on the regular apply() ticks until the session comes up. Without this a
// one-shot connect() on the triggering event would give up on that transient miss
// and the effect would stay dark until the user toggled the master toggle by hand
// (exactly the "LEDs only work after I tick Illuminazione once" symptom). Throttled,
// guarded by connect()'s own connecting flag, and gated on wantsPaint() + an
// available SDK, so it self-limits to zero cost whenever nothing needs the LEDs.
function maybeReconnectForPaint() {
  if (connected || connecting) return;
  if (!wantsPaint() || external.hasDevices() || !isAvailable()) return;
  if (Date.now() - lastConnectAttempt < CONNECT_RETRY_MS) return;
  lastConnectAttempt = Date.now();
  connect();
}

// The connected session's device list looks INCOMPLETE — either empty, or a device
// enumerated with zero LEDs. enumerate() runs once from the connect callback; if
// iCUE hadn't finished populating its device list yet (common right after a PC boot
// — the SDK reports Connected before the devices are registered) we'd otherwise be
// stuck. Two shapes of "not ready":
//   - EMPTY list: nothing enumerated at all → keep retrying indefinitely.
//   - PARTIAL list: a device shows up with ledCount 0. The iCUE LINK System Hub
//     reports 0 LEDs until iCUE finishes registering the cooler/fans behind it, so
//     the RAM (a direct device) lights up while the AIO + fans stay dark. Retry, but
//     BOUND it — a hub with no RGB children legitimately has 0 LEDs, so we must not
//     re-enumerate forever.
function enumerationIncomplete() {
  return connected && (devices.length === 0 || devices.some(d => d.ledCount === 0));
}

// Throttled, bounded re-enumeration shared by the apply() tick and the status
// endpoint. Returns the enumerate() promise when it fires, else undefined.
// Fire-and-forget safe: enumerate is async (worker thread), never blocks here.
function boundedReenumerate() {
  if (!enumerationIncomplete()) return;
  // Empty keeps retrying; a partial list is capped so a genuinely LED-less device
  // doesn't trigger perpetual re-enumeration.
  if (devices.length > 0 && partialEnumRetries >= MAX_PARTIAL_ENUM_RETRIES) return;
  if (Date.now() - lastEnumerate < CONNECT_RETRY_MS) return;
  lastEnumerate = Date.now();
  if (devices.length > 0) partialEnumRetries++;
  return enumerate();
}

// apply()-driven re-enumeration: gated on wantsPaint() so an idle bridge stays at
// zero cost. Repaints once the freshly-enumerated devices show up.
function maybeReenumerate() {
  if (!wantsPaint()) return;
  const p = boundedReenumerate();
  if (p) p.then(() => { if (devices.length) apply(); }).catch(() => { /* lastError set inside */ });
}

// Compute the final colour and push it to every opted-in device (on-change).
// Async because writeDevice is now async (koffi FFI call on worker thread).
// applyInFlight prevents concurrent writes if a previous apply() is still awaiting.
async function apply() {
  syncAnimationTicker(); // start/stop the ambient loop to match current state (cheap, idempotent)
  maybeReconnectForPaint(); // bring a sink up on demand when an effect wants paint but none is live yet
  maybeReenumerate();       // recover from a connected-but-empty device list (boot race)
  if (applyInFlight) return;
  applyInFlight = true;
  try {
    if (overlayUntil && Date.now() > overlayUntil) { layers.overlay = null; overlayUntil = 0; }
    if (!active()) {
      // Don't cancel a still-live event flash just because no sink is up YET: an
      // on-demand flash (Bit's rage / any effect with no held session) arms before
      // iCUE finishes connecting, and dropping it here is what made the flash never
      // appear. Keep it armed until it paints (sink connects) or its window elapses.
      if (!eventAnim || fx.eventColorAt({ ...eventAnim, nowMs: Date.now() }) === null) stopEvent(true);
      if (!idleReleased) await releaseAll();
      return;
    }
    idleReleased = false; // painting again — the next idle transition releases once

    // Event flash (transient, top priority). Null = finished → drop it.
    let eventColor = null;
    if (eventAnim) {
      eventColor = fx.eventColorAt({ ...eventAnim, nowMs: Date.now() });
      if (eventColor === null) stopEvent(true);
    }

    // Priority (top → bottom): event flash > album (music) > CPU temperature >
    // ambient. The reactive effects (album, temperature) OVERRIDE the fixed base,
    // so the album colour shows while music plays and falls back to the fixed
    // colour when it stops. The ambient (animation / manual colour / accent) is
    // the master's steady "fixed illumination" and only exists when master is on.
    const ambient = config.enabled ? (layers.animation || layers.override || accent) : null;
    // A Deck LED reaction overlays the reactive/ambient layers but stays below an
    // event flash. Like every other effect it is INDEPENDENT of the master toggle
    // (a per-key reaction is itself an explicit opt-in), so it fires even with the
    // master off. Transient — never persisted.
    const deckColor = deckReactionColor();
    const albumCol = effectiveAlbum();
    const picked = eventColor
      || deckColor
      || albumCol
      || (config.effects.temperature ? layers.base : null)
      || ambient
      || { r: 0, g: 0, b: 0 };
    const color = fx.applyBrightness(picked, config.brightness);

    const resolve = (id) => colorForDevice(id, color);

    // Album palette gradient: when the cover supplied 2-3 colours, devices that
    // are showing the album colour get them spread across their LEDs instead of
    // a single uniform tint. Transient flashes (event/Deck) still take the whole
    // device, and per-device fixed modes are untouched.
    const gradientPal = albumPalette
      ? albumPalette.map(c => fx.applyBrightness(c, config.brightness))
      : null;
    const globalIsAlbum = !eventColor && !deckColor && picked === albumCol;
    const wantsGradient = (id) => {
      if (!gradientPal) return false;
      const m = config.deviceModes[id];
      const mode = (m && m.mode) ? m.mode : 'follow';
      return (mode === 'follow' && globalIsAlbum) || (mode === 'album' && !!layers.album);
    };

    // Spatial ambient animation (wave/palette): when the global colour IS the
    // animation layer, per-LED-capable devices (iCUE) paint the full spread for
    // this frame instead of the uniform sample. Mirrors the album-gradient
    // branch; external providers keep the uniform colour so their per-write
    // HTTP/UDP cost stays bounded. Computed once per apply(), shared by every
    // device (LED counts differ → sampled per device below).
    const animCfg = config.animation || {};
    const animNow = Date.now();
    const globalIsAnim = !eventColor && !deckColor && picked != null && picked === layers.animation
      && fx.isSpatialAnimation(animCfg.style);
    const wantsAnimGradient = (id) => {
      if (!globalIsAnim) return false;
      const m = config.deviceModes[id];
      return !m || !m.mode || m.mode === 'follow';
    };
    const animOpts = { style: animCfg.style, color: animCfg.color, speed: animCfg.speed, palette: animCfg.palette, nowMs: animNow };

    // iCUE devices (only when an iCUE session is connected).
    if (connected) {
      for (const dev of devices) {
        if (config.devices[dev.id] === false) continue; // opt-out
        if (wantsGradient(dev.id)) { await writeDeviceGradient(dev, gradientPal); continue; }
        if (wantsAnimGradient(dev.id)) {
          // Frame identity (quantized phase/shift + brightness) checked BEFORE
          // building the per-LED array: unchanged frames cost zero allocations.
          const frameKey = `anim:${animCfg.style}:${fx.animationFrameKey(animOpts, dev.ledIds.length)}:${Math.round(config.brightness * 64)}`;
          if (lastWrite.get(dev.id) === frameKey) continue;
          const stops = fx.animationGradientAt(animOpts, dev.ledIds.length);
          if (stops) {
            await writeDeviceAnimGradient(dev, stops.map(c => fx.applyBrightness(c, config.brightness)), frameKey);
            continue;
          }
        }
        await writeDevice(dev.id, resolve(dev.id));
      }
    }
    // External providers (WLED/Hue/…): independent of iCUE, non-blocking fan-out.
    // With an album palette, per-LED-capable providers (WLED strips, Hue bulbs
    // via the bridge) paint the gradient; the rest spread the cover colours
    // across their devices (one stop per lamp).
    external.writeWith(resolve, gradientPal ? (id) => (wantsGradient(id) ? gradientPal : null) : null);
  } finally {
    applyInFlight = false;
  }
}

// --- data feeds (called from server.js on existing SSE intervals) ---
function onSystem(info) {
  if (config.effects.temperature && info && info.cpuTemp != null) {
    layers.base = fx.tempToColor(Number(info.cpuTemp));
  }
  apply();
}
// Volume → flash effect removed (it was unreliable). No-op kept so the server's
// audio SSE tick can still call it harmlessly.
function onAudio() { /* volume flash removed */ }
function onStatus() { apply(); } // re-evaluate game-mode idle

// Start an event flash for the given type if its effect is enabled. Works even
// with the master OFF (independent effect) — needs only a live sink and no game
// pause. The bridge stays connected while any event effect is enabled, so the
// flash is ready to fire instantly. Drives a short self-cancelling loop.
function startEvent(type) {
  const cfg = config.effects[type];
  if (!cfg || typeof cfg !== 'object' || cfg.enabled === false) return;
  if (gamingPaused()) return;
  // Arm the flash FIRST, then ensure a sink. If none is live yet (e.g. Bit's rage
  // flash on a bridge that isn't holding a session — 'vitals' is deliberately not in
  // shouldConnect(), so it must come up on demand), maybeReconnectForPaint() brings
  // iCUE up on the apply() ticks and the armed flash paints once connected. The old
  // early-return here dropped the flash entirely whenever no session was already up —
  // which is exactly why the LEDs never reacted when a vital hit zero.
  eventAnim = { style: cfg.style || 'blink', color: cfg.color || '#ff0000', startMs: Date.now(), durationMs: clampEventDuration(cfg.durationMs, EVENT_DURATION_MS) };
  if (!eventTimer) eventTimer = setInterval(() => apply(), EVENT_TICK_MS);
  if (!connected && !external.hasDevices() && isAvailable()) connect();
  apply();
}

// Stop any running flash. `silent` skips the final repaint (used inside apply()).
function stopEvent(silent) {
  eventAnim = null;
  if (eventTimer) { clearInterval(eventTimer); eventTimer = null; }
  if (!silent) apply();
}

// Public event entry point (timer server-side; reminder/notification via endpoint).
function onEvent(type) {
  if (['timer', 'notification', 'reminder', 'vitals'].includes(type)) startEvent(type);
}

// --- control surface (called from endpoints / AI) ---
function setManualColor(input) {
  const c = fx.parseColorName(input);
  if (!c) return false;
  layers.override = c;
  config.manualColor = fx.rgbToHex(c); // persisted
  lastWrite.clear(); // force a write even if the colour equals the last one painted
  refreshAnimationLayer(); // keep "Fissa" (solid) in sync — it reuses the manual colour
  apply();
  return true;
}
function clearManual() { layers.override = null; config.manualColor = ''; lastWrite.clear(); refreshAnimationLayer(); apply(); }

// Deck LED reaction: a TRANSIENT overlay a Deck key drives (one-shot on press, or
// while a bound state like mic-mute / OBS-record is active). It sits just below an
// event flash and ABOVE the reactive/ambient layers, and — crucially — never touches
// the persisted manual colour or animation. So clearing it returns the LEDs to the
// user's OWN configured lighting (manual colour / animation / album), not a blank
// default. Master-INDEPENDENT: like every other effect it paints on its own even
// with the master toggle off (it brings up an iCUE session on demand below), so a
// mic-mute / OBS-record reaction lights up regardless of the "Illuminazione" flag.
function setDeckReaction(input, style) {
  const c = fx.parseColorName(input);
  if (!c) return false;
  deckReaction = {
    style: ['solid', 'breathing', 'cycle'].includes(style) ? style : 'solid',
    colorHex: fx.rgbToHex(c),
  };
  lastWrite.clear(); // force a repaint even if the colour equals the last one painted
  // Master-independent: if nothing else is holding a sink (master off, all effects
  // off), bring up iCUE on demand so the reaction can paint — mirrors startEvent().
  // onConnected() re-applies once the session is up, so the reaction isn't lost.
  if (!connected && !external.hasDevices() && isAvailable()) connect();
  apply();           // apply() → syncAnimationTicker starts the loop for breathing/cycle
  return true;
}
function clearDeckReaction() {
  if (!deckReaction) return;
  deckReaction = null;
  lastWrite.clear();
  apply();           // composite falls back to the user's configured lighting; ticker self-stops
}
// Live colour for the deck reaction: static for 'solid', sampled for breathing/cycle.
function deckReactionColor() {
  if (!deckReaction) return null;
  if (deckReaction.style === 'solid') return fx.parseColorName(deckReaction.colorHex);
  return fx.animationColorAt({ style: deckReaction.style, color: deckReaction.colorHex, speed: 50, nowMs: Date.now() });
}

// Set the ambient animation (style/color/speed/palette). 'none' clears it.
// Validated (ANIM_STYLES); unknown styles are ignored. Refreshes the layer +
// (re)syncs the loop.

// Validate a user palette: 2–5 parseable colours, stored as normalized hex.
function sanitizePalette(input) {
  if (!Array.isArray(input)) return null;
  const hexes = input.slice(0, 5)
    .map(h => fx.parseColorName(h))
    .filter(Boolean)
    .map(c => fx.rgbToHex(c));
  return hexes.length >= 2 ? hexes : null;
}

// Switching to the candle while the colour is still the generic green default
// swaps in a warm flame tint. Lives HERE (not the UI) so every entry point —
// settings page, AI set_animation, per-device modes — gets the same warm flame.
const GENERIC_DEFAULT_COLOR = '#1ed760';
const CANDLE_DEFAULT_COLOR = '#ff9329';

function setAnimation(patch) {
  if (!patch || typeof patch !== 'object') return false;
  const cur = config.animation;
  const becameCandle = patch.style === 'candle' && cur.style !== 'candle';
  if (typeof patch.style === 'string' && ANIM_STYLES.includes(patch.style)) cur.style = patch.style;
  if (typeof patch.color === 'string') { const c = fx.parseColorName(patch.color); if (c) cur.color = patch.color; }
  if (becameCandle && cur.color === GENERIC_DEFAULT_COLOR) cur.color = CANDLE_DEFAULT_COLOR;
  if (patch.speed != null && Number.isFinite(Number(patch.speed))) cur.speed = Math.max(1, Math.min(100, Number(patch.speed)));
  if (patch.palette !== undefined) { const pal = sanitizePalette(patch.palette); if (pal) cur.palette = pal; }
  lastWrite.clear();
  refreshAnimationLayer();
  apply();
  return true;
}

// Set a per-device override (mode + optional colour/animation). 'follow' restores
// the dashboard colour for that device. Validated; repaints immediately.
function setDeviceMode(id, patch) {
  if (!id || !patch || typeof patch !== 'object') return false;
  const cur = config.deviceModes[id] || { mode: 'follow' };
  if (typeof patch.mode === 'string' && DEVICE_MODES.includes(patch.mode)) cur.mode = patch.mode;
  if (typeof patch.color === 'string') { const c = fx.parseColorName(patch.color); if (c) cur.color = patch.color; }
  if (patch.anim && typeof patch.anim === 'object') {
    cur.anim = cur.anim || { style: 'cycle', color: '#1ed760', speed: 50 };
    const becameCandle = patch.anim.style === 'candle' && cur.anim.style !== 'candle';
    if (PER_DEVICE_ANIM_STYLES.includes(patch.anim.style)) cur.anim.style = patch.anim.style;
    if (typeof patch.anim.color === 'string') { const c = fx.parseColorName(patch.anim.color); if (c) cur.anim.color = patch.anim.color; }
    if (becameCandle && cur.anim.color === GENERIC_DEFAULT_COLOR) cur.anim.color = CANDLE_DEFAULT_COLOR;
    if (patch.anim.speed != null && Number.isFinite(Number(patch.anim.speed))) cur.anim.speed = Math.max(1, Math.min(100, Number(patch.anim.speed)));
  }
  config.deviceModes[String(id).slice(0, 160)] = cur;
  lastWrite.clear();
  apply();
  return true;
}

// Now-playing album colour feed (client pushes the same hue used for the theme,
// plus an optional 2-3 colour palette for the per-LED gradient).
// Ignored when the musicAlbum effect is off, so the user toggle fully disables it.
function setAlbumColor(input, palette) {
  const c = fx.parseColorName(input);
  if (!c) return false;
  layers.album = c;            // always store the latest cover colour
  // Palette: validated hex list, capped at 3. Fewer than 2 usable colours →
  // null, i.e. the classic uniform behaviour.
  let pal = null;
  if (Array.isArray(palette)) {
    pal = palette.slice(0, 3).map(h => fx.parseColorName(h)).filter(Boolean);
    if (pal.length < 2) pal = null;
  }
  albumPalette = pal;
  lastWrite.clear();
  if (albumActive()) reconcileConnection(); // ensure a session when the album effect is on
  apply();
  return albumActive();
}
function clearAlbum() {
  if (layers.album == null && albumPalette == null) return;
  layers.album = null;
  albumPalette = null;
  lastWrite.clear();
  apply(); // apply() releases to iCUE when nothing else wants the LEDs
}

// Apply persisted/posted config; (dis)connect to match `enabled`.
function applyConfig(next) {
  if (!next || typeof next !== 'object') return;
  if (typeof next.enabled === 'boolean') config.enabled = next.enabled;
  if (typeof next.brightness === 'number') config.brightness = Math.max(0, Math.min(1, next.brightness));
  if (typeof next.pauseDuringGame === 'boolean') config.pauseDuringGame = next.pauseDuringGame;
  if (next.devices && typeof next.devices === 'object') config.devices = next.devices;
  if (next.effects && typeof next.effects === 'object') {
    if (typeof next.effects.temperature === 'boolean') config.effects.temperature = next.effects.temperature;
    if (typeof next.effects.volume === 'boolean') config.effects.volume = next.effects.volume;
    if (typeof next.effects.musicAlbum === 'boolean') config.effects.musicAlbum = next.effects.musicAlbum;
    for (const k of ['timer', 'notification', 'reminder', 'vitals']) {
      const e = next.effects[k];
      const cur = config.effects[k] || { enabled: true, color: '#ff0000', style: 'blink', durationMs: EVENT_DURATION_MS };
      if (typeof e === 'boolean') { config.effects[k] = { ...cur, enabled: e }; }
      else if (e && typeof e === 'object') {
        config.effects[k] = {
          enabled: typeof e.enabled === 'boolean' ? e.enabled : cur.enabled,
          color: typeof e.color === 'string' ? e.color : cur.color,
          style: ['blink', 'pulse', 'solid'].includes(e.style) ? e.style : cur.style,
          durationMs: clampEventDuration(e.durationMs, cur.durationMs || EVENT_DURATION_MS),
        };
      }
    }
  }
  // Restore the persisted manual colour (must run before the animation block so
  // "Fissa" picks it up via refreshAnimationLayer).
  if (typeof next.manualColor === 'string') {
    config.manualColor = next.manualColor;
    const c = next.manualColor ? fx.parseColorName(next.manualColor) : null;
    layers.override = c || null;
  }
  if (next.animation && typeof next.animation === 'object') {
    const a = next.animation;
    if (typeof a.style === 'string' && ANIM_STYLES.includes(a.style)) config.animation.style = a.style;
    if (typeof a.color === 'string') { const c = fx.parseColorName(a.color); if (c) config.animation.color = a.color; }
    if (a.speed != null && Number.isFinite(Number(a.speed))) config.animation.speed = Math.max(1, Math.min(100, Number(a.speed)));
    if (a.palette !== undefined) { const pal = sanitizePalette(a.palette); if (pal) config.animation.palette = pal; }
  }
  refreshAnimationLayer(); // sync the animation layer (incl. "Fissa" → manual colour)
  if (next.deviceModes && typeof next.deviceModes === 'object') {
    const dm = {};
    for (const [id, v] of Object.entries(next.deviceModes)) {
      if (!v || typeof v !== 'object') continue;
      const e = { mode: DEVICE_MODES.includes(v.mode) ? v.mode : 'follow' };
      if (typeof v.color === 'string' && fx.parseColorName(v.color)) e.color = v.color;
      if (v.anim && typeof v.anim === 'object') {
        e.anim = {
          style: PER_DEVICE_ANIM_STYLES.includes(v.anim.style) ? v.anim.style : 'cycle',
          color: (typeof v.anim.color === 'string' && fx.parseColorName(v.anim.color)) ? v.anim.color : '#1ed760',
          speed: Number.isFinite(Number(v.anim.speed)) ? Math.max(1, Math.min(100, Number(v.anim.speed))) : 50,
        };
      }
      dm[String(id).slice(0, 160)] = e;
    }
    config.deviceModes = dm;
  }
  if (next.providers && typeof next.providers === 'object') external.applyConfig(next.providers);
  if (next.accent && typeof next.accent === 'object') accent = next.accent;
  reconcileConnection(); // (dis)connect to match master + any enabled effect
  apply();
}

function setEffectEnabled(effect, enabled) {
  if (['temperature', 'volume', 'musicAlbum', 'timer'].includes(effect)) {
    config.effects[effect] = !!enabled;
    reconcileConnection(); // connect/disconnect to match the new effect state
    apply();
    return true;
  }
  return false;
}
function setEnabled(on) { applyConfig({ enabled: !!on }); }

// --- external providers (WLED, …): thin wrappers that repaint/persist after a
// change. Discovery + device management live in lighting-external. ---
async function scanExternal() { const r = await external.scan(); apply(); return r; }
async function addExternalDevice(providerId, host) { const d = await external.addDevice(providerId, host); if (d) apply(); return d; }
async function pairExternalDevice(providerId, host) { const r = await external.pairDevice(providerId, host); if (r && r.ok) apply(); return r; }
function removeExternalDevice(providerId, id) { const ok = external.removeDevice(providerId, id); apply(); return ok; }
function setExternalDeviceOptIn(providerId, id, on) { const ok = external.setDeviceOptIn(providerId, id, on); lastWrite.clear(); apply(); return ok; }
function getExternalStatus() { return external.getStatus(); }
function getExternalConfig() { return external.getConfig(); }
// Inject runtime hooks for integration-backed providers (Home Assistant): the
// shared HA client lives in server.js; its token/URL never enter this config.
function setExternalRuntime(providerId, hooks) { external.setRuntime(providerId, hooks); }

// Persistable runtime config (the `devices` opt-in map is kept as the raw
// { deviceId: bool } shape, unlike getStatus which projects it onto the device list).
function getConfig() {
  return {
    enabled: config.enabled,
    brightness: config.brightness,
    pauseDuringGame: config.pauseDuringGame,
    devices: { ...config.devices },
    effects: { ...config.effects },
    animation: { ...config.animation, palette: (config.animation.palette || []).slice() },
    manualColor: config.manualColor || '',
    deviceModes: JSON.parse(JSON.stringify(config.deviceModes)),
    providers: external.getConfig(),
  };
}

// Project a device's stored mode onto a flat shape for the UI.
function deviceModeOf(id) {
  const m = config.deviceModes[id];
  return {
    mode: (m && m.mode) || 'follow',
    modeColor: (m && m.color) || null,
    modeAnim: (m && m.anim) ? { ...m.anim } : null,
  };
}

function getStatus() {
  const providers = external.getStatus().providers;
  providers.forEach(p => (p.devices || []).forEach(d => Object.assign(d, deviceModeOf(d.id))));
  return {
    available: isAvailable(),
    connected,
    enabled: config.enabled,
    devices: getDevices().map(d => ({ ...d, optedIn: config.devices[d.id] !== false, ...deviceModeOf(d.id) })),
    effects: { ...config.effects },
    animation: { ...config.animation, palette: (config.animation.palette || []).slice() },
    manualColor: config.manualColor || '',
    brightness: config.brightness,
    pauseDuringGame: config.pauseDuringGame,
    providers,
    reason: lastError,
  };
}

module.exports = {
  connect, ensureConnected, disconnect, enumerate, boundedReenumerate, writeDevice, releaseAll, getDevices, isConnected, isAvailable, getLastError,
  getBatteryLevels,
  onSystem, onAudio, onStatus, onEvent,
  setManualColor, clearManual, setDeckReaction, clearDeckReaction, setAnimation, setDeviceMode, setAlbumColor, clearAlbum, applyConfig, setEffectEnabled, setEnabled, getStatus, getConfig,
  scanExternal, addExternalDevice, pairExternalDevice, removeExternalDevice, setExternalDeviceOptIn, getExternalStatus, getExternalConfig, setExternalRuntime,
  _fx: fx,
};
