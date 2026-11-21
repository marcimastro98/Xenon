'use strict';
// One repaint of every light from what the bridge holds now, and the end of an event flash,
// which repaints.

const fx = require('./lighting-effects.js');
const external = require('./lighting-external.js');
const keyLook = require('./lighting-key-look.js');
const { bridge } = require('./bridge-state.js');
const { effectiveAlbum, active, lightsWanted, colorForDevice, deckReactionColor } = require('./paint-rules.js');
const pumpRing = require('./pump-ring.js');
const { OFF_COLOR, deviceLeds } = require('./look-values.js');
const {
  writeDevice, writeDeviceGradient, writeDeviceAnimGradient, writeDeviceCustom, paintDevices,
  releaseAll,
} = require('./sdk-write.js');
const { syncAnimationTicker, maybeReconnectForPaint, maybeReenumerate } = require('./upkeep.js');

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
    if (!lightsWanted()) { await paintRingAlone(); return; }
    if (bridge.ringAlone) { bridge.ringAlone = false; bridge.lastWrite.clear(); }

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
      || (keyHeld ? null : pumpRing.leadColour())
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

    // The pump ring's LEDs show the pump screen, under a flash, a Deck reaction or a key's look.
    const ringOn = !eventColor && !deckColor && !keyHeld && pumpRing.colours(bridge.accent) != null;
    // What the rest of a device holding the ring or a key's parts shows: the album gradient
    // or the wave it shows without them, so the fans beside a pump keep moving.
    const underOf = (dev) => {
      if (wantsGradient(dev.id)) return fx.paletteGradient(gradientPal, dev.ledIds.length);
      const stops = wantsAnimGradient(dev.id) ? fx.animationGradientAt(animOpts, dev.ledIds.length) : null;
      return stops ? dev.ledIds.map((_, i) => fx.applyBrightness(stops[Math.min(i, stops.length - 1)], bridge.config.brightness)) : null;
    };

    // Per-LED devices: iCUE (while a session is up) and the native controllers.
    for (const dev of paintDevices()) {
      if (bridge.config.devices[dev.id] === false) continue; // opt-out
      const dm = bridge.config.deviceModes[dev.id];
      // An event flash or a Deck reaction takes the whole device, map or not.
      const keyParts = !eventColor && !deckColor ? keyLook.partsOf(dev.id) : null;
      const ringLeds = ringOn ? pumpRing.ledsOf(dev) : null;
      if (keyParts || ringLeds) { await writeDeviceCustom(dev, { leds: { ...deviceLeds(dev, dm), ...ringLeds, ...keyParts } }, color, underOf(dev)); continue; }
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

// Only the pump ring wants the lights: every other light goes back to its own software
// (released once on the way in), and the iCUE devices holding a pump paint just its LEDs,
// the rest of each left to iCUE (pump-ring.js ledsOf).
async function paintRingAlone() {
  if (!bridge.ringAlone) {
    await releaseAll();
    bridge.ringAlone = true;
    bridge.idleReleased = false;
  }
  for (const dev of paintDevices()) {
    if (bridge.config.devices[dev.id] === false) continue;
    const leds = pumpRing.ledsOf(dev);
    if (leds) await writeDeviceCustom(dev, { leds }, null);
  }
}

// Stop any running flash. `silent` skips the final repaint (used inside apply()).
function stopEvent(silent) {
  bridge.eventAnim = null;
  if (bridge.eventTimer) { clearInterval(bridge.eventTimer); bridge.eventTimer = null; }
  if (!silent) apply();
}

module.exports = { apply, stopEvent };
