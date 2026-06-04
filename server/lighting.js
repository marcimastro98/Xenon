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
    timer:        { enabled: false, color: '#ff0000', style: 'blink' },
    notification: { enabled: false, color: '#ff0000', style: 'blink' },
    reminder:     { enabled: false, color: '#ff0000', style: 'blink' },
  },
  // Ambient animation (whole-device uniform colour). 'none' = reactive-only (no
  // render loop runs). 'solid' is static (no loop). 'breathing'/'cycle' run a
  // light self-stopping ticker only while the bridge is actively painting.
  animation: { style: 'none', color: '#1ed760', speed: 50 },
  // Manual fixed colour (the "Colore manuale" picker). PERSISTED — restored on
  // restart. '' = none. Also feeds the "Fissa" animation.
  manualColor: '',
  // Per-device override (master mode only). deviceId → { mode, color?, anim? }.
  // mode: follow (use the dashboard colour) | color | animation | temperature |
  // album | off. Absent device = 'follow' (back-compatible).
  deviceModes: {},
};
const DEVICE_MODES = ['follow', 'color', 'animation', 'temperature', 'album', 'off'];
let accent = { r: 30, g: 215, b: 96 };           // updated from settings
let layers = { base: null, overlay: null, album: null, animation: null, override: null };
let overlayUntil = 0;                            // ms timestamp the overlay expires
let lastVolume = null;                           // last seen speaker volume (for on-change flash)
let eventAnim = null;                            // { style, color, startMs, durationMs } while a flash plays
let eventTimer = null;                           // setInterval handle, exists only during a flash
let deckReaction = null;                         // { style, colorHex } transient Deck LED reaction (never persisted)
let animTimer = null;                            // ambient-animation ticker; exists only while a dynamic animation paints
let applyInFlight = false;                       // prevents concurrent apply() calls while an async LED write is in progress
const EVENT_DURATION_MS = 1800;
const EVENT_TICK_MS = 60;
const ANIM_TICK_MS = 66;                         // ~15 fps; on-change guard makes most ticks a free no-op

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
    await withSdkTimeout(new Promise((resolve, reject) =>
      fns.setLedColors.async(deviceId, arr.length, arr, (err, _rc) => err ? reject(err) : resolve())
    ), 'CorsairSetLedColors');
    lastWrite.set(deviceId, key);
  } catch (e) { lastError = 'write failed: ' + e.message; }
}

// Release: hand control back to iCUE (alpha-0 transparent, confirmed in Task 1)
// and to every external provider (turn off / neutral).
async function releaseAll() {
  if (connected) {
    for (const dev of devices) {
      try {
        const arr = dev.ledIds.map(id => ({ id, r: 0, g: 0, b: 0, a: 0 }));
        await new Promise((resolve, reject) =>
          fns.setLedColors.async(dev.id, arr.length, arr, (err, _rc) => err ? reject(err) : resolve())
        );
      } catch (e) { lastError = 'release failed: ' + e.message; }
    }
  }
  try { external.release(); } catch { /* external is best-effort */ }
  lastWrite.clear();
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
  return config.enabled || !!e.temperature || !!e.musicAlbum
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
// sample for breathing/cycle, null for 'none'. Cheap (pure math).
function refreshAnimationLayer() {
  const a = config.animation || {};
  if (!a.style || a.style === 'none') { layers.animation = null; return; }
  // "Fissa" (solid) has no colour of its own — it reuses the manual colour set
  // above (or the accent when none is set), so the user picks the colour once.
  if (a.style === 'solid') { layers.animation = layers.override || accent; return; }
  layers.animation = fx.animationColorAt({ style: a.style, color: a.color, speed: a.speed, nowMs: Date.now() });
}

// Does any per-device override run a dynamic (looping) animation?
function anyDeviceAnimationDynamic() {
  for (const id of Object.keys(config.deviceModes)) {
    const m = config.deviceModes[id];
    if (m && m.mode === 'animation') {
      const s = (m.anim && m.anim.style) || 'cycle';
      if (s === 'breathing' || s === 'cycle') return true;
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
  const deckDynamic = !!deckReaction && deckReaction.style !== 'solid' && config.enabled; // only loops while the reaction is actually visible
  const dynamic = style === 'breathing' || style === 'cycle' || anyDeviceAnimationDynamic() || deckDynamic;
  const shouldRun = dynamic && active();
  if (shouldRun && !animTimer) animTimer = setInterval(tickAnimation, ANIM_TICK_MS);
  else if (!shouldRun && animTimer) { clearInterval(animTimer); animTimer = null; }
}

function tickAnimation() {
  refreshAnimationLayer();
  apply();
}

// Compute the final colour and push it to every opted-in device (on-change).
// Async because writeDevice is now async (koffi FFI call on worker thread).
// applyInFlight prevents concurrent writes if a previous apply() is still awaiting.
async function apply() {
  syncAnimationTicker(); // start/stop the ambient loop to match current state (cheap, idempotent)
  if (applyInFlight) return;
  applyInFlight = true;
  try {
    if (overlayUntil && Date.now() > overlayUntil) { layers.overlay = null; overlayUntil = 0; }
    if (!active()) { stopEvent(true); await releaseAll(); return; }

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
    // A Deck LED reaction overlays the reactive/ambient layers (only while the
    // master is on) but stays below an event flash. Transient — never persisted.
    const deckColor = config.enabled ? deckReactionColor() : null;
    const picked = eventColor
      || deckColor
      || effectiveAlbum()
      || (config.effects.temperature ? layers.base : null)
      || ambient
      || { r: 0, g: 0, b: 0 };
    const color = fx.applyBrightness(picked, config.brightness);

    const resolve = (id) => colorForDevice(id, color);

    // iCUE devices (only when an iCUE session is connected).
    if (connected) {
      for (const dev of devices) {
        if (config.devices[dev.id] === false) continue; // opt-out
        await writeDevice(dev.id, resolve(dev.id));
      }
    }
    // External providers (WLED/etc): independent of iCUE, non-blocking fan-out.
    external.writeWith(resolve);
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
  if (!connected && !external.hasDevices()) { if (isAvailable()) connect(); return; } // no sink yet — can't flash
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
  config.manualColor = '#' + [c.r, c.g, c.b].map(x => x.toString(16).padStart(2, '0')).join(''); // persisted
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
// default. Only visible while the master is on (a no-op otherwise).
function setDeckReaction(input, style) {
  const c = fx.parseColorName(input);
  if (!c) return false;
  deckReaction = {
    style: ['solid', 'breathing', 'cycle'].includes(style) ? style : 'solid',
    colorHex: '#' + [c.r, c.g, c.b].map(x => x.toString(16).padStart(2, '0')).join(''),
  };
  lastWrite.clear(); // force a repaint even if the colour equals the last one painted
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

// Set the ambient animation (style/color/speed). 'none' clears it. Validated;
// unknown styles are ignored. Refreshes the layer + (re)syncs the render loop.
const ANIM_STYLES = ['none', 'solid', 'breathing', 'cycle'];
function setAnimation(patch) {
  if (!patch || typeof patch !== 'object') return false;
  const cur = config.animation;
  if (typeof patch.style === 'string' && ANIM_STYLES.includes(patch.style)) cur.style = patch.style;
  if (typeof patch.color === 'string') { const c = fx.parseColorName(patch.color); if (c) cur.color = patch.color; }
  if (patch.speed != null && Number.isFinite(Number(patch.speed))) cur.speed = Math.max(1, Math.min(100, Number(patch.speed)));
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
    if (['solid', 'breathing', 'cycle'].includes(patch.anim.style)) cur.anim.style = patch.anim.style;
    if (typeof patch.anim.color === 'string') { const c = fx.parseColorName(patch.anim.color); if (c) cur.anim.color = patch.anim.color; }
    if (patch.anim.speed != null && Number.isFinite(Number(patch.anim.speed))) cur.anim.speed = Math.max(1, Math.min(100, Number(patch.anim.speed)));
  }
  config.deviceModes[String(id).slice(0, 160)] = cur;
  lastWrite.clear();
  apply();
  return true;
}

// Now-playing album colour feed (client pushes the same hue used for the theme).
// Ignored when the musicAlbum effect is off, so the user toggle fully disables it.
function setAlbumColor(input) {
  const c = fx.parseColorName(input);
  if (!c) return false;
  layers.album = c;            // always store the latest cover colour
  lastWrite.clear();
  if (albumActive()) reconcileConnection(); // ensure a session when the album effect is on
  apply();
  return albumActive();
}
function clearAlbum() {
  if (layers.album == null) return;
  layers.album = null;
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
          style: ['solid', 'breathing', 'cycle'].includes(v.anim.style) ? v.anim.style : 'cycle',
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

// Persistable runtime config (the `devices` opt-in map is kept as the raw
// { deviceId: bool } shape, unlike getStatus which projects it onto the device list).
function getConfig() {
  return {
    enabled: config.enabled,
    brightness: config.brightness,
    pauseDuringGame: config.pauseDuringGame,
    devices: { ...config.devices },
    effects: { ...config.effects },
    animation: { ...config.animation },
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
    animation: { ...config.animation },
    manualColor: config.manualColor || '',
    brightness: config.brightness,
    pauseDuringGame: config.pauseDuringGame,
    providers,
    reason: lastError,
  };
}

module.exports = {
  connect, ensureConnected, disconnect, enumerate, writeDevice, releaseAll, getDevices, isConnected, isAvailable, getLastError,
  onSystem, onAudio, onStatus, onEvent,
  setManualColor, clearManual, setDeckReaction, clearDeckReaction, setAnimation, setDeviceMode, setAlbumColor, clearAlbum, applyConfig, setEffectEnabled, setEnabled, getStatus, getConfig,
  scanExternal, addExternalDevice, pairExternalDevice, removeExternalDevice, setExternalDeviceOptIn, getExternalStatus, getExternalConfig,
  _fx: fx,
};
