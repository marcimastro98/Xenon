'use strict';
// The choices of the menu's Add row: a tile, a package from the Store with its pictures, a key,
// and the filters over them.

const LayerSee = require('../js/layer-see.js');
const PaletteModel = require('../js/palette-model.js');
const { previewPath } = require('../tile-previews.js');
const { HUD_PLACE, k, run, keyName } = require('../menu-rows.js');

function tileChoice(id) {
  const picture = previewPath(id);
  const cats = [PaletteModel.builtinCategory(id, PaletteModel.WIDGET_CATEGORIES)];
  return { value: id, tile: id, label: k('layout_widget_' + id), sub: k('layout_widget_' + id + '_desc'), cats, ...(picture ? { picture } : {}) };
}

// The Store's first picture of each installed widget, by package id. A widget that
// never came from the Store has none: the menu draws its initial instead.
function storeShots(entries) {
  const shots = {};
  for (const e of entries || []) {
    const shot = e && e.pkgId ? PaletteModel.storeShot(e) : null;
    if (shot) shots[e.pkgId] = shot;
  }
  return shots;
}

function packageChoice(p, shots) {
  const shot = shots && shots[p.id];
  const cats = [PaletteModel.packageCategory(p, null), 'store'];
  return { value: p.id, label: { text: p.name }, cats, ...(p.description ? { sub: { text: p.description } } : {}), ...(shot ? { shot } : {}) };
}

// One tap places it in a free spot, as what suits it best: the widget's own screen
// changes both right after. The performance readings are words alone over a game.
function placeTile(id) {
  const first = LayerSee.firstFor(id);
  return id === 'perf' ? { ...HUD_PLACE, ...first } : { type: 'layerPlace', widget: id, position: 'top-right', size: 'medium', ...first };
}

function recommended(id) {
  const say = LayerSee.firstLabel(id);
  return { pair: [k('see_recommended'), k(say.key, say.vars)] };
}

// Every tile and installed widget, the same list as edit mode's "Add".
function addChoices(st) {
  const tiles = (st.tiles || []).map(tileChoice);
  const pkgs = (st.packages || []).map((p) => packageChoice(p, st.shots));
  const widgets = tiles.concat(pkgs).map((c) => ({ ...c, rec: recommended(c.value), act: run(placeTile(c.value)) }));
  return widgets.concat((st.deckKeys || []).map(keyChoice));
}

function keyChoice(c) {
  return {
    value: 'key:' + c.id, label: keyName(c), sub: k('layer_key_sub'), cats: ['keys'], ...(c.shot ? { shot: c.shot } : {}),
    act: run({ type: 'layerKey', key: c.id, surface: 'overlay', position: 'top-right' }),
  };
}

// The filters above the cards: only those with something in them, none for a short list.
function addFilters(choices) {
  const has = (cat) => choices.some((c) => c.cats.includes(cat));
  const found = PaletteModel.CATEGORIES.filter(has).map((value) => ({ value, label: k(PaletteModel.CATEGORY_KEY[value]) }));
  if (has('store')) found.push({ value: 'store', label: k('palette_filter_installed') });
  if (has('keys')) found.push({ value: 'keys', label: k('xmenu_filter_keys') });
  return found.length > 1 ? [{ value: 'all', label: k('palette_filter_all') }, ...found] : [];
}

function addRow(st) {
  const choices = addChoices(st);
  return { kind: 'add', id: 'add', label: k('xmenu_add_widget'), choices, filters: addFilters(choices) };
}

module.exports = {
  tileChoice, storeShots, packageChoice, placeTile, recommended, addChoices, keyChoice, addFilters,
  addRow,
};
