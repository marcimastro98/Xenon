'use strict';
// What the lights are doing now, as the pages and the tools read it.

const external = require('./lighting-external.js');
const native = require('../lighting-native/index.js');
const { probe: boardProbe } = require('../lighting-native/board-probe.js');
const keyLook = require('./lighting-key-look.js');
const pumpRing = require('./pump-ring.js');
const { bridge } = require('./bridge-state.js');
const { isAvailable } = require('./sdk-dll.js');
const { getDevices } = require('./sdk-write.js');
const { shouldConnect } = require('./paint-rules.js');
const { driversOf } = require('./drivers.js');
const { icueImport } = require('./icue-import.js');
const { icueImportAvailable: icueHere } = require('../pump-screen/icue.js');
const fxLook = require('./fx-look.js');

function isConnected() { return bridge.connected; }
function getLastError() { return bridge.lastError; }

function isLightsOut() { return keyLook.isOut(); }

function getExternalStatus() { return external.getStatus(); }
function getExternalConfig() { return external.getConfig(); }

// Persistable runtime config (the `devices` opt-in map is kept as the raw
// { deviceId: bool } shape, unlike getStatus which projects it onto the device list).
function getConfig() {
  return {
    enabled: bridge.config.enabled,
    lightsOut: keyLook.isOut(),
    brightness: bridge.config.brightness,
    pauseDuringGame: bridge.config.pauseDuringGame,
    devices: { ...bridge.config.devices },
    effects: { ...bridge.config.effects },
    animation: { ...bridge.config.animation, palette: (bridge.config.animation.palette || []).slice() },
    manualColor: bridge.config.manualColor || '',
    deviceModes: JSON.parse(JSON.stringify(bridge.config.deviceModes)),
    providers: external.getConfig(),
    native: { enabled: native.status().enabled, layouts: native.getLayouts(), scanned: native.getScanned() },
  };
}

// Project a device's stored mode onto a flat shape for the UI.
function deviceModeOf(id) {
  const m = bridge.config.deviceModes[id];
  return {
    mode: (m && m.mode) || 'follow',
    modeColor: (m && m.color) || null,
    modeAnim: (m && m.anim) ? { ...m.anim } : null,
    modeLeds: (m && m.leds) ? { ...m.leds } : {},
  };
}

// Xenon's own drivers, and the boards it could drive but does not (board-probe.js), so the
// Lighting page can offer them when nothing else lights them.
function nativeStatus() {
  const own = native.status();
  return { ...own, idleBoards: own.enabled ? 0 : boardProbe.found() };
}

function getStatus() {
  const providers = external.getStatus().providers;
  providers.forEach(p => (p.devices || []).forEach(d => Object.assign(d, deviceModeOf(d.id))));
  const devices = getDevices();
  const status = {
    available: isAvailable(),
    connected: bridge.connected,
    enabled: bridge.config.enabled,
    lightsOut: keyLook.isOut(),
    devices: devices.map(d => ({ ...d, optedIn: bridge.config.devices[d.id] !== false, ...deviceModeOf(d.id) })),
    effects: { ...bridge.config.effects },
    animation: { ...bridge.config.animation, palette: (bridge.config.animation.palette || []).slice() },
    manualColor: bridge.config.manualColor || '',
    brightness: bridge.config.brightness,
    pauseDuringGame: bridge.config.pauseDuringGame,
    providers,
    native: nativeStatus(),
    // The pump screen's hold on its ring and on every light, and the devices that carry the ring,
    // so the page says it (lighting-device.js).
    pumpRing: { ...pumpRing.state(), devices: devices.filter(d => pumpRing.ledsOf(d)).map(d => d.id) },
    // What the effects that follow the PC cannot read here now, so the page leaves them out.
    cannot: fxLook.cannot(),
    reason: bridge.lastError,
  };
  // Lights that could take back the look they had in iCUE (icue-import.js): names only.
  status.icueImport = icueImport.offer(status.devices).map(({ id, name }) => ({ id, name }));
  status.drivers = driversOf({ ...status, wanted: shouldConnect(), icueHere: icueHere() });
  return status;
}

module.exports = {
  isConnected, getLastError, isLightsOut, getExternalStatus, getExternalConfig, getConfig,
  deviceModeOf, getStatus,
};
