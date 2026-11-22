'use strict';
// Writing colours to the devices through the iCUE SDK, and handing them back to iCUE.

const fx = require('./lighting-effects.js');
const external = require('./lighting-external.js');
const ledColors = require('./lighting-led-colors.js');
const native = require('../lighting-native/index.js');
const { bridge } = require('./bridge-state.js');
const { sdkCall, noteSdkFailure } = require('./sdk-call.js');
const { effectiveAlbum } = require('./paint-rules.js');
const pumpRing = require('./pump-ring.js');

const CDT_MOTHERBOARD = 0x200; // CorsairDeviceType::CDT_Motherboard

// Write a single uniform colour to a device (on-change only).
// Async so the koffi FFI call runs on a worker thread and never blocks the Node event loop.
async function writeDevice(deviceId, color) {
  const dev = paintDevices().find(d => d.id === deviceId);
  if (!dev || !sinkReady(dev)) return;
  const key = `${color.r},${color.g},${color.b}`;
  if (bridge.lastWrite.get(deviceId) === key) return; // unchanged → skip
  // A device whose layout never arrived has nothing to write to. Skipping keeps
  // it out of the on-change cache, so it repaints the moment a re-enumeration
  // fills in its LED ids.
  if (!dev.ledIds.length) return;
  // Cached only after the device confirmed the write.
  if (await pushLeds(dev, dev.ledIds.map(() => color))) bridge.lastWrite.set(deviceId, key);
}

// Paint a multi-stop gradient across the device's LEDs (album palette). Same
// write path and on-change skip as writeDevice; the gradient is recomputed only
// when the palette actually changed (the cache key encodes every stop). Static —
// no ticker, zero idle cost, exactly like the uniform path.
async function writeDeviceGradient(dev, palette) {
  if (!dev || !sinkReady(dev)) return;
  const key = 'grad:' + palette.map(c => `${c.r},${c.g},${c.b}`).join('|');
  if (bridge.lastWrite.get(dev.id) === key) return; // unchanged → skip
  if (!dev.ledIds.length) return; // no layout yet — see writeDevice()
  if (await pushLeds(dev, fx.paletteGradient(palette, dev.ledIds.length))) bridge.lastWrite.set(dev.id, key);
}

// Paint the current spatial-animation frame (wave/palette) across the device's
// LEDs. Same write path as the album gradient. The caller pre-computes the
// frame key (fx.animationFrameKey — the quantized phase/shift that DEFINES the
// frame) and checks it against bridge.lastWrite BEFORE building the per-LED array, so
// unchanged frames cost zero allocations.
async function writeDeviceAnimGradient(dev, stops, key) {
  if (!dev || !sinkReady(dev) || !stops || !stops.length) return;
  const colors = dev.ledIds.map((_, i) => stops[Math.min(i, stops.length - 1)]);
  if (await pushLeds(dev, colors)) bridge.lastWrite.set(dev.id, key);
}

// Paint the lighting map of a 'custom' device: each LED its own colour or effect,
// the LEDs nobody touched follow Xenon (`follow`, the colour every other device
// gets now; `under`, one colour per LED, when the rest shows a gradient or a wave). The
// on-change key is the frame itself, so a static map costs one write and a looping effect
// writes only when a LED actually changed.
async function writeDeviceCustom(dev, mode, follow, under = null) {
  if (!dev || !sinkReady(dev) || !dev.ledIds.length) return;
  const frame = ledColors.ledFrame(dev.ledIds, mode.leds, {
    follow, under, temperature: bridge.config.effects.temperature ? bridge.layers.base : null, album: effectiveAlbum(),
    pump: pumpRing.colours(bridge.accent), pumpSpin: pumpRing.spinPhase(), brightness: bridge.config.brightness, nowMs: Date.now(),
  });
  const key = 'custom:' + frame.map(c => (c ? `${c.r},${c.g},${c.b}` : '-')).join('|');
  if (bridge.lastWrite.get(dev.id) === key) return;
  if (await pushLeds(dev, frame)) bridge.lastWrite.set(dev.id, key);
}

// Where a device's colours go: the iCUE SDK, or a controller Xenon drives itself.
// colors[i] is the colour of dev.ledIds[i]. Returns true when the device took them.
async function pushLeds(dev, colors) {
  // A frame computed just before the PC went to sleep or off must not take the
  // lights back from their hardware.
  if (bridge.poweredDown) return false;
  try {
    if (dev.source === 'native') {
      native.write(dev, colors);   // handed over, never awaited (see lighting-native)
    } else {
      // A LED with no colour (null) is left to iCUE: alpha 0, as releaseAll() hands lights back.
      const arr = dev.ledIds.map((id, i) => (colors[i] ? { id, r: colors[i].r, g: colors[i].g, b: colors[i].b, a: 255 } : { id, r: 0, g: 0, b: 0, a: 0 }));
      await sdkCall(bridge.fns.setLedColors, 'CorsairSetLedColors', dev.id, arr.length, arr);
    }
    return true;
  } catch (e) {
    if (dev.source === 'native') bridge.lastError = e.message;
    else noteSdkFailure(e);
    return false;
  }
}

function sinkReady(dev) { return dev.source === 'native' ? native.owns(dev.id) : bridge.connected; }

// Every device this bridge paints per LED: the iCUE ones (while a session is up)
// and the native controllers. With Xenon driving the motherboard itself, the
// board iCUE reaches through a vendor plugin is left out, so the two never fight
// over the same LEDs.
function paintDevices() {
  const nativeList = native.devices();
  const icue = bridge.connected ? bridge.devices : [];
  if (!nativeList.length) return icue;
  return [...icue.filter(d => !(Number(d.type) & CDT_MOTHERBOARD)), ...nativeList];
}

// keepNative: the native controllers were already darkened (powerDown) and must
// not be handed back to the board's own effects.
async function releaseAll({ keepNative = false } = {}) {
  if (bridge.connected) {
    for (const dev of bridge.devices) {
      try {
        if (!dev.ledIds.length) continue;
        const arr = dev.ledIds.map(id => ({ id, r: 0, g: 0, b: 0, a: 0 }));
        // Same timeout guard as every other SDK call — a wedged iCUE service must
        // not stall the release path (apply() awaits it while holding bridge.applyInFlight).
        await sdkCall(bridge.fns.setLedColors, 'CorsairSetLedColors', dev.id, arr.length, arr);
      } catch (e) { noteSdkFailure(e); }
    }
  }
  try { external.release(); } catch { /* external is best-effort */ }
  // Native controllers go back to the board's own effects (what it showed before).
  if (!keepNative) {
    try { await native.release(); } catch (e) { bridge.lastError = e.message; }
  }
  bridge.lastWrite.clear();
  bridge.idleReleased = true;
}

function getDevices() {
  return paintDevices().map(d => ({
    id: d.id, model: d.model, type: d.type, ledCount: d.ledCount, segments: d.segments || [],
    source: d.source || 'icue', ...(d.source === 'native' ? { maker: d.maker, outputs: d.outputs } : {}),
  }));
}

module.exports = {
  CDT_MOTHERBOARD, writeDevice, writeDeviceGradient, writeDeviceAnimGradient, writeDeviceCustom,
  pushLeds, sinkReady, paintDevices, releaseAll, getDevices,
};
