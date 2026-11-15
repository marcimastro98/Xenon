'use strict';
// The setters of what the lights show: a manual colour, a Deck reaction, an animation, a
// device's mode, a part's look, a Deck key's look, lights out, the album colour.

const fx = require('./lighting-effects.js');
const external = require('./lighting-external.js');
const ledColors = require('./lighting-led-colors.js');
const keyLook = require('./lighting-key-look.js');
const { bridge } = require('./bridge-state.js');
const { isAvailable } = require('./sdk-dll.js');
const { albumActive, refreshAnimationLayer } = require('./paint-rules.js');
const {
  DEVICE_MODES, ANIM_STYLES, PER_DEVICE_ANIM_STYLES, sanitizePalette, GENERIC_DEFAULT_COLOR,
  CANDLE_DEFAULT_COLOR,
} = require('./look-values.js');
const { paintDevices } = require('./sdk-write.js');
const { connect } = require('./session.js');
const { reconcileConnection } = require('./upkeep.js');
const { apply } = require('./paint.js');

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

module.exports = {
  setManualColor, clearManual, setDeckReaction, clearDeckReaction, setAnimation, setDeviceMode,
  setPartLook, holdKeyLook, releaseKeyLook, setLightsOut, setAlbumColor, clearAlbum,
};
