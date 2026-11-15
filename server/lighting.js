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

const fx = require('./lighting-effects');
const external = require('./lighting-external'); // non-iCUE providers (WLED, …)
require('./lighting-topology');  // which LEDs are which fan / pump / RAM stick
const ledColors = require('./lighting-led-colors'); // per-LED colours of the 'custom' device mode
const native = require('./lighting-native');      // motherboard RGB controllers Xenon drives itself over USB
const keyLook = require('./lighting-key-look');   // what a Deck key set: wins over music/temperature until switched off

const { bridge } = require('./lights/bridge-state.js');
const { refreshAvailability, isAvailable } = require('./lights/sdk-dll.js');
const { paint } = require('./lights/paint-hook.js');
const { wokenBoards } = require('./lights/sdk-call.js');

bridge.config = {
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
  // album | off | custom. Absent device = 'follow' (back-compatible). 'custom'
  // is the lighting map: `leds` { luid: '#hex' | { style, color, speed } } holds
  // what each LED shows, the rest follow Xenon (lighting-led-colors.js).
  deviceModes: {},
};
const {
  DYNAMIC_ANIM_STYLES, effectiveAlbum, albumActive, gamingPaused, wantsPaint, active, shouldConnect,
  refreshAnimationLayer, anyDeviceAnimationDynamic, colorForDevice, deckReactionColor,
} = require('./lights/paint-rules.js');
const {
  DEVICE_MODES, ANIM_STYLES, PER_DEVICE_ANIM_STYLES, EVENT_DURATION_MS, clampEventDuration,
  OFF_COLOR, sanitizePalette, GENERIC_DEFAULT_COLOR, CANDLE_DEFAULT_COLOR, deviceLeds,
} = require('./lights/look-values.js');

const {
  writeDevice, writeDeviceGradient, writeDeviceAnimGradient, writeDeviceCustom, paintDevices,
  releaseAll, getDevices,
} = require('./lights/sdk-write.js');

// A native frame is painted in the background: when it fails, forget what was
// sent so the next apply() paints that device again, and say why.
native.setWriteErrorHook((id, e) => { bridge.lastError = e.message; bridge.lastWrite.delete(id); });
const MAX_PARTIAL_ENUM_RETRIES = 6;                // ~12s at CONNECT_RETRY_MS — long enough for iCUE to register LINK cooler/fans after a cold boot, bounded so a genuinely LED-less hub doesn't re-enumerate forever
const EVENT_TICK_MS = 60;
const ANIM_TICK_MS = 66;                         // ~15 fps; on-change guard makes most ticks a free no-op
const CONNECT_RETRY_MS = 2000;                   // min gap between on-demand reconnect attempts while an effect wants paint
const DEVICE_RESCAN_MS = 30000;                  // slow rescan for devices that registered after the initial enumeration (one SDK call, only while painting)
const POWER_HOLD_MS = 60000;                     // painting resumes by itself if the PC did not go off after all (a cancelled shutdown)

const { disconnect } = require('./lights/sdk-load.js');

const { getBatteryLevels } = require('./lights/sdk-properties.js');

const {
  connect, ensureConnected, enumerate, boardsToWake, wakeVendorBoard, enumerationComplete,
} = require('./lights/session.js');

const {
  isConnected, getLastError, isLightsOut, getExternalStatus, getExternalConfig, getConfig,
  getStatus,
} = require('./lights/status.js');

// Bring the iCUE session up / tear it down to match shouldConnect(). Called after
// any config change. Disconnect hands the LEDs back to iCUE.
function reconcileConnection() {
  if (shouldConnect()) { if (!bridge.connected && !bridge.connecting && isAvailable()) connect(); }
  else if (bridge.connected) { releaseAll(); disconnect(); }
}

// Start/stop the render loop to match state. The loop exists ONLY while a dynamic
// animation (breathing/cycle) is actively painting somewhere — global OR a
// per-device override. Idle cost is therefore zero. Idempotent.
function syncAnimationTicker() {
  const style = bridge.config.animation && bridge.config.animation.style;
  const deckDynamic = !!bridge.deckReaction && bridge.deckReaction.style !== 'solid'; // master-independent: loops whenever the reaction is active
  const dynamic = DYNAMIC_ANIM_STYLES.includes(style) || anyDeviceAnimationDynamic() || deckDynamic;
  const shouldRun = dynamic && active() && !keyLook.isOut();
  if (shouldRun && !bridge.animTimer) bridge.animTimer = setInterval(tickAnimation, ANIM_TICK_MS);
  else if (!shouldRun && bridge.animTimer) { clearInterval(bridge.animTimer); bridge.animTimer = null; }
}

function tickAnimation() {
  refreshAnimationLayer();
  paint.apply();
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
  if (bridge.connected || bridge.connecting) return;
  if (!wantsPaint() || external.hasDevices() || native.hasDevices() || !isAvailable()) return;
  if (Date.now() - bridge.lastConnectAttempt < CONNECT_RETRY_MS) return;
  bridge.lastConnectAttempt = Date.now();
  connect();
}

function enumerationIncomplete() {
  return bridge.connected && !enumerationComplete(bridge.devices);
}

// Throttled, bounded re-enumeration shared by the apply() tick and the status
// endpoint. Returns the enumerate() promise when it fires, else undefined.
// Fire-and-forget safe: enumerate is async (worker thread), never blocks here.
function boundedReenumerate() {
  if (!bridge.connected) return;
  const now = Date.now();
  // Slow rescan. Neither test above can see a device that never appeared at all:
  // a list holding only the RAM is "complete" by every measure while the iCUE LINK
  // hub — registered seconds later on a slower boot path, because the server
  // starts before iCUE finishes coming up — is simply absent, and the initial
  // enumerate() from the connect callback is the only one that ever ran. That is
  // the empirically-proven "the radiator never lights up until I restart the
  // server" bug. Rescanning on a slow cadence also picks up genuine hot-plugs.
  // Stamped HERE as well as in enumerate()'s finally: the stamp must land even on
  // the paths that leave enumerate() before its try/finally (no `fns`, or joining
  // an enumeration already in flight). Otherwise the rescan test stays true on every
  // tick and this branch re-fires forever — the fast partial-retry path below has
  // its own throttle, this one had none. Cadence therefore runs from the start of a
  // scan; the finally re-stamps at completion, which only ever pushes it later.
  if (now - bridge.lastDeviceScan >= DEVICE_RESCAN_MS) { bridge.lastEnumerate = now; bridge.lastDeviceScan = now; return enumerate(); }
  if (!enumerationIncomplete()) return;
  // Empty keeps retrying; a partial list is capped so a genuinely LED-less device
  // doesn't trigger perpetual re-enumeration.
  if (bridge.devices.length > 0 && bridge.partialEnumRetries >= MAX_PARTIAL_ENUM_RETRIES) return;
  if (now - bridge.lastEnumerate < CONNECT_RETRY_MS) return;
  bridge.lastEnumerate = now;
  if (bridge.devices.length > 0) bridge.partialEnumRetries++;
  return enumerate();
}

// apply()-driven re-enumeration: gated on wantsPaint() so an idle bridge stays at
// zero cost. Repaints once the freshly-enumerated devices show up.
function maybeReenumerate() {
  if (!wantsPaint()) return;
  const p = boundedReenumerate();
  if (p) p.then(() => { if (bridge.devices.length) paint.apply(); }).catch(() => { /* lastError set inside */ });
}

// Compute the final colour and push it to every opted-in device (on-change).
// Async because writeDevice is now async (koffi FFI call on worker thread).
// bridge.applyInFlight prevents concurrent writes if a previous apply() is still awaiting.
async function apply() {
  syncAnimationTicker(); // start/stop the ambient loop to match current state (cheap, idempotent)
  maybeReconnectForPaint(); // bring a sink up on demand when an effect wants paint but none is live yet
  maybeReenumerate();       // recover from a connected-but-empty device list (boot race)
  // A change that lands mid-apply is not dropped: it runs right after.
  if (bridge.applyInFlight) { bridge.applyAgain = true; return; }
  bridge.applyInFlight = true;
  bridge.applyAgain = false;
  try {
    if (bridge.overlayUntil && Date.now() > bridge.overlayUntil) { bridge.layers.overlay = null; bridge.overlayUntil = 0; }
    if (!active()) {
      // Don't cancel a still-live event flash just because no sink is up YET: an
      // on-demand flash (Bit's rage / any effect with no held session) arms before
      // iCUE finishes connecting, and dropping it here is what made the flash never
      // appear. Keep it armed until it paints (sink connects) or its window elapses.
      if (!bridge.eventAnim || fx.eventColorAt({ ...bridge.eventAnim, nowMs: Date.now() }) === null) stopEvent(true);
      if (!bridge.idleReleased) await releaseAll();
      return;
    }
    bridge.idleReleased = false; // painting again — the next idle transition releases once

    // "Lights off" from a key: every light dark, the Lighting page map included.
    if (keyLook.isOut()) {
      for (const dev of paintDevices()) {
        if (bridge.config.devices[dev.id] !== false) await writeDevice(dev.id, OFF_COLOR);
      }
      external.writeWith(() => OFF_COLOR);
      return;
    }

    // Event flash (transient, top priority). Null = finished → drop it.
    let eventColor = null;
    if (bridge.eventAnim) {
      eventColor = fx.eventColorAt({ ...bridge.eventAnim, nowMs: Date.now() });
      if (eventColor === null) stopEvent(true);
    }

    // Priority (top → bottom): event flash > album (music) > CPU temperature >
    // ambient. The reactive effects (album, temperature) OVERRIDE the fixed base,
    // so the album colour shows while music plays and falls back to the fixed
    // colour when it stops. The ambient (animation / manual colour / accent) is
    // the master's steady "fixed illumination" and only exists when master is on.
    // What a Deck key set shows as is: no music or temperature colour on top.
    const keyHeld = keyLook.isHeld();
    const ambient = bridge.config.enabled || keyHeld ? (bridge.layers.animation || bridge.layers.override || bridge.accent) : null;
    // A Deck LED reaction overlays the reactive/ambient layers but stays below an
    // event flash. Like every other effect it is INDEPENDENT of the master toggle
    // (a per-key reaction is itself an explicit opt-in), so it fires even with the
    // master off. Transient — never persisted.
    const deckColor = deckReactionColor();
    const albumCol = keyHeld ? null : effectiveAlbum();
    const picked = eventColor
      || deckColor
      || albumCol
      || (bridge.config.effects.temperature && !keyHeld ? bridge.layers.base : null)
      || ambient
      || { r: 0, g: 0, b: 0 };
    const color = fx.applyBrightness(picked, bridge.config.brightness);

    const resolve = (id) => colorForDevice(id, color);

    // Album palette gradient: when the cover supplied 2-3 colours, devices that
    // are showing the album colour get them spread across their LEDs instead of
    // a single uniform tint. Transient flashes (event/Deck) still take the whole
    // device, and per-device fixed modes are untouched.
    const gradientPal = bridge.albumPalette
      ? bridge.albumPalette.map(c => fx.applyBrightness(c, bridge.config.brightness))
      : null;
    const globalIsAlbum = !eventColor && !deckColor && picked === albumCol;
    const wantsGradient = (id) => {
      if (!gradientPal) return false;
      const m = bridge.config.deviceModes[id];
      const mode = (m && m.mode) ? m.mode : 'follow';
      return (mode === 'follow' && globalIsAlbum) || (mode === 'album' && !!bridge.layers.album);
    };

    // Spatial ambient animation (wave/palette): when the global colour IS the
    // animation layer, per-LED-capable devices (iCUE) paint the full spread for
    // this frame instead of the uniform sample. Mirrors the album-gradient
    // branch; external providers keep the uniform colour so their per-write
    // HTTP/UDP cost stays bounded. Computed once per apply(), shared by every
    // device (LED counts differ → sampled per device below).
    const animCfg = bridge.config.animation || {};
    const animNow = Date.now();
    const globalIsAnim = !eventColor && !deckColor && picked != null && picked === bridge.layers.animation
      && fx.isSpatialAnimation(animCfg.style);
    const wantsAnimGradient = (id) => {
      if (!globalIsAnim) return false;
      const m = bridge.config.deviceModes[id];
      return !m || !m.mode || m.mode === 'follow';
    };
    const animOpts = { style: animCfg.style, color: animCfg.color, speed: animCfg.speed, palette: animCfg.palette, nowMs: animNow };

    // Per-LED devices: iCUE (while a session is up) and the native controllers.
    for (const dev of paintDevices()) {
      if (bridge.config.devices[dev.id] === false) continue; // opt-out
      const dm = bridge.config.deviceModes[dev.id];
      // An event flash or a Deck reaction takes the whole device, map or not.
      const keyParts = !eventColor && !deckColor ? keyLook.partsOf(dev.id) : null;
      if (keyParts) { await writeDeviceCustom(dev, { leds: { ...deviceLeds(dev, dm), ...keyParts } }, color); continue; }
      if (dm && dm.mode === 'custom' && !eventColor && !deckColor) { await writeDeviceCustom(dev, dm, color); continue; }
      if (wantsGradient(dev.id)) { await writeDeviceGradient(dev, gradientPal); continue; }
      if (wantsAnimGradient(dev.id)) {
        // Frame identity (quantized phase/shift + brightness) checked BEFORE
        // building the per-LED array: unchanged frames cost zero allocations.
        const frameKey = `anim:${animCfg.style}:${fx.animationFrameKey(animOpts, dev.ledIds.length)}:${Math.round(bridge.config.brightness * 64)}`;
        if (bridge.lastWrite.get(dev.id) === frameKey) continue;
        const stops = fx.animationGradientAt(animOpts, dev.ledIds.length);
        if (stops) {
          await writeDeviceAnimGradient(dev, stops.map(c => fx.applyBrightness(c, bridge.config.brightness)), frameKey);
          continue;
        }
      }
      await writeDevice(dev.id, resolve(dev.id));
    }
    // External providers (WLED/Hue/…): independent of iCUE, non-blocking fan-out.
    // With an album palette, per-LED-capable providers (WLED strips, Hue bulbs
    // via the bridge) paint the gradient; the rest spread the cover colours
    // across their devices (one stop per lamp).
    external.writeWith(resolve, gradientPal ? (id) => (wantsGradient(id) ? gradientPal : null) : null);
  } finally {
    bridge.applyInFlight = false;
    if (bridge.applyAgain) { bridge.applyAgain = false; apply(); }
  }
}
paint.apply = apply;   // what the session's own steps (lights/paint-hook.js) repaint through

// --- data feeds (called from server.js on existing SSE intervals) ---
function onSystem(info) {
  if (bridge.config.effects.temperature && info && info.cpuTemp != null) {
    bridge.layers.base = fx.tempToColor(Number(info.cpuTemp));
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
  const cfg = bridge.config.effects[type];
  if (!cfg || typeof cfg !== 'object' || cfg.enabled === false) return;
  if (gamingPaused()) return;
  // Arm the flash FIRST, then ensure a sink. If none is live yet (e.g. Bit's rage
  // flash on a bridge that isn't holding a session — 'vitals' is deliberately not in
  // shouldConnect(), so it must come up on demand), maybeReconnectForPaint() brings
  // iCUE up on the apply() ticks and the armed flash paints once connected. The old
  // early-return here dropped the flash entirely whenever no session was already up —
  // which is exactly why the LEDs never reacted when a vital hit zero.
  bridge.eventAnim = { style: cfg.style || 'blink', color: cfg.color || '#ff0000', startMs: Date.now(), durationMs: clampEventDuration(cfg.durationMs, EVENT_DURATION_MS) };
  if (!bridge.eventTimer) bridge.eventTimer = setInterval(() => apply(), EVENT_TICK_MS);
  if (!bridge.connected && !external.hasDevices() && isAvailable()) connect();
  apply();
}

// Stop any running flash. `silent` skips the final repaint (used inside apply()).
function stopEvent(silent) {
  bridge.eventAnim = null;
  if (bridge.eventTimer) { clearInterval(bridge.eventTimer); bridge.eventTimer = null; }
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
  bridge.layers.override = c;
  bridge.config.manualColor = fx.rgbToHex(c); // persisted
  bridge.lastWrite.clear(); // force a write even if the colour equals the last one painted
  refreshAnimationLayer(); // keep "Fissa" (solid) in sync — it reuses the manual colour
  apply();
  return true;
}
function clearManual() { bridge.layers.override = null; bridge.config.manualColor = ''; bridge.lastWrite.clear(); refreshAnimationLayer(); apply(); }

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
  bridge.deckReaction = {
    style: ['solid', 'breathing', 'cycle'].includes(style) ? style : 'solid',
    colorHex: fx.rgbToHex(c),
  };
  bridge.lastWrite.clear(); // force a repaint even if the colour equals the last one painted
  // Master-independent: if nothing else is holding a sink (master off, all effects
  // off), bring up iCUE on demand so the reaction can paint — mirrors startEvent().
  // onConnected() re-applies once the session is up, so the reaction isn't lost.
  if (!bridge.connected && !external.hasDevices() && isAvailable()) connect();
  apply();           // apply() → syncAnimationTicker starts the loop for breathing/cycle
  return true;
}
function clearDeckReaction() {
  if (!bridge.deckReaction) return;
  bridge.deckReaction = null;
  bridge.lastWrite.clear();
  apply();           // composite falls back to the user's configured lighting; ticker self-stops
}

// Set the ambient animation (style/color/speed/palette). 'none' clears it.
// Validated (ANIM_STYLES); unknown styles are ignored. Refreshes the layer +
// (re)syncs the loop.

function setAnimation(patch) {
  if (!patch || typeof patch !== 'object') return false;
  const cur = bridge.config.animation;
  const becameCandle = patch.style === 'candle' && cur.style !== 'candle';
  if (typeof patch.style === 'string' && ANIM_STYLES.includes(patch.style)) cur.style = patch.style;
  if (typeof patch.color === 'string') { const c = fx.parseColorName(patch.color); if (c) cur.color = patch.color; }
  if (becameCandle && cur.color === GENERIC_DEFAULT_COLOR) cur.color = CANDLE_DEFAULT_COLOR;
  if (patch.speed != null && Number.isFinite(Number(patch.speed))) cur.speed = Math.max(1, Math.min(100, Number(patch.speed)));
  if (patch.palette !== undefined) { const pal = sanitizePalette(patch.palette); if (pal) cur.palette = pal; }
  bridge.lastWrite.clear();
  refreshAnimationLayer();
  apply();
  return true;
}

// Set a per-device override (mode + optional colour/animation). 'follow' restores
// the dashboard colour for that device. Validated; repaints immediately.
function setDeviceMode(id, patch) {
  if (!id || !patch || typeof patch !== 'object') return false;
  const cur = bridge.config.deviceModes[id] || { mode: 'follow' };
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
  if (patch.clearLeds === true) cur.leds = {};
  if (patch.leds !== undefined) {
    cur.leds = ledColors.mergeLedColors(cur.leds, patch.leds);
    // Every LED handed back to Xenon: the device follows Xenon again, instead of
    // sitting in "per part" with no part set.
    if (cur.mode === 'custom' && !Object.keys(cur.leds).length) cur.mode = 'follow';
  }
  bridge.config.deviceModes[String(id).slice(0, 160)] = cur;
  bridge.lastWrite.clear();
  apply();
  return true;
}

// One part of a device's map (a fan, the pump, a strip) gets its own look, or
// gives it back (null): what the Deck and the AI do. `part` is the index in the
// device's segments. It lasts until the lights are switched off from a key
// (keyLook) and never touches the map saved in the Lighting page.
function setPartLook(id, part, look) {
  const dev = paintDevices().find(d => d.id === id);
  const seg = dev && Array.isArray(dev.segments) ? dev.segments[part] : null;
  if (!seg || !Array.isArray(seg.ledIds) || !seg.ledIds.length) return false;
  const value = look === null ? null : ledColors.normalizeLedValue(look);
  if (look !== null && !value) return false;
  keyLook.setPart(id, seg.ledIds, value);
  bridge.lastWrite.delete(id);
  reconcileConnection();
  apply();
  return true;
}

// A key set a colour or an effect: show it as is until the lights go off.
// wholeRig: the colour or effect is for every light, so parts an earlier key
// coloured follow it again.
function holdKeyLook(opts) {
  keyLook.hold(opts);
  bridge.lastWrite.clear();
  reconcileConnection();
  apply();
}

// The lights were switched off (or set back to automatic) from a key.
function releaseKeyLook() {
  if (!keyLook.release()) return;
  bridge.lastWrite.clear();
  reconcileConnection();
  apply();
}

// "Lights off" from a key (true): every light dark, over the map, the music and
// the effects. false switches them back on to what they showed.
function setLightsOut(on) {
  if (on) keyLook.release();
  if (!keyLook.setOut(on) && !on) return;
  bridge.lastWrite.clear();
  reconcileConnection();
  apply();
}

// The PC is about to shut down, restart, sign out or sleep. Hand every light
// back to its own hardware while this process still runs: a controller left in
// Xenon's direct mode keeps its last frame on standby power, lit (and flickering)
// with the PC off. Nothing is painted again until powerUp(), which the wake from
// sleep calls, or POWER_HOLD_MS later when a shutdown was cancelled.
async function powerDown() {
  bridge.poweredDown = true;
  syncAnimationTicker();
  clearTimeout(bridge.powerHoldTimer);
  bridge.powerHoldTimer = setTimeout(powerUp, POWER_HOLD_MS);
  if (bridge.powerHoldTimer.unref) bridge.powerHoldTimer.unref();
  try { await native.powerDown(); } catch (e) { bridge.lastError = e.message; }
  await releaseAll({ keepNative: true });
}

function powerUp() {
  clearTimeout(bridge.powerHoldTimer);
  bridge.powerHoldTimer = null;
  if (!bridge.poweredDown) return;
  bridge.poweredDown = false;
  native.resume();
  wokenBoards.clear();
  wakeVendorBoard();
  bridge.lastWrite.clear();
  apply();
}

// Now-playing album colour feed (client pushes the same hue used for the theme,
// plus an optional 2-3 colour palette for the per-LED gradient).
// Ignored when the musicAlbum effect is off, so the user toggle fully disables it.
function setAlbumColor(input, palette) {
  const c = fx.parseColorName(input);
  if (!c) return false;
  bridge.layers.album = c;            // always store the latest cover colour
  // Palette: validated hex list, capped at 3. Fewer than 2 usable colours →
  // null, i.e. the classic uniform behaviour.
  let pal = null;
  if (Array.isArray(palette)) {
    pal = palette.slice(0, 3).map(h => fx.parseColorName(h)).filter(Boolean);
    if (pal.length < 2) pal = null;
  }
  bridge.albumPalette = pal;
  bridge.lastWrite.clear();
  if (albumActive()) reconcileConnection(); // ensure a session when the album effect is on
  apply();
  return albumActive();
}
function clearAlbum() {
  if (bridge.layers.album == null && bridge.albumPalette == null) return;
  bridge.layers.album = null;
  bridge.albumPalette = null;
  bridge.lastWrite.clear();
  apply(); // apply() releases to iCUE when nothing else wants the LEDs
}

// Apply persisted/posted config; (dis)connect to match `enabled`.
function applyConfig(next) {
  if (!next || typeof next !== 'object') return;
  if (typeof next.enabled === 'boolean') bridge.config.enabled = next.enabled;
  if (next.enabled === true) keyLook.setOut(false);   // switching the lights on in Settings ends a key's "lights off"
  else if (next.enabled === false && next.lightsOut === true) keyLook.setOut(true);   // saved dark by a key: still dark after a restart
  if (typeof next.brightness === 'number') bridge.config.brightness = Math.max(0, Math.min(1, next.brightness));
  if (typeof next.pauseDuringGame === 'boolean') bridge.config.pauseDuringGame = next.pauseDuringGame;
  if (next.devices && typeof next.devices === 'object') bridge.config.devices = next.devices;
  if (next.effects && typeof next.effects === 'object') {
    if (typeof next.effects.temperature === 'boolean') bridge.config.effects.temperature = next.effects.temperature;
    if (typeof next.effects.volume === 'boolean') bridge.config.effects.volume = next.effects.volume;
    if (typeof next.effects.musicAlbum === 'boolean') bridge.config.effects.musicAlbum = next.effects.musicAlbum;
    for (const k of ['timer', 'notification', 'reminder', 'vitals']) {
      const e = next.effects[k];
      const cur = bridge.config.effects[k] || { enabled: true, color: '#ff0000', style: 'blink', durationMs: EVENT_DURATION_MS };
      if (typeof e === 'boolean') { bridge.config.effects[k] = { ...cur, enabled: e }; }
      else if (e && typeof e === 'object') {
        bridge.config.effects[k] = {
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
    bridge.config.manualColor = next.manualColor;
    const c = next.manualColor ? fx.parseColorName(next.manualColor) : null;
    bridge.layers.override = c || null;
  }
  if (next.animation && typeof next.animation === 'object') {
    const a = next.animation;
    if (typeof a.style === 'string' && ANIM_STYLES.includes(a.style)) bridge.config.animation.style = a.style;
    if (typeof a.color === 'string') { const c = fx.parseColorName(a.color); if (c) bridge.config.animation.color = a.color; }
    if (a.speed != null && Number.isFinite(Number(a.speed))) bridge.config.animation.speed = Math.max(1, Math.min(100, Number(a.speed)));
    if (a.palette !== undefined) { const pal = sanitizePalette(a.palette); if (pal) bridge.config.animation.palette = pal; }
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
      if (v.leds !== undefined) e.leds = ledColors.normalizeLedColors(v.leds);
      dm[String(id).slice(0, 160)] = e;
    }
    bridge.config.deviceModes = dm;
  }
  if (next.providers && typeof next.providers === 'object') external.applyConfig(next.providers);
  if (next.native && typeof next.native === 'object') configureNative(next.native);
  if (next.accent && typeof next.accent === 'object') bridge.accent = next.accent;
  reconcileConnection(); // (dis)connect to match master + any enabled effect
  apply();
}

// Switching native control on opens the controllers (a few hundred ms over USB,
// more with a Gen2 scan): repaint once they are there.
function configureNative(next) {
  const enabled = typeof next.enabled === 'boolean' ? next.enabled : undefined;
  bridge.lastWrite.clear();
  native.configure({ enabled, layouts: next.layouts, scanned: next.scanned })
    .catch((e) => { bridge.lastError = e.message; })
    .then(() => { bridge.lastWrite.clear(); apply(); });
}

function setNativeEnabled(on) { configureNative({ enabled: !!on }); }

// One output's layout from the guided setup (null = forget it and set it up again).
function setNativeLayout(id, zone, layout) {
  if (!native.setLayout(id, zone, layout)) return false;
  bridge.lastWrite.clear();
  apply();
  return true;
}

// The guided setup lights part of one output; opts null ends the preview.
async function setNativePreview(id, output, opts) {
  if (opts === null) { native.clearPreview(); bridge.lastWrite.clear(); apply(); return true; }
  return native.setPreview(id, output, opts);
}

async function scanNative() {
  await native.stop();
  await native.start({ rescan: true });
  bridge.lastWrite.clear();
  apply();
  return native.status();
}

function setEffectEnabled(effect, enabled) {
  if (['temperature', 'volume', 'musicAlbum', 'timer'].includes(effect)) {
    bridge.config.effects[effect] = !!enabled;
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
function setExternalDeviceOptIn(providerId, id, on) { const ok = external.setDeviceOptIn(providerId, id, on); bridge.lastWrite.clear(); apply(); return ok; }
// Inject runtime hooks for integration-backed providers (Home Assistant): the
// shared HA client lives in server.js; its token/URL never enter this config.
function setExternalRuntime(providerId, hooks) { external.setRuntime(providerId, hooks); }

module.exports = {
  connect, ensureConnected, disconnect, enumerate, boundedReenumerate, writeDevice, releaseAll, getDevices, isConnected, isAvailable, refreshAvailability, getLastError,
  getBatteryLevels,
  onSystem, onAudio, onStatus, onEvent,
  setManualColor, clearManual, setDeckReaction, clearDeckReaction, setAnimation, setDeviceMode, setAlbumColor, clearAlbum, applyConfig, setEffectEnabled, setEnabled, getStatus, getConfig,
  scanExternal, addExternalDevice, pairExternalDevice, removeExternalDevice, setExternalDeviceOptIn, getExternalStatus, getExternalConfig, setExternalRuntime,
  setPartLook, holdKeyLook, releaseKeyLook, setLightsOut, isLightsOut, powerDown, powerUp, setNativeEnabled, setNativeLayout, setNativePreview, scanNative, setNativeChangeHook: native.setChangeHook, closeNative: native.stop,
  _fx: fx,
  _boardsToWake: boardsToWake,
  _enumerationComplete: enumerationComplete, // pure predicate — unit-tested in lighting-enumeration.test.mjs
};
