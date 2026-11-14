'use strict';
// What is in a trial drop once it is decrypted: the code read, the places a preset carries
// widget packages, every valid package by id, the same code with each package replaced by a
// marker for the dashboard, and a package turned back into what an install takes.

const sdkWidgets = require('../sdk-widgets.js');

// The decrypted inner code: plain JSON or its base64url form.
function parseInner(inner) {
  if (typeof inner !== 'string' || !inner) return null;
  const s = inner.trim();
  try {
    const obj = JSON.parse(s.charAt(0) === '{' ? s : Buffer.from(s, 'base64url').toString('utf8'));
    return obj && typeof obj === 'object' && obj.data && typeof obj.data === 'object' ? obj : null;
  } catch { return null; }
}

// Where a preset carries widget packages: the data itself for a widget or scene,
// data.widgets[] for a bundle, a deck profile or a canvas scene.
function widgetSlots(preset) {
  const data = preset && preset.data;
  if (!data || typeof data !== 'object') return [];
  if (preset.kind === 'widget' || preset.kind === 'ambient') return data.payload ? [data] : [];
  return Array.isArray(data.widgets) ? data.widgets.filter((w) => w && typeof w === 'object' && w.payload) : [];
}

// Every valid package in a decrypted inner code, by id.
function packagesOf(inner) {
  const out = new Map();
  for (const slot of widgetSlots(parseInner(inner))) {
    const v = sdkWidgets.validateWidgetPayload(slot.payload);
    if (v.ok) out.set(v.id, v);
  }
  return out;
}

// The inner code the dashboard gets: the same preset, each package replaced by a
// marker the import flow hands back to /sdk/install to put it in place.
function stubInner(inner) {
  const preset = parseInner(inner);
  if (!preset) return null;
  for (const slot of widgetSlots(preset)) {
    const v = sdkWidgets.validateWidgetPayload(slot.payload);
    slot.payload = v.ok ? { trialVault: true, id: v.id } : null;
  }
  return Buffer.from(JSON.stringify(preset), 'utf8').toString('base64url');
}

// The package's own manifest.json, as stored: normalizeManifest is the boundary
// on the way back in, and it reads the author's shape, not its own output.
function rawManifest(v) {
  return JSON.parse(v.files.find((f) => f.relPath === 'manifest.json').bytes.toString('utf8'));
}

// A validated package back in the /sdk/install payload shape.
function toPayload(v) {
  return { id: v.id, files: v.files.map((f) => ({ path: f.relPath, data: f.bytes.toString('base64') })) };
}

module.exports = { parseInner, widgetSlots, packagesOf, stubInner, rawManifest, toPayload };
