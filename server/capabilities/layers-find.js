'use strict';
// Finds what a layer request means: the widget it names, the one already placed, its page and
// its monitor, and how a placed widget is described back.

const LayersModel = require('../js/layers-model.js');
const LayerWhen = require('../js/layer-when.js');
const DeckShortcuts = require('../js/deck-shortcuts.js');
const LayerPages = require('../layer-pages.js');
const WidgetOptions = require('../widget-options/options.js');

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
  if (LayersModel.isKey(w)) out.key = w.instance;
  // Widgets sharing a group are tabs of one box; `active` is the tab it opens on.
  if (w.group) { out.group = w.group; out.active = !!w.active; }
  if (w.opacity < 1) out.opacity = Math.round(w.opacity * 100);
  if (w.bare) out.bare = true;
  if (w.off) out.hidden = true;
  // The key that shows or hides it (capabilities/widget-key.js).
  if (w.key) { out.shortcut = DeckShortcuts.formatShortcut(w.key.combo); out.shortcutMode = w.key.hold ? 'hold' : 'toggle'; }
  if (w.when) out.when = LayerWhen.format(w.when);
  const page = cur && w.page ? cur.pages.find(p => p.id === w.page) : null;
  if (page) out.page = LayerPages.pageLabel(cur, page);
  const pkg = w.kind === 'sdk' ? pkgs.find(p => p.id === w.pkg) : null;
  if (pkg && Array.isArray(pkg.options) && pkg.options.length) out.options = WidgetOptions.describe(pkg.options, pkg.optionValues);
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

// A monitor key comes from a layer window's own key (edit mode's "Add");
// normalizeWidget keeps it only when it is a valid one.
function monitorFor(d, action) {
  if (action.screen !== 'second') return { monitor: typeof action.monitor === 'string' ? action.monitor : '' };
  const monitor = (d.host && typeof d.host.secondMonitor === 'function' && d.host.secondMonitor()) || '';
  return monitor ? { monitor } : { error: 'no_second_screen' };
}

// Where a placed widget goes, when it was asked to go somewhere: null otherwise.
function placeFor(d, action) {
  const place = {};
  if (LayersModel.PLACES.includes(action.surface)) place.surface = action.surface;
  if (action.screen === 'main') place.monitor = '';
  else if (action.screen === 'second' || action.monitor) {
    const where = monitorFor(d, action);
    if (where.error) return where;
    place.monitor = where.monitor;
  }
  return Object.keys(place).length ? place : null;
}

// A placed widget by its id, or by a name when exactly one placement has it.
function findPlaced(widgets, text, catalog) {
  const raw = String(text == null ? '' : text).trim();
  const byId = widgets.find(w => w.id === raw);
  if (byId) return { widget: byId };
  // A pinned screenshot or a Deck key is not a tile of the Add list, but "the pin"
  // and "the key" still name them.
  const own = [LayersModel.PIN, LayersModel.KEY].find(name => name === raw.toLowerCase());
  const ref = resolveRef(raw, catalog) || (own ? { kind: 'tile', widget: own } : null);
  const hits = ref ? widgets.filter(w => (ref.kind === 'sdk' ? w.pkg === ref.pkg : w.widget === ref.widget)) : [];
  if (hits.length === 1) return { widget: hits[0] };
  if (hits.length > 1) return { error: 'ambiguous', ids: hits.map(w => w.id) };
  return { error: 'not_placed' };
}

module.exports = { resolveRef, describe, pageIdFor, choices, monitorFor, placeFor, findPlaced };
