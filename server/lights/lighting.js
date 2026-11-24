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
require('./lighting-external'); // non-iCUE providers (WLED, …)
require('./lighting-topology');  // which LEDs are which fan / pump / RAM stick
require('./lighting-led-colors'); // per-LED colours of the 'custom' device mode
const native = require('../lighting-native');      // motherboard RGB controllers Xenon drives itself over USB
require('./lighting-key-look');   // what a Deck key set: wins over music/temperature until switched off

const { bridge } = require('./bridge-state.js');
const { refreshAvailability, isAvailable } = require('./sdk-dll.js');
const { paint } = require('./paint-hook.js');

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
  // Ambient animation. 'none' = reactive-only (no render loop runs). style is any effect of
  // LightFx.LIGHTING or a name saved before it (solid, breathing, cycle, wave, palette: OLD_LIGHTING).
  // One that stands still paints once; one that moves runs a self-stopping ticker only while painting.
  // `palette` holds the user's 1–5 colours; reverse/size/glow/chain only when set (look-fields.js).
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

const { writeDevice, releaseAll, getDevices } = require('./sdk-write.js');

// A native frame is painted in the background: when it fails, forget what was
// sent so the next apply() paints that device again, and say why.
native.setWriteErrorHook((id, e) => { bridge.lastError = e.message; bridge.lastWrite.delete(id); });

const { disconnect } = require('./sdk-load.js');

const { getBatteryLevels } = require('./sdk-properties.js');

const {
  connect, ensureConnected, enumerate, boardsToWake, enumerationComplete,
} = require('./session.js');

const { boundedReenumerate } = require('./upkeep.js');

const {
  isConnected, getLastError, isLightsOut, getExternalStatus, getExternalConfig, getConfig,
  getStatus,
} = require('./status.js');

const { apply } = require('./paint.js');
const { powerDown, powerUp } = require('./power.js');

const { onSystem, onAudio, onStatus, onEvent } = require('./feeds.js');

paint.apply = apply;   // what the session's own steps (lights/paint-hook.js) repaint through

// A held controller (lighting-native/held.js: the LINK hub Airflow drives) came or went:
// paint everything at once, a still look included, as nothing else would ask for a frame.
require('../lighting-native/held.js').setChangeHook(() => { bridge.lastWrite.clear(); apply(); });

const {
  setManualColor, clearManual, setDeckReaction, clearDeckReaction, setAnimation, setDeviceMode,
  setPartLook, holdKeyLook, releaseKeyLook, setLightsOut, setAlbumColor, clearAlbum, setPumpRing,
} = require('./looks.js');

// Set the ambient animation (style/color/speed/palette). 'none' clears it.
// Validated (ANIM_STYLES); unknown styles are ignored. Refreshes the layer +
// (re)syncs the loop.

const {
  applyConfig, setNativeEnabled, setNativeLayout, setNativePreview, scanNative, setEffectEnabled,
  setEnabled, scanExternal, addExternalDevice, pairExternalDevice, removeExternalDevice,
  setExternalDeviceOptIn, setExternalRuntime, closeNative,
} = require('./configure.js');

module.exports = {
  connect, ensureConnected, disconnect, enumerate, boundedReenumerate, writeDevice, releaseAll, getDevices, isConnected, isAvailable, refreshAvailability, getLastError,
  getBatteryLevels,
  onSystem, onAudio, onStatus, onEvent,
  setManualColor, clearManual, setDeckReaction, clearDeckReaction, setAnimation, setDeviceMode, setAlbumColor, clearAlbum, setPumpRing, applyConfig, setEffectEnabled, setEnabled, getStatus, getConfig,
  scanExternal, addExternalDevice, pairExternalDevice, removeExternalDevice, setExternalDeviceOptIn, getExternalStatus, getExternalConfig, setExternalRuntime,
  setPartLook, holdKeyLook, releaseKeyLook, setLightsOut, isLightsOut, powerDown, powerUp, setNativeEnabled, setNativeLayout, setNativePreview, scanNative, setNativeChangeHook: native.setChangeHook, closeNative,
  _fx: fx,
  _boardsToWake: boardsToWake,
  _enumerationComplete: enumerationComplete, // pure predicate — unit-tested in lighting-enumeration.test.mjs
};
