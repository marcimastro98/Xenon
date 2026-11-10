'use strict';
// Widgets in captures: whether the widgets placed on the desktop and in the
// overlay show in screenshots, videos, Instant Replay and any other app that
// grabs the screen (a streaming app too). Off by default, so a capture holds
// only what is under them. Xenon's menu and pop-ups stay out either way, and
// the drawing sheet and the Ambient scene are always in (layers/spec.rs).
//
// The setting is `layers.excludeFromCapture`, owned by the server like every
// other layers field; the shell applies it to each window live. It is offered
// only where the shell says it can keep windows out of captures at all.
const LayersModel = require('../js/layers-model.js');

function available(host) {
  return !!(host && typeof host.hides === 'function' && host.hides());
}

// `mode` on (show them), off (keep them out) or toggle, the default.
async function run(d, action) {
  const raw = String(action.mode || 'toggle').trim().toLowerCase();
  const shown = LayersModel.normalize(d.layers.get && d.layers.get()).excludeFromCapture === false;
  const want = { on: true, off: false, toggle: !shown }[raw];
  if (want === undefined) return { ok: false, error: 'bad_mode' };
  const res = await d.layers.update(c => ({ layers: { ...LayersModel.normalize(c), excludeFromCapture: !want } }));
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed' };
  return { ok: true, shown: res.layers.excludeFromCapture === false };
}

module.exports = { available, run };
