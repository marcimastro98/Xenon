'use strict';
// The settings of the lights taken in, the motherboard controllers Xenon drives itself, and the
// providers outside iCUE: each change is kept, then repainted.

const fx = require('./lighting-effects.js');
const external = require('./lighting-external.js');
const ledColors = require('./lighting-led-colors.js');
const native = require('../lighting-native/index.js');
const keyLook = require('./lighting-key-look.js');
const { bridge } = require('./bridge-state.js');
const { refreshAnimationLayer } = require('./paint-rules.js');
const {
  DEVICE_MODES, ANIM_STYLES, PER_DEVICE_ANIM_STYLES, EVENT_DURATION_MS, clampEventDuration,
  sanitizePalette,
} = require('./look-values.js');
const { extrasOf } = require('./look-fields.js');
const { reconcileConnection } = require('./upkeep.js');
const { apply } = require('./paint.js');
const { createBoardApps } = require('../lighting-native/board-apps.js');

// A program that paints the motherboard starts: the board is its own until it quits, then it is
// set up again and repainted (board-apps.js). Watched only while Xenon holds a board.
const boardApps = createBoardApps({
  onCome: (apps) => {
    console.log(`lights: ${apps.join(', ')} paints the motherboard, Xenon leaves those lights to it until it closes`);
    native.yieldTo(apps);
  },
  onGone: (apps) => {
    if (bridge.poweredDown) return;
    console.log(`lights: ${apps.join(', ')} closed, the motherboard lights are Xenon's again`);
    native.retake().then(() => { bridge.lastWrite.clear(); apply(); });
  },
});
function syncBoardApps() {
  if (native.status().controllers.length) boardApps.start();
  else boardApps.stop();
}
async function closeNative() {
  boardApps.stop();
  await native.stop();
}

// Apply persisted/posted config; (dis)connect to match `enabled`.
function applyConfig(next) {
  if (!next || typeof next !== 'object') return;
  if (typeof next.enabled === 'boolean') bridge.config.enabled = next.enabled;
  if (next.enabled === true) keyLook.setOut(false);   // switching the lights on in Settings ends a key's "lights off"
  else if (next.enabled === false && next.lightsOut === true) keyLook.setOut(true);   // saved dark by a key: still dark after a restart
  if (typeof next.brightness === 'number') bridge.config.brightness = Math.max(0, Math.min(1, next.brightness));
  if (typeof next.pauseDuringGame === 'boolean') bridge.config.pauseDuringGame = next.pauseDuringGame;
  if (next.devices && typeof next.devices === 'object') bridge.config.devices = next.devices;
  if (next.effects && typeof next.effects === 'object') {
    if (typeof next.effects.temperature === 'boolean') bridge.config.effects.temperature = next.effects.temperature;
    if (typeof next.effects.volume === 'boolean') bridge.config.effects.volume = next.effects.volume;
    if (typeof next.effects.musicAlbum === 'boolean') bridge.config.effects.musicAlbum = next.effects.musicAlbum;
    for (const k of ['timer', 'notification', 'reminder', 'vitals']) {
      const e = next.effects[k];
      const cur = bridge.config.effects[k] || { enabled: true, color: '#ff0000', style: 'blink', durationMs: EVENT_DURATION_MS };
      if (typeof e === 'boolean') { bridge.config.effects[k] = { ...cur, enabled: e }; }
      else if (e && typeof e === 'object') {
        bridge.config.effects[k] = {
          enabled: typeof e.enabled === 'boolean' ? e.enabled : cur.enabled,
          color: typeof e.color === 'string' ? e.color : cur.color,
          style: ['blink', 'pulse', 'solid'].includes(e.style) ? e.style : cur.style,
          durationMs: clampEventDuration(e.durationMs, cur.durationMs || EVENT_DURATION_MS),
        };
      }
    }
  }
  // Restore the persisted manual colour (must run before the animation block so
  // "Fissa" picks it up via refreshAnimationLayer).
  if (typeof next.manualColor === 'string') {
    bridge.config.manualColor = next.manualColor;
    const c = next.manualColor ? fx.parseColorName(next.manualColor) : null;
    bridge.layers.override = c || null;
  }
  if (next.animation && typeof next.animation === 'object') {
    const a = next.animation;
    if (typeof a.style === 'string' && ANIM_STYLES.includes(a.style)) bridge.config.animation.style = a.style;
    if (typeof a.color === 'string') { const c = fx.parseColorName(a.color); if (c) bridge.config.animation.color = a.color; }
    if (a.speed != null && Number.isFinite(Number(a.speed))) bridge.config.animation.speed = Math.max(1, Math.min(100, Number(a.speed)));
    if (a.palette !== undefined) { const pal = sanitizePalette(a.palette); if (pal) bridge.config.animation.palette = pal; }
    // The knobs come whole with the settings: one left out is back to the effect as made.
    for (const k of ['reverse', 'size', 'glow', 'chain']) delete bridge.config.animation[k];
    Object.assign(bridge.config.animation, extrasOf(a, true));
  }
  refreshAnimationLayer(); // sync the animation layer (incl. "Fissa" → manual colour)
  if (next.deviceModes && typeof next.deviceModes === 'object') {
    const dm = {};
    for (const [id, v] of Object.entries(next.deviceModes)) {
      if (!v || typeof v !== 'object') continue;
      const e = { mode: DEVICE_MODES.includes(v.mode) ? v.mode : 'follow' };
      if (typeof v.color === 'string' && fx.parseColorName(v.color)) e.color = v.color;
      if (v.anim && typeof v.anim === 'object') {
        e.anim = {
          style: PER_DEVICE_ANIM_STYLES.includes(v.anim.style) ? v.anim.style : 'cycle',
          color: (typeof v.anim.color === 'string' && fx.parseColorName(v.anim.color)) ? v.anim.color : '#1ed760',
          speed: Number.isFinite(Number(v.anim.speed)) ? Math.max(1, Math.min(100, Number(v.anim.speed))) : 50,
          ...(sanitizePalette(v.anim.palette) ? { palette: sanitizePalette(v.anim.palette) } : {}),
          ...extrasOf(v.anim),
        };
      }
      if (v.leds !== undefined) e.leds = ledColors.normalizeLedColors(v.leds);
      dm[String(id).slice(0, 160)] = e;
    }
    bridge.config.deviceModes = dm;
  }
  if (next.providers && typeof next.providers === 'object') external.applyConfig(next.providers);
  if (next.native && typeof next.native === 'object') configureNative(next.native);
  if (next.accent && typeof next.accent === 'object') bridge.accent = next.accent;
  reconcileConnection(); // (dis)connect to match master + any enabled effect
  apply();
}

// Switching native control on opens the controllers (a few hundred ms over USB,
// more with a Gen2 scan): repaint once they are there.
function configureNative(next) {
  const enabled = typeof next.enabled === 'boolean' ? next.enabled : undefined;
  bridge.lastWrite.clear();
  native.configure({ enabled, layouts: next.layouts, scanned: next.scanned })
    .catch((e) => { bridge.lastError = e.message; })
    .then(() => { syncBoardApps(); bridge.lastWrite.clear(); apply(); });
}

function setNativeEnabled(on) { configureNative({ enabled: !!on }); }

// One output's layout from the guided setup (null = forget it and set it up again).
function setNativeLayout(id, zone, layout) {
  if (!native.setLayout(id, zone, layout)) return false;
  bridge.lastWrite.clear();
  apply();
  return true;
}

// The guided setup lights part of one output; opts null ends the preview.
async function setNativePreview(id, output, opts) {
  if (opts === null) { native.clearPreview(); bridge.lastWrite.clear(); apply(); return true; }
  return native.setPreview(id, output, opts);
}

async function scanNative() {
  await native.stop();
  await native.start({ rescan: true });
  syncBoardApps();
  bridge.lastWrite.clear();
  apply();
  return native.status();
}

function setEffectEnabled(effect, enabled) {
  if (['temperature', 'volume', 'musicAlbum', 'timer'].includes(effect)) {
    bridge.config.effects[effect] = !!enabled;
    reconcileConnection(); // connect/disconnect to match the new effect state
    apply();
    return true;
  }
  return false;
}
function setEnabled(on) { applyConfig({ enabled: !!on }); }

// --- external providers (WLED, …): thin wrappers that repaint/persist after a
// change. Discovery + device management live in lighting-external. ---
async function scanExternal() { const r = await external.scan(); apply(); return r; }
async function addExternalDevice(providerId, host) { const d = await external.addDevice(providerId, host); if (d) apply(); return d; }
async function pairExternalDevice(providerId, host) { const r = await external.pairDevice(providerId, host); if (r && r.ok) apply(); return r; }
function removeExternalDevice(providerId, id) { const ok = external.removeDevice(providerId, id); apply(); return ok; }
function setExternalDeviceOptIn(providerId, id, on) { const ok = external.setDeviceOptIn(providerId, id, on); bridge.lastWrite.clear(); apply(); return ok; }
// Inject runtime hooks for integration-backed providers (Home Assistant): the
// shared HA client lives in server.js; its token/URL never enter this config.
function setExternalRuntime(providerId, hooks) { external.setRuntime(providerId, hooks); }

module.exports = {
  applyConfig, configureNative, setNativeEnabled, setNativeLayout, setNativePreview, scanNative,
  setEffectEnabled, setEnabled, scanExternal, addExternalDevice, pairExternalDevice,
  removeExternalDevice, setExternalDeviceOptIn, setExternalRuntime, closeNative, _boardApps: boardApps,
};
