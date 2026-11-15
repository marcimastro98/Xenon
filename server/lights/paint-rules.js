'use strict';
// The rules that say whether the bridge paints at all, and which colour a device gets.

const fx = require('./lighting-effects.js');
const external = require('./lighting-external.js');
const ledColors = require('./lighting-led-colors.js');
const native = require('../lighting-native/index.js');
const keyLook = require('./lighting-key-look.js');
const { bridge } = require('./bridge-state.js');
const gameDetect = require('../gamedetect.js');

// Single source for the animation-style lists (keep the client mirrors in
// lighting-page.js / settings.js aligned). Every style except none/solid loops →
// drives the shared self-stopping ticker. Per-device excludes 'palette' (its
// colour list lives on the global animation only) and 'wave' (per-device renders
// uniform, which would be indistinguishable from 'cycle' — offering it there
// would just be a confusing duplicate).
const DYNAMIC_ANIM_STYLES = ['breathing', 'cycle', 'wave', 'aurora', 'candle', 'palette'];

// The album colour, gated by its effect toggle. `layers.album` always holds the
// last pushed cover colour (so toggling the effect on shows it without waiting
// for a re-push); this returns it only when the effect is enabled.
function effectiveAlbum() {
  return bridge.config.effects.musicAlbum !== false ? bridge.layers.album : null;
}

// True when the album effect alone wants the LEDs, independent of the master
// toggle — this is what lets "Album → LED" drive the lights on its own.
function albumActive() {
  return effectiveAlbum() != null;
}

// Paused because a game is running (and the user opted into pausing).
function gamingPaused() {
  if (!bridge.config.pauseDuringGame) return false;
  try { return gameDetect.isGaming(); } catch { return false; }
}

// Intent: does anything want the LEDs painted right now? Each effect is INDEPENDENT
// of the master toggle — the master only adds the steady "fixed" illumination
// (manual colour / animation / accent). Temperature, album, volume flash and the
// event flashes each light up on their own when enabled, even with the master OFF.
function wantsPaint() {
  if (bridge.poweredDown) return false;
  if (keyLook.isOut()) return true;                                   // a key switched every light off
  if (gamingPaused()) return false;
  if (bridge.config.enabled) return true;                                    // fixed illumination
  if (keyLook.isHeld()) return true;                                  // a Deck key set the lights
  if (bridge.config.effects.temperature && bridge.layers.base) return true;         // steady CPU-temp colour
  if (albumActive()) return true;                                     // steady album colour
  if (bridge.config.effects.volume && bridge.layers.overlay && (!bridge.overlayUntil || Date.now() <= bridge.overlayUntil)) return true; // volume flash window
  if (bridge.eventAnim) return true;                                         // a timer/notification/reminder flash is playing
  if (bridge.deckReaction) return true;                                      // a Deck key LED reaction is active
  return false;
}

// Are we actually painting somewhere? True when something wants paint AND we have
// a live sink — either an iCUE session or at least one external device. This lets
// the bridge drive WLED/etc even with no iCUE installed.
function active() {
  return wantsPaint() && (bridge.connected || external.hasDevices() || native.hasDevices());
}

// Should we hold an iCUE session at all? True if the master OR ANY effect is on —
// so e.g. a timer flash can fire instantly even with the master off. When idle
// (nothing to paint) apply() releases via alpha-0, so iCUE's own lighting shows.
function shouldConnect() {
  const e = bridge.config.effects;
  return bridge.config.enabled || !!bridge.deckReaction || keyLook.isHeld() || keyLook.isOut() || !!e.temperature || !!e.musicAlbum
    || (e.timer && e.timer.enabled !== false)
    || (e.notification && e.notification.enabled !== false)
    || (e.reminder && e.reminder.enabled !== false);
}

// --- ambient animation ticker -------------------------------------------------
// Recompute the animation layer for the current style. Static for 'solid', live
// sample for the dynamic styles, null for 'none'. Cheap (pure math).
function refreshAnimationLayer() {
  const a = bridge.config.animation || {};
  if (!a.style || a.style === 'none') { bridge.layers.animation = null; return; }
  // "Fissa" (solid) has no colour of its own — it reuses the manual colour set
  // above (or the accent when none is set), so the user picks the colour once.
  if (a.style === 'solid') { bridge.layers.animation = bridge.layers.override || bridge.accent; return; }
  bridge.layers.animation = fx.animationColorAt({ style: a.style, color: a.color, speed: a.speed, palette: a.palette, nowMs: Date.now() });
}

// Does any per-device override run a dynamic (looping) animation?
function anyDeviceAnimationDynamic() {
  for (const id of Object.keys(bridge.config.deviceModes)) {
    const m = bridge.config.deviceModes[id];
    if (m && m.mode === 'animation') {
      const s = (m.anim && m.anim.style) || 'cycle';
      if (DYNAMIC_ANIM_STYLES.includes(s)) return true;
    }
    if (m && m.mode === 'custom' && ledColors.hasDynamicLeds(m.leds)) return true;
  }
  return false;
}

// Resolve the colour for a single device given the global colour. 'follow' (and
// unknown) returns the global colour; other modes compute their own. Returns a
// brightness-applied {r,g,b}; 'off' returns black.
function colorForDevice(id, globalColor) {
  const m = bridge.config.deviceModes[id];
  if (!m || !m.mode || m.mode === 'follow') return globalColor;
  if (m.mode === 'off') return { r: 0, g: 0, b: 0 };
  // A custom device without a map (an external provider) follows Xenon, like
  // the LEDs of a map nobody painted.
  if (m.mode === 'custom') return globalColor;
  if (m.mode === 'color') return fx.applyBrightness(fx.parseColorName(m.color || '') || bridge.accent, bridge.config.brightness);
  if (m.mode === 'temperature') return bridge.layers.base ? fx.applyBrightness(bridge.layers.base, bridge.config.brightness) : globalColor;
  if (m.mode === 'album') return bridge.layers.album ? fx.applyBrightness(bridge.layers.album, bridge.config.brightness) : globalColor;
  if (m.mode === 'animation') {
    const a = m.anim || {};
    const c = fx.animationColorAt({ style: a.style || 'cycle', color: a.color || '#1ed760', speed: a.speed || 50, nowMs: Date.now() });
    return c ? fx.applyBrightness(c, bridge.config.brightness) : globalColor;
  }
  return globalColor;
}

// Live colour for the deck reaction: static for 'solid', sampled for breathing/cycle.
function deckReactionColor() {
  if (!bridge.deckReaction) return null;
  if (bridge.deckReaction.style === 'solid') return fx.parseColorName(bridge.deckReaction.colorHex);
  return fx.animationColorAt({ style: bridge.deckReaction.style, color: bridge.deckReaction.colorHex, speed: 50, nowMs: Date.now() });
}

module.exports = {
  DYNAMIC_ANIM_STYLES, effectiveAlbum, albumActive, gamingPaused, wantsPaint, active, shouldConnect,
  refreshAnimationLayer, anyDeviceAnimationDynamic, colorForDevice, deckReactionColor,
};
