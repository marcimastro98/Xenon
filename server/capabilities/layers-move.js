'use strict';
// Moves, resizes and restyles a widget that is already placed on the desktop or in the overlay.

const LayersModel = require('../js/layers-model.js');
const LayerWhen = require('../js/layer-when.js');
const LayerPages = require('../layer-pages.js');
const { describe, placeFor, findPlaced } = require('./layers-find.js');
const { overlayHint } = require('./layers-shortcut.js');

// "x,y,w,h" fractions of the screen (edit mode), or null.
function parseRect(text) {
  const n = String(text || '').split(',').map(Number);
  if (n.length !== 4 || !n.every(Number.isFinite)) return null;
  return { x: n[0], y: n[1], w: n[2], h: n[3] };
}

// "20".."100" (percent) → 0.2..1; null when not asked; false when not a number.
function parseOpacity(text) {
  if (text == null || String(text).trim() === '') return null;
  const n = Number(String(text).trim().replace(/%$/, ''));
  if (!Number.isFinite(n)) return false;
  return Math.min(100, Math.max(20, Math.round(n))) / 100;
}

// Move or resize a placed widget. A group moves as one: its box is the first
// member's rectangle (settleGroups), so that member is the one changed.
async function move(d, action) {
  const keepPos = !action.position || action.position === 'keep';
  const keepSize = !action.size || action.size === 'keep';
  const exact = action.rect ? parseRect(action.rect) : null;
  if (action.rect && !exact) return { ok: false, error: 'bad_rect' };
  const opacity = parseOpacity(action.opacity);
  if (opacity === false) return { ok: false, error: 'bad_opacity' };
  const show = LayersModel.SHOW.includes(action.show) ? action.show : null;
  const when = action.when == null || action.when === '' ? undefined : LayerWhen.parse(action.when);
  if (action.when && when === undefined) return { ok: false, error: 'bad_when' };
  const bare = action.bare === 'on' ? true : action.bare === 'off' ? false : null;
  const off = action.visible === 'off' ? true : action.visible === 'on' ? false : null;
  const sameBox = keepPos && keepSize && opacity == null && !show && when === undefined && bare == null && off == null;
  const where = placeFor(d, action);
  if (where && where.error) return { ok: false, error: where.error };
  if (!exact && sameBox && !action.page && !where) return { ok: false, error: 'nothing_to_change' };
  const catalog = await d.layers.catalog();
  let cur = LayersModel.normalize(d.layers.get());
  const found = findPlaced(cur.widgets, action.target, catalog);
  if (found.error) return { ok: false, error: found.error, ids: found.ids };
  if (action.page) {
    // To another page first: it leaves its tabs, so it is its own box after.
    const moved = await d.layers.update(now => LayerPages.moveToPage(now, found.widget.id, action.page));
    if (!moved || moved.error) return { ok: false, error: (moved && moved.error) || 'failed', ...(moved && moved.choices ? { choices: moved.choices } : {}) };
    cur = LayersModel.normalize(moved.layers);
    if (!exact && sameBox && !where) return { ok: true, widget: describe(cur.widgets.find(w => w.id === found.widget.id), catalog, cur) };
  }
  if (where) {
    const placed = await d.layers.update(now => LayersModel.placeBox(now, found.widget.id, where));
    if (!placed || placed.error) return { ok: false, error: (placed && placed.error) || 'failed' };
    cur = LayersModel.normalize(placed.layers);
    if (!exact && sameBox) return { ok: true, widget: describe(placed.widget, catalog, cur), ...overlayHint(placed.widget, cur) };
  }
  const box = LayersModel.boxes(cur.widgets).find(b => b.members.some(w => w.id === found.widget.id));
  if (!box) return { ok: false, error: 'not_found' };
  const id = box.lead.id;
  const res = await d.layers.update((now) => {
    const lead = LayersModel.normalize(now).widgets.find(w => w.id === id);
    if (!lead) return { error: 'not_found' };
    let rect = exact;
    if (!rect) {
      const [w, h] = keepSize ? [lead.rect.w, lead.rect.h] : LayersModel.SIZES[action.size];
      rect = keepPos ? { ...lead.rect, w, h } : LayersModel.clearSpot(now, LayersModel.rectAt(action.position, w, h), lead);
    }
    // A group is seen through as one box too: its first member holds the value.
    const patch = { rect };
    if (opacity != null) patch.opacity = opacity;
    // One or the other: a rule that goes back to the old setting takes it, and "always"
    // leaves no rule behind.
    if (show) { patch.show = show; patch.when = null; }
    if (when !== undefined) { patch.when = when; patch.show = 'always'; }
    if (bare != null) patch.bare = bare;
    if (off != null) patch.off = off;
    return LayersModel.updateWidget(now, id, patch);
  });
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed' };
  const after = LayersModel.normalize(res.layers);
  return { ok: true, widget: describe(res.widget, catalog, after), ...(where ? overlayHint(res.widget, after) : {}) };
}

module.exports = { parseRect, parseOpacity, move };
