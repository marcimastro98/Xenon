'use strict';
// Layer capabilities: put a widget on the desktop or in the overlay, take it
// away, list what is placed, switch them all on or off. The rules for what a
// placement may contain live in js/layers-model.js; this file only turns the
// words an AI or a Deck key sends into those edits.
//
// deps (injected, so every decision is testable without a shell or a screen):
//   host     { available(), secondMonitor() } — the native shell that draws layers
//   layers   { get(), update(edit), catalog() }
//            update runs edit(currentLayers) under the settings lock and writes
//            result.layers unless the edit returned { error }.
//            catalog() → { tiles: ['weather', …], packages: [{ id, name }] }
const LayersModel = require('../js/layers-model.js');
const LayerWhen = require('../js/layer-when.js');
require('../js/deck-shortcuts.js'); // nothing is taken from it here, but it runs code when it loads
const LayerPages = require('../layer-pages.js');
const { previewPath } = require('../tile-previews.js');

function available(host) {
  return !!(host && typeof host.available === 'function' && host.available());
}

const {
  resolveRef, describe, pageIdFor, choices, monitorFor, findPlaced,
} = require('./layers-find.js');

const { overlayHint, shortcutText, shortcut } = require('./layers-shortcut.js');

async function place(d, action) {
  const catalog = await d.layers.catalog();
  const ref = resolveRef(action.widget, catalog);
  if (!ref) return { ok: false, error: 'unknown_widget', choices: choices(catalog) };
  const where = monitorFor(d, action);
  if (where.error) return { ok: false, error: where.error };
  const when = action.when ? LayerWhen.parse(action.when) : undefined;
  if (action.when && when === undefined) return { ok: false, error: 'bad_when' };
  const res = await d.layers.update((cur) => {
    const page = pageIdFor(cur, action.page);
    if (page.error) return page;
    return LayersModel.addWidget(cur, {
      ...ref, surface: action.surface, position: action.position, size: action.size, monitor: where.monitor, page: page.id, show: action.show, when,
    });
  });
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed', ...(res && res.choices ? { choices: res.choices } : {}) };
  const cur = LayersModel.normalize(res.layers);
  return { ok: true, placed: describe(cur.widgets.find(w => w.id === res.widget.id) || res.widget, catalog, cur), ...overlayHint(res.widget, cur) };
}

async function remove(d, action) {
  const catalog = await d.layers.catalog();
  const target = String(action.target || '').trim();
  // A name resolves to the tile id or package id the placement stores.
  const ref = resolveRef(target, catalog);
  const key = ref ? (ref.kind === 'sdk' ? ref.pkg : ref.widget) : target;
  const res = await d.layers.update(cur => LayersModel.removeWidget(cur, key));
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed' };
  return { ok: true, removed: res.removed };
}

// Make `widget` a tab in the box of `with` (the dashboard's tab groups), or
// take it out to a box of its own with mode "leave".
async function group(d, action) {
  const catalog = await d.layers.catalog();
  const cur = LayersModel.normalize(d.layers.get());
  const source = findPlaced(cur.widgets, action.widget, catalog);
  if (source.error) return { ok: false, error: source.error, ids: source.ids };
  const leave = action.mode === 'leave';
  let target = null;
  if (!leave) {
    target = findPlaced(cur.widgets, action.with, catalog);
    if (target.error) return { ok: false, error: target.error, ids: target.ids };
  }
  // A widget sized by its own content (manifest `fit`) has no box to share.
  const fits = (w) => w.kind === 'sdk' && !!(catalog.packages.find(p => p.id === w.pkg) || {}).fit;
  if (!leave && (fits(source.widget) || fits(target.widget))) return { ok: false, error: 'sized_by_itself' };
  const res = await d.layers.update(now => (leave
    ? LayersModel.ungroupWidget(now, source.widget.id)
    : LayersModel.groupWidgets(now, target.widget.id, source.widget.id)));
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed' };
  return { ok: true, widget: describe(res.widget, catalog, LayersModel.normalize(res.layers)) };
}

const { move } = require('./layers-move.js');

function noWidgets(d) {
  return !LayersModel.normalize(d.layers.get()).widgets.length;
}

// Edit mode on, off or switched: a runtime state the layer windows follow.
async function edit(d, action) {
  if (!d.edit) return { ok: false, error: 'unavailable' };
  const on = action.mode === 'on' ? true : action.mode === 'off' ? false : !d.edit.get();
  // Editing lives in the widgets' own windows: with none, nothing would appear.
  if (on && !d.edit.get() && noWidgets(d)) return { ok: false, error: 'no_widgets' };
  // Editing shows every widget: one on a hidden surface could not be moved.
  // What was hidden goes back to hidden when editing ends (layers-edit onEnd).
  const hidden = LayersModel.normalize(d.layers.get()).hidden;
  const starting = on && !d.edit.get();
  if (starting && hidden.length) {
    if (typeof d.edit.keep === 'function') d.edit.keep(hidden.slice());
    await d.layers.update(cur => ({ layers: { ...LayersModel.normalize(cur), hidden: [] } }));
  }
  if (starting && typeof d.edit.remember === 'function') d.edit.remember(LayersModel.normalize(d.layers.get()));
  return { ok: true, editing: d.edit.set(on) };
}

// Everything back as it was when editing began; editing goes on.
// One step back, or with no `mode` all the way to where edit mode began.
async function undoEdit(d, action = {}) {
  if (!d.edit) return { ok: false, error: 'nothing_to_undo' };
  const oneStep = action.mode === 'step';
  const before = oneStep ? d.edit.back() : d.edit.get() ? d.edit.earlier() : null;
  if (!before) return { ok: false, error: 'nothing_to_undo' };
  const res = await d.layers.update(() => ({ layers: before }));
  if (!res || res.error) {
    if (oneStep) d.edit.step(before);
    return { ok: false, error: (res && res.error) || 'failed' };
  }
  if (!oneStep) d.edit.forget();
  d.edit.touch();
  return { ok: true, editing: d.edit.get() };
}

// What edit mode's "Add" shows beside each name. Asked for by that list alone: Bit
// reads layerList too and has no use for addresses.
async function pictures(d, catalog) {
  const shots = d.layers.shots ? await d.layers.shots() : {};
  const out = {};
  for (const id of catalog.tiles || []) { const p = previewPath(id); if (p) out[id] = p; }
  for (const p of catalog.packages || []) { if (shots[p.id]) out[p.name || p.id] = shots[p.id]; }
  return out;
}

async function list(d, action) {
  const catalog = await d.layers.catalog();
  const cur = LayersModel.normalize(d.layers.get());
  const out = { ok: true, enabled: cur.enabled, placed: cur.widgets.map(w => describe(w, catalog, cur)), choices: choices(catalog) };
  if (cur.hidden.length) out.hidden = cur.hidden;
  if (cur.widgets.some(w => w.surface === 'overlay')) out.overlayShortcut = shortcutText(cur.overlayKey);
  if (cur.pages.length) out.pages = LayerPages.describePages(cur);
  if (action && action.pictures === 'yes') out.pictures = await pictures(d, catalog);
  if (action && action.keys === 'yes' && d.deck) out.keys = d.deck.choices(await d.deck.configs());
  return out;
}

// Everything, or only the overlay / the desktop widgets (`surface`).
async function toggle(d, action) {
  if (noWidgets(d)) return { ok: false, error: 'no_widgets' };
  const surface = LayersModel.TOGGLES.includes(action.surface) ? action.surface : 'all';
  const res = await d.layers.update(cur => LayersModel.toggleSurface(cur, surface, action.mode));
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed' };
  return { ok: true, surface, shown: LayersModel.surfaceShown(res.layers, surface), enabled: res.layers.enabled };
}


module.exports = { available, resolveRef, findPlaced, describe, choices, pageIdFor, monitorFor, place, remove, move, group, edit, undoEdit, list, toggle, shortcut, shortcutText };
