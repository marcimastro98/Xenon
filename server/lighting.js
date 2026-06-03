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
  effects: {
    temperature: true,
    volume: true,
    musicAlbum: false,                             // OFF by default: opt-in, can drive LEDs even with the master off
    timer:        { enabled: true, color: '#ff0000', style: 'blink' },
    notification: { enabled: true, color: '#ff0000', style: 'blink' },
    reminder:     { enabled: true, color: '#ff0000', style: 'blink' },
  },
};
let accent = { r: 30, g: 215, b: 96 };           // updated from settings
let layers = { base: null, overlay: null, album: null, override: null };
let overlayUntil = 0;                            // ms timestamp the overlay expires
let lastVolume = null;                           // last seen speaker volume (for on-change flash)
let eventAnim = null;                            // { style, color, startMs, durationMs } while a flash plays
let eventTimer = null;                           // setInterval handle, exists only during a flash
let applyInFlight = false;                       // prevents concurrent apply() calls while an async LED write is in progress
const EVENT_DURATION_MS = 1800;
const EVENT_TICK_MS = 60;

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
    stateCb = koffi.register((_ctx, evt) => {
      let state = -1;
      try { state = koffi.decode(evt, 'CorsairSessionStateChanged').state; } catch (e) { lastError = 'state decode failed: ' + e.message; }
      const now = (state === CSS_CONNECTED);
      if (now && !connected) { connected = true; connecting = false; enumerate(); onConnected(); }
      else { connected = now; if (now) connecting = false; }
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

function enumerate() {
  try {
    const filter = { deviceTypeMask: -1 };
    const buf = Array(64).fill(null).map(() => ({}));
    const count = [0];
    fns.getDevices(filter, 64, buf, count);
    devices = [];
    for (let i = 0; i < count[0]; i++) {
      const d = buf[i];
      const pos = Array(d.ledCount).fill(null).map(() => ({}));
      const pc = [0];
      fns.getLedPositions(d.id, d.ledCount, pos, pc);
      devices.push({ id: d.id, model: d.model, type: d.type, ledCount: d.ledCount, ledIds: pos.slice(0, pc[0]).map(p => p.id) });
    }
  } catch (e) {
    lastError = 'enumerate failed: ' + e.message;
    devices = [];
  }
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
    await new Promise((resolve, reject) =>
      fns.setLedColors.async(deviceId, arr.length, arr, (err, _rc) => err ? reject(err) : resolve())
    );
    lastWrite.set(deviceId, key);
  } catch (e) { lastError = 'write failed: ' + e.message; }
}

// Release: hand control back to iCUE (alpha-0 transparent, confirmed in Task 1).
async function releaseAll() {
  if (!connected) return;
  for (const dev of devices) {
    try {
      const arr = dev.ledIds.map(id => ({ id, r: 0, g: 0, b: 0, a: 0 }));
      await new Promise((resolve, reject) =>
        fns.setLedColors.async(dev.id, arr.length, arr, (err, _rc) => err ? reject(err) : resolve())
      );
    } catch (e) { lastError = 'release failed: ' + e.message; }
  }
  lastWrite.clear();
}

function disconnect() {
  if (lib && connected) { try { fns.disconnect(); } catch { /* ignore */ } }
  if (koffi && stateCb) { try { koffi.unregister(stateCb); } catch { /* ignore */ } stateCb = null; }
  connected = false;
  connecting = false;
  lastWrite.clear();
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

// Decide whether the bridge should be painting right now. The master toggle OR an
// active album colour can each keep it live.
function active() {
  if (!connected) return false;
  if (!config.enabled && !albumActive()) return false;
  if (config.pauseDuringGame) { try { if (gameDetect.isGaming()) return false; } catch { /* ignore */ } }
  return true;
}

// Compute the final colour and push it to every opted-in device (on-change).
// Async because writeDevice is now async (koffi FFI call on worker thread).
// applyInFlight prevents concurrent writes if a previous apply() is still awaiting.
async function apply() {
  if (applyInFlight) return;
  applyInFlight = true;
  try {
    if (overlayUntil && Date.now() > overlayUntil) { layers.overlay = null; overlayUntil = 0; }
    if (!active()) { stopEvent(true); await releaseAll(); return; }

    const album = effectiveAlbum();

    // Album-only mode: the master bridge is off and the album effect is the sole
    // driver — paint just the cover colour, ignoring reactive layers and flashes.
    if (!config.enabled) {
      const color = fx.resolveColor({ album }, config.brightness);
      for (const dev of devices) {
        if (config.devices[dev.id] === false) continue; // opt-out
        await writeDevice(dev.id, color);
      }
      return;
    }

    // Master mode: full layer stack + event flashes.
    // Event flash (top priority, transient). Null = finished → drop it.
    let eventColor = null;
    if (eventAnim) {
      eventColor = fx.eventColorAt({ ...eventAnim, nowMs: Date.now() });
      if (eventColor === null) stopEvent(true);
    }

    // Until a reactive layer has data (e.g. just after enabling, before the first
    // system tick), fall back to the accent colour rather than painting black.
    const stack = { base: layers.base, overlay: layers.overlay, album, override: layers.override };
    const baseLayers = (stack.override || stack.overlay || stack.album || stack.base)
      ? stack
      : { base: accent, overlay: null, album: null, override: null };
    // eventColor wins by riding the top (override) slot of the resolve.
    const effective = eventColor ? { ...baseLayers, override: eventColor } : baseLayers;

    const color = fx.resolveColor(effective, config.brightness);
    for (const dev of devices) {
      if (config.devices[dev.id] === false) continue; // opt-out
      await writeDevice(dev.id, color);
    }
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
function onAudio(info) {
  // Flash the accent (scaled by level) only when the volume actually changes —
  // a brief visual feedback, not a periodic pulse on every audio refresh.
  if (info && info.volume != null) {
    const vol = Number(info.volume);
    if (config.effects.volume && lastVolume !== null && vol !== lastVolume) {
      layers.overlay = fx.volumeToColor(vol, accent);
      overlayUntil = Date.now() + 1200; // transient
    }
    lastVolume = vol;
  }
  apply();
}
function onStatus() { apply(); } // re-evaluate game-mode idle

// Start an event flash for the given type if its effect is enabled and we're
// actively painting. Drives a short self-cancelling animation loop.
function startEvent(type) {
  const cfg = config.effects[type];
  if (!cfg || typeof cfg !== 'object' || cfg.enabled === false) return;
  if (!active()) return;
  eventAnim = { style: cfg.style || 'blink', color: cfg.color || '#ff0000', startMs: Date.now(), durationMs: EVENT_DURATION_MS };
  if (!eventTimer) eventTimer = setInterval(() => apply(), EVENT_TICK_MS);
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
  if (['timer', 'notification', 'reminder'].includes(type)) startEvent(type);
}

// --- control surface (called from endpoints / AI) ---
function setManualColor(input) {
  const c = fx.parseColorName(input);
  if (!c) return false;
  layers.override = c;
  lastWrite.clear(); // force a write even if the colour equals the last one painted
  apply();
  return true;
}
function clearManual() { layers.override = null; lastWrite.clear(); apply(); }

// Now-playing album colour feed (client pushes the same hue used for the theme).
// Ignored when the musicAlbum effect is off, so the user toggle fully disables it.
function setAlbumColor(input) {
  const c = fx.parseColorName(input);
  if (!c) return false;
  layers.album = c;            // always store the latest cover colour
  lastWrite.clear();
  // Connect on demand so the album colour works even with the master toggle off —
  // but only when the effect is actually enabled (no silent takeover of iCUE).
  if (albumActive() && !connected) connect();
  apply();
  return albumActive();
}
function clearAlbum() {
  if (layers.album == null) return;
  layers.album = null;
  lastWrite.clear();
  // If the master is off, the album was the only reason we held the LEDs — hand
  // control back to iCUE. Otherwise just repaint the remaining layers.
  if (!config.enabled && connected) { releaseAll(); disconnect(); }
  else apply();
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
    for (const k of ['timer', 'notification', 'reminder']) {
      const e = next.effects[k];
      const cur = config.effects[k] || { enabled: true, color: '#ff0000', style: 'blink' };
      if (typeof e === 'boolean') { config.effects[k] = { ...cur, enabled: e }; }
      else if (e && typeof e === 'object') {
        config.effects[k] = {
          enabled: typeof e.enabled === 'boolean' ? e.enabled : cur.enabled,
          color: typeof e.color === 'string' ? e.color : cur.color,
          style: ['blink', 'pulse', 'solid'].includes(e.style) ? e.style : cur.style,
        };
      }
    }
  }
  if (next.accent && typeof next.accent === 'object') accent = next.accent;
  if (config.enabled && !connected) connect();
  // Keep the session alive when the master is off but the album effect is still
  // driving the LEDs; only hand back to iCUE when nothing wants them.
  if (!config.enabled && connected && !albumActive()) { releaseAll(); disconnect(); }
  // Master off but an album colour is pending and we're not connected yet → bring
  // the session up so album-only mode can paint (e.g. effect just re-enabled).
  else if (!config.enabled && !connected && albumActive()) connect();
  apply();
}

function setEffectEnabled(effect, enabled) {
  if (['temperature', 'volume', 'musicAlbum', 'timer'].includes(effect)) {
    config.effects[effect] = !!enabled;
    // Turning album off with the master off releases the LEDs back to iCUE.
    if (effect === 'musicAlbum' && !enabled && !config.enabled && connected) { releaseAll(); disconnect(); return true; }
    apply();
    return true;
  }
  return false;
}
function setEnabled(on) { applyConfig({ enabled: !!on }); }

// Persistable runtime config (the `devices` opt-in map is kept as the raw
// { deviceId: bool } shape, unlike getStatus which projects it onto the device list).
function getConfig() {
  return {
    enabled: config.enabled,
    brightness: config.brightness,
    pauseDuringGame: config.pauseDuringGame,
    devices: { ...config.devices },
    effects: { ...config.effects },
  };
}

function getStatus() {
  return {
    available: isAvailable(),
    connected,
    enabled: config.enabled,
    devices: getDevices().map(d => ({ ...d, optedIn: config.devices[d.id] !== false })),
    effects: { ...config.effects },
    brightness: config.brightness,
    pauseDuringGame: config.pauseDuringGame,
    reason: lastError,
  };
}

module.exports = {
  connect, ensureConnected, disconnect, enumerate, writeDevice, releaseAll, getDevices, isConnected, isAvailable, getLastError,
  onSystem, onAudio, onStatus, onEvent,
  setManualColor, clearManual, setAlbumColor, clearAlbum, applyConfig, setEffectEnabled, setEnabled, getStatus, getConfig, _fx: fx,
};
