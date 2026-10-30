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
const DeckShortcuts = require('../js/deck-shortcuts.js');
const LayerPages = require('../layer-pages.js');

function available(host) {
  return !!(host && typeof host.available === 'function' && host.available());
}

// The AI says "weather" or "Wall Plate"; a Deck key stores the same text. A
// built-in tile id wins over a widget name, then a package id, then its name.
function resolveRef(text, catalog) {
  const raw = String(text == null ? '' : text).trim();
  const low = raw.toLowerCase();
  if (!low) return null;
  const tiles = Array.isArray(catalog && catalog.tiles) ? catalog.tiles : [];
  const pkgs = Array.isArray(catalog && catalog.packages) ? catalog.packages : [];
  if (tiles.includes(low)) return { kind: 'tile', widget: low };
  const pkg = pkgs.find(p => p.id === raw) || pkgs.find(p => String(p.name || '').trim().toLowerCase() === low);
  return pkg ? { kind: 'sdk', pkg: pkg.id } : null;
}

// `cur` (the normalized layers) names the widget's page when there are pages.
function describe(w, catalog, cur) {
  const pkgs = Array.isArray(catalog && catalog.packages) ? catalog.packages : [];
  const name = w.kind === 'sdk' ? ((pkgs.find(p => p.id === w.pkg) || {}).name || w.pkg) : w.widget;
  const out = { id: w.id, widget: name, surface: w.surface, screen: w.monitor ? 'other' : 'main', show: w.show };
  // Widgets sharing a group are tabs of one box; `active` is the tab it opens on.
  if (w.group) { out.group = w.group; out.active = !!w.active; }
  if (w.opacity < 1) out.opacity = Math.round(w.opacity * 100);
  const page = cur && w.page ? cur.pages.find(p => p.id === w.page) : null;
  if (page) out.page = LayerPages.pageLabel(cur, page);
  return out;
}

// A page named by the user, as the id the widget stores ('' = the one shown).
function pageIdFor(now, ref) {
  if (!ref) return { id: '' };
  const cur = LayersModel.normalize(now);
  const page = LayerPages.findPage(cur, ref);
  if (page) return { id: page.id };
  return { error: cur.pages.length ? 'unknown_page' : 'no_pages', choices: cur.pages.map(p => LayerPages.pageLabel(cur, p)) };
}

function choices(catalog) {
  return {
    tiles: Array.isArray(catalog && catalog.tiles) ? catalog.tiles : [],
    widgets: (Array.isArray(catalog && catalog.packages) ? catalog.packages : []).map(p => p.name || p.id),
  };
}

async function place(d, action) {
  const catalog = await d.layers.catalog();
  const ref = resolveRef(action.widget, catalog);
  if (!ref) return { ok: false, error: 'unknown_widget', choices: choices(catalog) };
  // A monitor key comes from a layer window's own key (edit mode's "Add");
  // normalizeWidget keeps it only when it is a valid one.
  let monitor = typeof action.monitor === 'string' ? action.monitor : '';
  if (action.screen === 'second') {
    monitor = (d.host && typeof d.host.secondMonitor === 'function' && d.host.secondMonitor()) || '';
    if (!monitor) return { ok: false, error: 'no_second_screen' };
  }
  const res = await d.layers.update((cur) => {
    const page = pageIdFor(cur, action.page);
    if (page.error) return page;
    return LayersModel.addWidget(cur, {
      ...ref, surface: action.surface, position: action.position, size: action.size, monitor, page: page.id,
    });
  });
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed', ...(res && res.choices ? { choices: res.choices } : {}) };
  const cur = LayersModel.normalize(res.layers);
  const out = { ok: true, placed: describe(cur.widgets.find(w => w.id === res.widget.id) || res.widget, catalog, cur) };
  // So the AI can tell the person how to show and hide it over a game.
  if (res.widget.surface === 'overlay' && cur.overlayKey !== 'off') out.toggleShortcut = shortcutText(cur.overlayKey);
  return out;
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

// A placed widget by its id, or by a name when exactly one placement has it.
function findPlaced(widgets, text, catalog) {
  const raw = String(text == null ? '' : text).trim();
  const byId = widgets.find(w => w.id === raw);
  if (byId) return { widget: byId };
  // A pinned screenshot is not in the Add list, but "the pin" still names it.
  const ref = resolveRef(raw, catalog) || (raw.toLowerCase() === LayersModel.PIN ? { kind: 'tile', widget: LayersModel.PIN } : null);
  const hits = ref ? widgets.filter(w => (ref.kind === 'sdk' ? w.pkg === ref.pkg : w.widget === ref.widget)) : [];
  if (hits.length === 1) return { widget: hits[0] };
  if (hits.length > 1) return { error: 'ambiguous', ids: hits.map(w => w.id) };
  return { error: 'not_placed' };
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
  const res = await d.layers.update(now => (leave
    ? LayersModel.ungroupWidget(now, source.widget.id)
    : LayersModel.groupWidgets(now, target.widget.id, source.widget.id)));
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed' };
  return { ok: true, widget: describe(res.widget, catalog, LayersModel.normalize(res.layers)) };
}

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
  if (!exact && keepPos && keepSize && !action.page && opacity == null && !show) return { ok: false, error: 'nothing_to_change' };
  const catalog = await d.layers.catalog();
  let cur = LayersModel.normalize(d.layers.get());
  const found = findPlaced(cur.widgets, action.target, catalog);
  if (found.error) return { ok: false, error: found.error, ids: found.ids };
  if (action.page) {
    // To another page first: it leaves its tabs, so it is its own box after.
    const moved = await d.layers.update(now => LayerPages.moveToPage(now, found.widget.id, action.page));
    if (!moved || moved.error) return { ok: false, error: (moved && moved.error) || 'failed', ...(moved && moved.choices ? { choices: moved.choices } : {}) };
    cur = LayersModel.normalize(moved.layers);
    if (!exact && keepPos && keepSize && opacity == null && !show) return { ok: true, widget: describe(cur.widgets.find(w => w.id === found.widget.id), catalog, cur) };
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
      rect = keepPos ? { ...lead.rect, w, h } : LayersModel.rectAt(action.position, w, h);
    }
    // A group is seen through as one box too: its first member holds the value.
    const patch = { rect };
    if (opacity != null) patch.opacity = opacity;
    if (show) patch.show = show;
    return LayersModel.updateWidget(now, id, patch);
  });
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed' };
  return { ok: true, widget: describe(res.widget, catalog, LayersModel.normalize(res.layers)) };
}

// Edit mode on, off or switched: a runtime state the layer windows follow.
async function edit(d, action) {
  if (!d.edit) return { ok: false, error: 'unavailable' };
  const on = action.mode === 'on' ? true : action.mode === 'off' ? false : !d.edit.get();
  // Editing shows every widget: one on a hidden surface could not be moved.
  // What was hidden goes back to hidden when editing ends (layers-edit onEnd).
  const hidden = LayersModel.normalize(d.layers.get()).hidden;
  if (on && !d.edit.get() && hidden.length) {
    if (typeof d.edit.keep === 'function') d.edit.keep(hidden.slice());
    await d.layers.update(cur => ({ layers: { ...LayersModel.normalize(cur), hidden: [] } }));
  }
  return { ok: true, editing: d.edit.set(on) };
}

async function list(d) {
  const catalog = await d.layers.catalog();
  const cur = LayersModel.normalize(d.layers.get());
  const out = { ok: true, enabled: cur.enabled, placed: cur.widgets.map(w => describe(w, catalog, cur)), choices: choices(catalog) };
  if (cur.hidden.length) out.hidden = cur.hidden;
  if (cur.widgets.some(w => w.surface === 'overlay')) out.overlayShortcut = shortcutText(cur.overlayKey);
  if (cur.pages.length) out.pages = LayerPages.describePages(cur);
  return out;
}

// Everything, or only the overlay / the desktop widgets (`surface`).
async function toggle(d, action) {
  const surface = LayersModel.TOGGLES.includes(action.surface) ? action.surface : 'all';
  const res = await d.layers.update(cur => LayersModel.toggleSurface(cur, surface, action.mode));
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed' };
  return { ok: true, surface, shown: LayersModel.surfaceShown(res.layers, surface), enabled: res.layers.enabled };
}

// The ready-made shortcuts: `key` overlay (shows and hides the overlay, the
// default) or menu (opens the Xenon menu); a combo, or "off". The same rules as
// a Deck key's shortcut (js/deck-shortcuts.js).
const SHORTCUT_KEYS = Object.freeze({
  overlay: { field: 'overlayKey', fallback: LayersModel.OVERLAY_KEY },
  menu: { field: 'menuKey', fallback: LayersModel.MENU_KEY },
});
function shortcutText(combo) {
  return combo === 'off' ? 'off' : DeckShortcuts.formatShortcut(combo);
}
// `key` pad: holding View + Menu on a controller opens the Xenon menu;
// `combo` on, off or toggle (empty = on, the default).
async function padShortcut(d, action) {
  const raw = String(action.combo || '').trim().toLowerCase();
  const cur = LayersModel.normalize(d.layers.get && d.layers.get()).menuPad;
  const on = { on: true, '': true, off: false, none: false, toggle: !cur }[raw];
  if (on === undefined) return { ok: false, error: 'bad_shortcut' };
  const res = await d.layers.update(c => ({ layers: { ...LayersModel.normalize(c), menuPad: on } }));
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed' };
  return { ok: true, key: 'pad', shortcut: res.layers.menuPad ? 'on' : 'off' };
}

async function shortcut(d, action) {
  if (action.key === 'pad') return padShortcut(d, action);
  const which = SHORTCUT_KEYS[action.key] ? action.key : 'overlay';
  const { field, fallback } = SHORTCUT_KEYS[which];
  const raw = String(action.combo || '').trim().toLowerCase();
  let combo = 'off';
  if (raw !== 'off' && raw !== 'none' && raw !== '') {
    combo = DeckShortcuts.normalizeShortcut(raw);
    if (!combo) return { ok: false, error: 'bad_shortcut' };
    const owner = DeckShortcuts.reservedBy(combo);
    if (owner) return { ok: false, error: 'reserved', owner };
    const other = which === 'menu' ? 'overlayKey' : 'menuKey';
    if (LayersModel.normalize(d.layers.get && d.layers.get())[other] === combo) return { ok: false, error: 'reserved', owner: 'xenon' };
    // A search, page or Deck key shortcut on the same combo would lose the press.
    const by = typeof d.heldBy === 'function' ? d.heldBy(combo, which) : '';
    if (by) return { ok: false, error: 'in_use', by };
  } else if (raw === '') {
    combo = fallback;   // no combo = back to the default
  }
  const res = await d.layers.update(cur => ({ layers: { ...LayersModel.normalize(cur), [field]: combo } }));
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed' };
  return { ok: true, key: which, shortcut: shortcutText(res.layers[field]) };
}

module.exports = { available, resolveRef, findPlaced, describe, choices, place, remove, move, group, edit, list, toggle, shortcut, shortcutText };
