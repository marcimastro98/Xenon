'use strict';
// What the lights are doing now, as the pages and the tools read it.

const external = require('./lighting-external.js');
const native = require('../lighting-native/index.js');
const keyLook = require('./lighting-key-look.js');
const { bridge } = require('./bridge-state.js');
const { isAvailable } = require('./sdk-dll.js');
const { getDevices } = require('./sdk-write.js');

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

function getStatus() {
  const providers = external.getStatus().providers;
  providers.forEach(p => (p.devices || []).forEach(d => Object.assign(d, deviceModeOf(d.id))));
  return {
    available: isAvailable(),
    connected: bridge.connected,
    enabled: bridge.config.enabled,
    lightsOut: keyLook.isOut(),
    devices: getDevices().map(d => ({ ...d, optedIn: bridge.config.devices[d.id] !== false, ...deviceModeOf(d.id) })),
    effects: { ...bridge.config.effects },
    animation: { ...bridge.config.animation, palette: (bridge.config.animation.palette || []).slice() },
    manualColor: bridge.config.manualColor || '',
    brightness: bridge.config.brightness,
    pauseDuringGame: bridge.config.pauseDuringGame,
    providers,
    native: native.status(),
    reason: bridge.lastError,
  };
}

module.exports = {
  isConnected, getLastError, isLightsOut, getExternalStatus, getExternalConfig, getConfig,
  deviceModeOf, getStatus,
};
