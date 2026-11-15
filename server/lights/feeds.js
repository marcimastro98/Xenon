'use strict';
// What the engine feeds the lights with: system readings, the audio level, the status, and an
// event that flashes for a moment.

const fx = require('../lighting-effects.js');
const external = require('../lighting-external.js');
const { bridge } = require('./bridge-state.js');
const { isAvailable } = require('./sdk-dll.js');
const { gamingPaused } = require('./paint-rules.js');
const { EVENT_DURATION_MS, clampEventDuration } = require('./look-values.js');
const { connect } = require('./session.js');
const { apply } = require('./paint.js');

const EVENT_TICK_MS = 60;

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

// Public event entry point (timer server-side; reminder/notification via endpoint).
function onEvent(type) {
  if (['timer', 'notification', 'reminder', 'vitals'].includes(type)) startEvent(type);
}

module.exports = { EVENT_TICK_MS, onSystem, onAudio, onStatus, startEvent, onEvent };
