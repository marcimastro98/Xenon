'use strict';
// A screenshot pinned over everything, like Snipaste or PureRef: a layer
// widget { kind: 'tile', widget: 'pin', instance: <capture id> } that every
// layer page draws as the picture itself (js/layer-pin.js). "region" takes an
// area first (the screenshot capability, picker and clipboard included),
// "last" pins the newest screenshot, and an id (the toast, the gallery) pins
// that one. Only screenshots: a video has no single picture to pin. The id is
// opaque and the page loads the file through /captures/file, never a path.
//
// deps: d.capture (as for the screenshot capability) and d.layers (as for
// the layer capabilities: get(), update(edit)).

const LayersModel = require('../js/layers-model.js');
const screenshot = require('./screenshot.js');

const SOURCES = Object.freeze(['region', 'last']);
const SURFACES = Object.freeze(['overlay', 'desktop']);

// The capture to pin: { entry }, { error }, or { done } when the picker was
// cancelled or is already open (the screenshot's own answer, passed on).
async function pickPicture(d, action) {
  const c = d.capture;
  const store = c && typeof c.store === 'function' ? c.store() : null;
  if (!store) return { error: 'unavailable' };
  if (action.id) {
    const e = store.get(String(action.id));
    if (!e) return { error: 'not_found' };
    return e.kind === 'screenshot' ? { entry: e } : { error: 'not_a_picture' };
  }
  if (action.source === 'last') {
    const e = await store.last('screenshot');
    return e ? { entry: e } : { error: 'no_file' };
  }
  const shot = await screenshot.run(d, { type: 'screenshot', target: 'region' });
  if (!shot || shot.ok !== true) return { error: (shot && shot.error) || 'failed' };
  if (shot.cancelled || shot.picking) return { done: shot };
  const e = store.get(shot.id);
  return e ? { entry: e } : { error: 'failed' };
}

async function run(d, action) {
  const source = SOURCES.includes(action.source) ? action.source : 'region';
  const picked = await pickPicture(d, { ...action, source });
  if (picked.error) return { ok: false, error: picked.error };
  if (picked.done) return picked.done;
  const e = picked.entry;
  const surface = SURFACES.includes(action.surface) ? action.surface : 'overlay';
  const res = await d.layers.update(cur => LayersModel.addWidget(cur, {
    kind: 'tile', widget: LayersModel.PIN, instance: e.id, surface, rect: LayersModel.pinRect(e.width, e.height),
  }));
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed' };
  return { ok: true, pinned: res.widget.id, surface: res.widget.surface, name: e.name };
}

module.exports = { SOURCES, SURFACES, run };
