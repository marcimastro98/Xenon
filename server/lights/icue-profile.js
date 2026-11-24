'use strict';
// What an iCUE profile shows on each device, read from the profile file iCUE keeps on the PC
// (%APPDATA%\Corsair\CUE5\profiles\{id}.cueprofiledata, XML written by the cereal library), and
// the closest look Xenon can play for it. Pure: icue-import.js reads the file and applies.
//
// cereal writes a shared pointer's data and a polymorphic type's name only the first time they
// appear (the id then carries the high bit); later uses repeat the id alone. So the ids are
// collected first, and a layer that reuses one resolves through them.

const HIGH_BIT = 0x7fffffff;

// The iCUE effects seen in real profiles, by the nearest per-device animation Xenon has
// (look-values.js PER_DEVICE_ANIM_STYLES). A static colour becomes a colour, anything else is skipped.
const MOVING = {
  RainbowLighting: 'cycle', RainbowWaveLighting: 'cycle', SpiralRainbowLighting: 'cycle',
  WatercolorSpectrumLighting: 'aurora', WaterColorLighting: 'aurora', HorizonLighting: 'aurora',
  SingleColorPulseLighting: 'breathing', SingleColorWaveLighting: 'breathing', SingleColorVisorLighting: 'breathing',
};
// iCUE's slow / medium / fast, on Xenon's 1-100 speed.
const SPEEDS = { 1: 30, 2: 50, 3: 75 };

/** @typedef {{ name: string, kids: XmlNode[], text: string }} XmlNode */

/** A small XML tree: elements and their text, no attributes (cereal keeps values in elements). */
function readXml(text) {
  /** @type {XmlNode} */
  const root = { name: '', kids: [], text: '' };
  const stack = [root];
  for (const m of String(text).matchAll(/<([/?!]?)([^\s>/]*)[^>]*?(\/?)>|([^<]+)/g)) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) { top.text += m[4]; continue; }
    if (m[1] === '?' || m[1] === '!') continue;
    if (m[1] === '/') { if (stack.length > 1) stack.pop(); continue; }
    const node = { name: m[2], kids: [], text: '' };
    top.kids.push(node);
    if (!m[3]) stack.push(node);
  }
  return root;
}

const kid = (n, name) => (n ? n.kids.find((k) => k.name === name) : undefined);
const text = (n) => (n ? n.text.trim() : '');
const idOf = (n) => Number(text(n)) & HIGH_BIT;

function walk(n, fn) {
  fn(n);
  for (const k of n.kids) walk(k, fn);
}

// Every polymorphic type name and shared pointer's data, by id.
function indexOf(root) {
  const types = new Map();
  const data = new Map();
  walk(root, (n) => {
    const type = kid(n, 'polymorphic_name');
    if (type) types.set(idOf(kid(n, 'polymorphic_id')), text(type));
    if (n.name === 'ptr_wrapper' && kid(n, 'data') && kid(n, 'id')) data.set(idOf(kid(n, 'id')), kid(n, 'data'));
  });
  return {
    type: (n) => (kid(n, 'polymorphic_id') ? types.get(idOf(kid(n, 'polymorphic_id'))) || '' : ''),
    data: (n) => {
      const ptr = kid(n, 'ptr_wrapper');
      return kid(ptr, 'data') || (kid(ptr, 'id') ? data.get(idOf(kid(ptr, 'id'))) : undefined);
    },
  };
}

// "rgb(0.94 0.56 0.2)" (0-1, or 0-255) as #rrggbb.
function hexOf(value) {
  const m = /^rgb\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(String(value).trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  const scale = parts.some((p) => p > 1) ? 1 : 255;
  return '#' + parts.map((p) => Math.round(Math.min(255, Math.max(0, p * scale))).toString(16).padStart(2, '0')).join('');
}

function firstColour(node) {
  let found = null;
  walk(node, (n) => { if (!found && n.name === 'color') found = hexOf(text(n)); });
  return found;
}

/** The Xenon look for one iCUE effect, or null when Xenon has none close to it. */
function lookOf(type, data) {
  if (type === 'StaticLighting') {
    const color = data && firstColour(data);
    if (!color) return null;
    return color === '#000000' ? { mode: 'off' } : { mode: 'color', color };
  }
  const style = MOVING[type];
  if (!style) return null;
  const anim = { style, speed: SPEEDS[Number(text(kid(data, 'speed')))] || SPEEDS[2] };
  const color = style === 'breathing' && data ? firstColour(data) : null;
  return { mode: 'animation', anim: color ? { ...anim, color } : anim };
}

// The effect a device shows: the first enabled layer Xenon can play, preferring one that covers
// every LED (a layer on some keys only is a detail, not the device's look).
function deviceLook(value, index) {
  const layers = [];
  walk(value, (n) => {
    if (n.name !== 'layers') return;
    for (const layer of n.kids) {
      const data = index.data(layer);
      const base = kid(data, 'base');
      const lighting = kid(data, 'lighting');
      if (!lighting || text(kid(base, 'enabled')) === 'false') continue;
      const type = index.type(lighting);
      const look = lookOf(type, index.data(lighting));
      if (look) layers.push({ type, look, all: text(kid(base, 'option')) === 'AllLeds' });
    }
  });
  return layers.find((l) => l.all) || layers[0] || null;
}

/**
 * The devices of a profile with a look Xenon can play: `usb` is "vid:pid" in lower-case hex.
 * Device types iCUE keeps as templates (no device id) and devices with no look are left out.
 * @param {string} xml
 * @returns {{ usb: string, effect: string, look: any }[]}
 */
function profileLooks(xml) {
  const root = readXml(xml);
  const index = indexOf(root);
  const out = [];
  walk(root, (n) => {
    const key = kid(n, 'key');
    const model = kid(key, 'modelId');
    if (!model || !text(kid(key, 'deviceId'))) return;
    const vid = Number(text(kid(model, 'usbVid')));
    const pid = Number(text(kid(model, 'usbPid')));
    if (!vid || !pid) return;
    const found = deviceLook(kid(n, 'value'), index);
    if (found) out.push({ usb: vid.toString(16).padStart(4, '0') + ':' + pid.toString(16).padStart(4, '0'), effect: found.type, look: found.look });
  });
  return out;
}

module.exports = { profileLooks, lookOf, hexOf, MOVING, SPEEDS };
