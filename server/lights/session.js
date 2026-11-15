'use strict';
// The iCUE session: connect, wait for the SDK to say it is up, list the devices and their LEDs,
// wake a board that needs it. A repaint is asked through lights/paint-hook.js.

const topology = require('./lighting-topology.js');
const native = require('../lighting-native/index.js');
const { bridge } = require('./bridge-state.js');
const { paint } = require('./paint-hook.js');
const { wokenBoards, sdkCall, noteSdkFailure } = require('./sdk-call.js');
const { wantsPaint } = require('./paint-rules.js');
const { CDT_MOTHERBOARD } = require('./sdk-write.js');
const { loadLib } = require('./sdk-load.js');
const { channelLayout } = require('./sdk-properties.js');

const CSS_CONNECTED = 6; // CorsairSessionState::CSS_Connected (confirmed on hardware)

function connect() {
  if (bridge.connected || bridge.connecting) return true;
  if (!loadLib()) return false;
  try {
    bridge.connecting = true;
    bridge.partialEnumRetries = 0; // fresh session gets a fresh re-enumeration budget
    bridge.stateCb = bridge.koffi.register((_ctx, evt) => {
      let state = -1;
      try { state = bridge.koffi.decode(evt, 'CorsairSessionStateChanged').state; } catch (e) { bridge.lastError = 'state decode failed: ' + e.message; }
      const now = (state === CSS_CONNECTED);
      if (now && !bridge.connected) {
        bridge.connected = true; bridge.connecting = false;
        wokenBoards.clear();
        // Defer ALL SDK calls out of this callback. The SDK invokes us from its
        // own worker thread and blocks that thread until we return; making a
        // synchronous SDK call here (enumerate → CorsairGetDevices) would wait on
        // that same thread → mutual deadlock that freezes the whole Node event
        // loop. setImmediate lets the callback return first, freeing the SDK
        // thread, before we enumerate (now itself async/non-blocking).
        setImmediate(async () => { await enumerate(); onConnected(); });
      } else {
        bridge.connected = now; if (now) bridge.connecting = false;
      }
    }, bridge.koffi.pointer('CorsairStateCb'));
    const rc = bridge.fns.connect(bridge.stateCb, null);
    if (rc !== 0) { bridge.lastError = 'CorsairConnect rc=' + rc; bridge.connecting = false; return false; }
    // Connection completes asynchronously; the callback flips `connected`.
    return true;
  } catch (e) {
    bridge.lastError = 'connect failed: ' + e.message;
    bridge.connecting = false;
    return false;
  }
}

// Connect (if needed) and wait until the session reaches Connected or times out.
// Uses async sleeps so koffi's callback can be marshalled to the JS thread —
// a busy-spin would starve it and never connect.
async function ensureConnected(timeoutMs = 1800) {
  if (bridge.connected) return true;
  if (!bridge.config.enabled) return false;
  connect();
  const start = Date.now();
  while (!bridge.connected && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 50));
  }
  return bridge.connected; // the state callback already ran enumerate()/onConnected()
}

// Invoked once the session reaches Connected: paint immediately so the bridge
// reflects the latest data without waiting for the next SSE tick.
function onConnected() { paint.apply(); }

// Enumerate connected iCUE devices and their LED layouts.
// CRITICAL: every FFI call uses koffi's `.async` form so it runs on a worker
// thread, never the event-loop thread. A synchronous CorsairGetDevices /
// CorsairGetLedPositions here would block (and, when called from inside the SDK
// state callback, deadlock) the entire Node process — see connect()'s callback.
// A concurrent caller JOINS the running enumeration — it must never be handed an
// instantly-resolved promise. maybeReenumerate() chains apply() onto whatever this
// returns, and apply() calls straight back into here: with an already-settled
// promise that chain becomes a self-sustaining MICROTASK loop, which starves the
// event loop, which is the only thing that can deliver the worker-thread result the
// real enumeration is awaiting. The process then spins at 100% CPU and never serves
// another request — it cannot recover on its own. Returning the in-flight promise
// keeps the chain waiting on real work, so bridge.lastDeviceScan is always stamped before
// the next rescan test runs.
function enumerate() {
  if (!bridge.fns) { bridge.devices = []; return Promise.resolve(); }
  if (bridge.enumerating) return bridge.enumeratePending;
  bridge.enumerating = true;
  bridge.enumeratePending = enumerateOnce();
  return bridge.enumeratePending;
}

async function enumerateOnce() {
  try {
    const filter = { deviceTypeMask: -1 };
    const buf = Array(64).fill(null).map(() => ({}));
    const count = [0];
    await sdkCall(bridge.fns.getDevices, 'CorsairGetDevices', filter, 64, buf, count);
    const list = [];
    for (let i = 0; i < count[0]; i++) {
      const d = buf[i];
      const pos = Array(d.ledCount).fill(null).map(() => ({}));
      const pc = [0];
      // One device failing to report its layout must not abandon the whole
      // enumeration: it lands with an empty ledIds, which enumerationComplete()
      // treats as incomplete and boundedReenumerate() retries.
      try {
        await sdkCall(bridge.fns.getLedPositions, 'CorsairGetLedPositions', d.id, d.ledCount, pos, pc);
      } catch (e) { bridge.lastError = e.message; pc[0] = 0; }
      const leds = pos.slice(0, pc[0]);
      const channels = await channelLayout(d.id, d.channelCount, leds.length);
      list.push({
        id: d.id, model: d.model, type: d.type, ledCount: d.ledCount, ledIds: leds.map(p => p.id),
        segments: topology.buildSegments({ type: d.type, leds, channels }),
      });
    }
    bridge.devices = list;
    wakeVendorBoard();
    // A complete enumeration (every device answered with real LED ids) clears the
    // partial-retry budget, so a later 0-LED reappearance (e.g. an iCUE LINK
    // hot-replug) gets its own fresh round of retries.
    if (enumerationComplete(list)) bridge.partialEnumRetries = 0;
  } catch (e) {
    noteSdkFailure(e);
    bridge.devices = [];
  } finally {
    // Stamped on failure too, so a wedged SDK can't turn the slow rescan into a
    // per-tick retry (the fast partial-retry path below stays throttled on its own).
    bridge.lastDeviceScan = Date.now();
    bridge.enumerating = false;
    bridge.enumeratePending = null;
  }
}

// A motherboard reaching us through iCUE may need its chip woken before it takes
// colours (see Fusion2Controller.wake). Once per appearance: after a boot, a new
// iCUE session or a wake from sleep. A board Xenon was told to leave alone is left
// alone, and so is any board that has no Fusion 2 chip (wakeForVendor finds none).
function boardsToWake(list, optOuts, woken) {
  return list.filter(d => (Number(d.type) & CDT_MOTHERBOARD) && d.ledIds.length && optOuts[d.id] !== false && !woken.has(d.id));
}

function wakeVendorBoard() {
  const fresh = boardsToWake(bridge.devices, bridge.config.devices, wokenBoards);
  if (!fresh.length || !wantsPaint()) return;
  for (const d of fresh) wokenBoards.add(d.id);
  native.wakeForVendor()
    .then((woken) => { if (woken) { bridge.lastWrite.clear(); paint.apply(); } })
    .catch((e) => { bridge.lastError = e.message; for (const d of fresh) wokenBoards.delete(d.id); });
}

// The connected session's device list looks INCOMPLETE — either empty, or a device
// enumerated with zero LEDs. enumerate() runs once from the connect callback; if
// iCUE hadn't finished populating its device list yet (common right after a PC boot
// — the SDK reports Connected before the devices are registered) we'd otherwise be
// stuck. Two shapes of "not ready":
//   - EMPTY list: nothing enumerated at all → keep retrying indefinitely.
//   - PARTIAL list: a device enumerated without usable LED ids. The iCUE LINK
//     System Hub reports no LEDs until iCUE finishes registering the cooler/fans
//     behind it, so the RAM (a direct device) lights up while the AIO + fans stay
//     dark. Retry, but BOUND it — a hub with no RGB children legitimately has no
//     LEDs, so we must not re-enumerate forever.
//
// Completeness is judged on `ledIds` (what CorsairGetLedPositions actually
// returned, and the array every write iterates), NOT on `ledCount` from
// CorsairDeviceInfo. A device can declare 20 LEDs and hand back zero positions:
// that passed the old ledCount test, so the list looked ready while every write
// to it built an empty colour array and painted nothing.
function enumerationComplete(list) {
  return list.length > 0 && list.every(d => d.ledIds.length > 0);
}

module.exports = {
  CSS_CONNECTED, connect, ensureConnected, onConnected, enumerate, enumerateOnce, boardsToWake,
  wakeVendorBoard, enumerationComplete,
};
