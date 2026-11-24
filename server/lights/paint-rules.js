'use strict';
// The rules that say whether the bridge paints at all, and which colour a device gets.

const fx = require('./lighting-effects.js');
const external = require('./lighting-external.js');
const ledColors = require('./lighting-led-colors.js');
const native = require('../lighting-native/index.js');
const keyLook = require('./lighting-key-look.js');
const { bridge } = require('./bridge-state.js');
const gameDetect = require('../performance/gamedetect.js');
const pumpRing = require('./pump-ring.js');
const fxLook = require('./fx-look.js');

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

// Does anything want the LEDs painted right now? The pump ring alone is enough: it then
// paints just its own LEDs (paint.js) and leaves every other light to its software.
function wantsPaint() {
  return lightsWanted() || ringWanted();
}

// The pump screen's ring has colours of its own to show (lights/pump-ring.js).
function ringWanted() {
  if (bridge.poweredDown || gamingPaused()) return false;
  return pumpRing.colours(bridge.accent) != null;
}

// Intent: does anything want every light painted? Each effect is INDEPENDENT
// of the master toggle — the master only adds the steady "fixed" illumination
// (manual colour / animation / accent). Temperature, album, volume flash and the
// event flashes each light up on their own when enabled, even with the master OFF.
function lightsWanted() {
  if (bridge.poweredDown) return false;
  if (keyLook.isOut()) return true;                                   // a key switched every light off
  if (gamingPaused()) return false;
  if (bridge.config.enabled) return true;                                    // fixed illumination
  if (keyLook.isHeld()) return true;                                  // a Deck key set the lights
  if (bridge.config.effects.temperature && bridge.layers.base) return true;         // steady CPU-temp colour
  if (albumActive()) return true;                                     // steady album colour
  if (pumpRing.leadColour()) return true;                             // the pump screen leads every light
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
    || pumpRing.colours(bridge.accent) != null
    || (e.timer && e.timer.enabled !== false)
    || (e.notification && e.notification.enabled !== false)
    || (e.reminder && e.reminder.enabled !== false);
}

// --- ambient animation ticker -------------------------------------------------
// The animation layer as one colour now (what a light of a single colour shows; per-LED
// devices draw the whole effect in paint.js), null for 'none'. Cheap (pure maths).
function refreshAnimationLayer() {
  const a = bridge.config.animation || {};
  if (!a.style || a.style === 'none') { bridge.layers.animation = null; return; }
  // "Fissa" (solid, as saved before the effect list) has no colour of its own: it reuses the
  // manual colour set above (or the accent when none is set), so the user picks the colour once.
  if (a.style === 'solid') { bridge.layers.animation = bridge.layers.override || bridge.accent; return; }
  bridge.layers.animation = fxLook.colourAt(a);
}

// The global look moves by itself (the ticker runs for it).
const animationMoves = () => { const a = bridge.config.animation; return !!a && a.style !== 'solid' && fxLook.moves(a); };

// Does any per-device override run a dynamic (looping) animation?
function anyDeviceAnimationDynamic() {
  for (const id of Object.keys(bridge.config.deviceModes)) {
    const m = bridge.config.deviceModes[id];
    if (m && m.mode === 'animation' && fxLook.moves(m.anim || { style: 'cycle' })) return true;
    if (m && m.mode === 'custom' && ledColors.hasDynamicLeds(m.leds)) return true;
  }
  return false;
}

// An effect of the lights follows the sound: the sound is read for it (audio/levels-wanted.js).
function lightsHear() {
  if (bridge.config.enabled && fxLook.hears(bridge.config.animation || {})) return true;
  return Object.values(bridge.config.deviceModes).some((m) => m && ((m.mode === 'animation' && fxLook.hears(m.anim || {}))
    || (m.mode === 'custom' && Object.values(m.leds || {}).some((v) => v && typeof v === 'object' && fxLook.hears(v)))));
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
    const c = fxLook.colourAt(m.anim || { style: 'cycle' });
    return c ? fx.applyBrightness(c, bridge.config.brightness) : globalColor;
  }
  return globalColor;
}

// Live colour for the deck reaction: static for 'solid', sampled for breathing/cycle.
function deckReactionColor() {
  if (!bridge.deckReaction) return null;
  if (bridge.deckReaction.style === 'solid') return fx.parseColorName(bridge.deckReaction.colorHex);
  return fxLook.colourAt({ style: bridge.deckReaction.style, color: bridge.deckReaction.colorHex, speed: 50 });
}

module.exports = {
  animationMoves, effectiveAlbum, albumActive, gamingPaused, wantsPaint, lightsWanted, active, shouldConnect,
  refreshAnimationLayer, anyDeviceAnimationDynamic, lightsHear, colorForDevice, deckReactionColor,
};
