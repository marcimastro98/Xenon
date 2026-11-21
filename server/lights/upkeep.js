'use strict';
// What keeps the session and the device list true between two paints: connect or let go as the
// settings ask, the animation ticker, a reconnect not sooner than the pause, a device list
// asked again a bounded number of times.

const external = require('./lighting-external.js');
const native = require('../lighting-native/index.js');
const keyLook = require('./lighting-key-look.js');
const pumpRing = require('./pump-ring.js');
const { bridge } = require('./bridge-state.js');
const { isAvailable } = require('./sdk-dll.js');
const { paint } = require('./paint-hook.js');
const {
  DYNAMIC_ANIM_STYLES, wantsPaint, active, shouldConnect, refreshAnimationLayer,
  anyDeviceAnimationDynamic,
} = require('./paint-rules.js');
const { releaseAll } = require('./sdk-write.js');
const { disconnect } = require('./sdk-load.js');
const { connect, enumerate, enumerationComplete } = require('./session.js');

const MAX_PARTIAL_ENUM_RETRIES = 6;                // ~12s at CONNECT_RETRY_MS — long enough for iCUE to register LINK cooler/fans after a cold boot, bounded so a genuinely LED-less hub doesn't re-enumerate forever

const ANIM_TICK_MS = 66;                         // ~15 fps; on-change guard makes most ticks a free no-op
const CONNECT_RETRY_MS = 2000;                   // min gap between on-demand reconnect attempts while an effect wants paint
const DEVICE_RESCAN_MS = 30000;                  // slow rescan for devices that registered after the initial enumeration (one SDK call, only while painting)

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
  const dynamic = DYNAMIC_ANIM_STYLES.includes(style) || anyDeviceAnimationDynamic() || deckDynamic || pumpRing.pulsing();
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

module.exports = {
  MAX_PARTIAL_ENUM_RETRIES, ANIM_TICK_MS, CONNECT_RETRY_MS, DEVICE_RESCAN_MS, reconcileConnection,
  syncAnimationTicker, tickAnimation, maybeReconnectForPaint, enumerationIncomplete,
  boundedReenumerate, maybeReenumerate,
};
