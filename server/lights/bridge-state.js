'use strict';
// What the lighting bridge knows right now: its link to iCUE, the devices it found, the layers
// of colour and its timers.

const bridge = {
  // Memoized: isAvailable() sits on the apply() tick (every 60ms during an event
  // flash) and on /api/lighting/status, and the probe now reads two directories.
  // The path can't change under a running process except right after the installer
  // drops the DLL, so a short TTL picks that up without a restart while keeping the
  // hot path free of synchronous FS.
  dllProbe: { at: 0, path: null },
  koffi: null,
  lib: null,
  fns: null,
  stateCb: null,
  connected: false,
  connecting: false,
  lastError: null,
  dllPath: null,
  devices: [],                 // [{ id, model, type, ledCount, ledIds:[uint32] }]
  lastWrite: new Map(),        // deviceId → "r,g,b" of the last colour written (on-change guard)
  config: undefined, // given its first value where the engine loads
  accent: { r: 30, g: 215, b: 96 },           // updated from settings
  layers: { base: null, overlay: null, album: null, animation: null, override: null },
  albumPalette: null,                         // [{r,g,b},…] 2-3 cover colours for the per-LED gradient (null = uniform)
  overlayUntil: 0,                            // ms timestamp the overlay expires
  lastVolume: null,                           // last seen speaker volume (for on-change flash)
  eventAnim: null,                            // { style, color, startMs, durationMs } while a flash plays
  eventTimer: null,                           // setInterval handle, exists only during a flash
  deckReaction: null,                         // { style, colorHex } transient Deck LED reaction (never persisted)
  animTimer: null,                            // ambient-animation ticker; exists only while a dynamic animation paints
  applyInFlight: false,                       // prevents concurrent apply() calls while an async LED write is in progress
  applyAgain: false,                          // a change arrived mid-apply: run once more when it ends
  lastConnectAttempt: 0,                      // throttle for the apply()-driven on-demand (re)connect
  lastEnumerate: 0,                            // throttle for the apply()-driven re-enumerate when connected-but-empty
  lastDeviceScan: 0,                           // last enumerate(), stamped at fire time AND on completion (success or not) — throttles the slow rescan below
  enumerating: false,                          // guards against overlapping enumerate() calls (connect callback + retry)
  enumeratePending: null,                      // the in-flight enumerate() promise, so a concurrent caller joins it instead of getting an instantly-resolved one (see enumerate())
  partialEnumRetries: 0,                        // bounded retries when a device enumerated with 0 LEDs (iCUE LINK boot race); reset on a complete enumeration / fresh connect
  poweredDown: false,                         // the PC is shutting down / sleeping: the lights are back with their hardware
  powerHoldTimer: null,
  // Release: hand control back to iCUE (alpha-0 transparent, confirmed in Task 1)
  // and to every external provider (restore / turn off / neutral).
  // `bridge.idleReleased` makes the idle apply() path release ONCE per painting session:
  // without it every 7s system tick would re-send the off command, which on the
  // room-light providers (Home Assistant, Yeelight, Hue) would keep switching off
  // lights the user just turned back on from their app or wall switch.
  idleReleased: false,
  // Only the pump ring is painting (paint.js paintRingAlone): every other light was handed back.
  ringAlone: false,
};

module.exports = { bridge };
