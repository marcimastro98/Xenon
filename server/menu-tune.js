'use strict';
// How a placed widget sits on the screen: the same adjustments for each of them, so
// one made by hand gets what the performance HUD gets. Every change is a capability. Pure.

const PerfHud = require('./js/perf-hud.js');
const LayersModel = require('./js/layers-model.js');
const LayerWhen = require('./js/layer-when.js');
const LayerSee = require('./js/layer-see.js');
const { ANCHOR_CORNERS, k, run, cornerKey, cornerOf, choiceRow, toggleRow } = require('./menu-rows.js');
const { SIZE_PX } = require('./capabilities/layer-anchor.js');
const { widgetWhenRow } = require('./menu-when.js');
const { screenName } = require('./js/screen-name.js');
const { widgetKeyRows } = require('./menu-widget-keys.js');
const { optionRows, fitsItself } = require('./menu-widget-options.js');

const CORNERS = Object.freeze(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
const OPACITIES = Object.freeze([100, 80, 60, 40]);
// Over a game the words grow with the box of the layer, so these sizes are the text's.
const TEXT_SIZES = Object.freeze([['hud', 'xmenu_size_small'], ['small', 'xmenu_size_medium'], ['medium', 'xmenu_size_large']]);
const BOX_SIZES = Object.freeze([['small', 'xmenu_size_small'], ['medium', 'xmenu_size_medium'], ['large', 'xmenu_size_large']]);
const GROUP_LABELS = Object.freeze({
  game: 'xmenu_hud_group_game', cpu: 'perf_cpu', gpu: 'perf_gpu', other: 'xmenu_hud_group_other',
});
// Only the words a person may not know get a line.
const PART_SUBS = Object.freeze({
  fps: 'xmenu_sub_fps', low1: 'xmenu_sub_low1', low01: 'xmenu_sub_low01', frame: 'xmenu_sub_frame', graph: 'xmenu_sub_graph',
  cpu: 'xmenu_sub_load', gpu: 'xmenu_sub_load', ping: 'xmenu_sub_ping', loss: 'xmenu_sub_loss',
});
const SAME_SPOT = 0.001;

const isPerf = (w) => w.kind === 'tile' && w.widget === 'perf';
const isHud = (w) => isPerf(w) && w.surface === 'overlay';

// The pin is a picture with no panel, and the HUD over a game is already words alone.
const hasPanel = (w) => w.widget !== LayersModel.PIN && !LayersModel.isKey(w) && !isHud(w);

// A box dragged somewhere by hand sits in no corner, and a new size must not move it.
function cornerHeld(rect) {
  const corner = cornerOf(rect);
  const spot = LayersModel.rectAt(corner, rect.w, rect.h);
  return Math.abs(spot.x - rect.x) < SAME_SPOT && Math.abs(spot.y - rect.y) < SAME_SPOT ? corner : '';
}

function partItem(part, on) {
  const sub = PART_SUBS[part];
  return {
    kind: 'toggle', id: 'part-' + part, label: k(PerfHud.PERF_HUD_LABELS[part]), sub: sub ? k(sub) : undefined, on,
    acts: { on: run({ type: 'perfHud', [part]: 'show' }), off: run({ type: 'perfHud', [part]: 'hide' }) },
  };
}

function partsRow(id, hud) {
  return {
    kind: 'checks', id, label: k('xmenu_hud_parts'), hint: k('xmenu_parts_hint'),
    groups: Object.entries(PerfHud.PERF_HUD_GROUPS).map(([group, parts]) => ({
      id: group, label: k(GROUP_LABELS[group]), items: parts.map((p) => partItem(p, hud[p])),
    })),
  };
}

function sizeRow(id, box, move, label, sizes) {
  const corner = cornerHeld(box.rect);
  const options = sizes.map(([size, name]) => [size, k(name)]);
  return choiceRow(id, label, LayersModel.nearestSize(box.rect, sizes.map(([size]) => size)), options, (v) => move({ size: v, ...(corner ? { position: corner } : {}) }));
}

// What holds the values of a group of tabs: its first member, the box on the screen.
function leadOf(w, widgets) {
  const box = LayersModel.boxes(widgets).find((b) => b.members.some((x) => x.id === w.id));
  return box ? box.lead : w;
}

function hudRows(id, st) {
  const shown = PerfHud.normalizePerfHud(st.perfHud);
  const layouts = PerfHud.PERF_HUD_LAYOUTS.map((v) => [v, k('xmenu_hud_' + v)]);
  return [
    partsRow(id('parts'), shown),
    choiceRow(id('layout'), k('xmenu_hud_layout'), shown.layout, layouts, (v) => ({ type: 'perfHud', layout: v })),
  ];
}

// The one question: when do you see it? One answer sets where and when together. The
// app needs picking, so that card carries no action and the page asks which one
// (js/xenon-menu-place.js). A mix no answer can say stays as it is and is named.
function seeRow(w, st, id, move) {
  const options = LayerSee.CHOICES.filter((see) => see !== 'app').map((see) => ({
    value: see, label: k('see_' + see), sub: k(`see_${see}_sub`), act: run(move(LayerSee.changeFor(see))),
  }));
  const app = (w.anchor && w.anchor.app) || '';
  if ((st.probes || {}).layerAnchor || app) {
    const sub = app ? { text: LayerWhen.appName(app) } : k('see_app_sub');
    options.push({ value: 'anchor', label: k('see_app'), sub, ...(w.anchor && w.anchor.icon ? { icon: w.anchor.icon } : {}) });
  }
  const see = LayerSee.seeOf(w);
  return {
    kind: 'place', cards: true, id: id('place'), label: k('see_question'), value: see === 'app' ? 'anchor' : see, widget: w.id, options,
    ...(see === 'custom' ? { note: k('see_custom') } : {}),
  };
}

// Worth asking only with two screens. No monitor saved means the main one.
function screenRows(w, st, id, move) {
  const screens = screensOf(st);
  if (screens.length < 2 || w.surface === 'anchor') return [];
  const main = screens[0].key;
  const value = screens.some((m) => m.key === w.monitor) ? w.monitor : main;
  const options = screens.map((m, i) => [m.key, screenLabel(m, i, screens)]);
  const row = choiceRow(id('screen'), k('xmenu_screen'), value, options, (v) => move(v === main ? { screen: 'main' } : { monitor: v }));
  // The shape of each screen, so the menu can draw them side by side.
  return [{ ...row, options: row.options.map((o, i) => ({ ...o, ratio: ratioOf(screens[i]) })) }];
}

const screensOf = (st) => [...(st.monitors || [])].sort((a, b) => Number(b.primary === true) - Number(a.primary === true));

const ratioOf = (m) => (m && m.width && m.height ? m.width / m.height : 16 / 9);

function screenLabel(m, i, screens) {
  const { name, size } = screenName(m, screens);
  if (name) return i ? { text: name } : k('xmenu_screen_main_named', { name });
  if (!i) return k('xmenu_screen_main');
  return size ? k('xmenu_screen_n_size', { n: i + 1, size }) : k('xmenu_screen_n', { n: i + 1 });
}

// The screen a widget is on, for its line in the list. Null with one screen: nothing to tell.
function screenFact(w, st) {
  const screens = screensOf(st);
  if (screens.length < 2 || w.surface === 'anchor') return null;
  const i = Math.max(0, screens.findIndex((m) => m.key === w.monitor));
  const { name } = screenName(screens[i], screens);
  return name ? { text: name } : screenLabel(screens[i], i, screens);
}

// Corner and size of a widget on an app: its place is the app's window, not a box.
function anchorRows(w, id) {
  const edit = (change) => ({ type: 'layerAnchor', widget: w.id, ...change });
  const size = BOX_SIZES.find(([v]) => SIZE_PX[v][0] === w.anchor.w && SIZE_PX[v][1] === w.anchor.h);
  return [
    choiceRow(id('corner'), k('xmenu_where'), ANCHOR_CORNERS[w.anchor.corner], CORNERS.map((c) => [c, cornerKey(c)]), (v) => edit({ mode: 'corner', corner: v })),
    choiceRow(id('size'), k('xmenu_size'), size ? size[0] : '', BOX_SIZES.map(([v, label]) => [v, k(label)]), (v) => edit({ mode: 'size', size: v })),
  ];
}

// With pages, a widget that cannot be seen is usually on the other one.
function pageRow(w, st, id, move) {
  const { pages, page } = st.layers;
  if (pages.length < 2) return [];
  const names = pages.map((pg, i) => [pg.id, pg.name ? { text: pg.name } : k('layer_page_n', { n: i + 1 })]);
  return [choiceRow(id('page'), k('xmenu_on_page'), w.page || page, names, (v) => move({ page: v }))];
}

function tuneRows(w, st) {
  const box = leadOf(w, st.layers.widgets);
  const id = (name) => `${w.id}:${name}`;
  const move = (change) => ({ type: 'layerMove', target: w.id, ...change });
  const hud = isHud(w);
  const free = w.surface !== 'anchor';   // an attached widget follows its app's window
  const head = (name, label) => ({ kind: 'tunehead', id: id('h-' + name), label: k(label) });
  const rows = [head('where', 'xmenu_tune_where'), seeRow(w, st, id, move), ...screenRows(w, st, id, move), ...pageRow(w, st, id, move)];
  if (free) rows.push(choiceRow(id('corner'), k('xmenu_where'), cornerHeld(box.rect), CORNERS.map((c) => [c, cornerKey(c)]), (v) => move({ position: v })));
  if (w.group) rows.push({ kind: 'button', id: id('leave'), label: k('xmenu_tabs_leave'), action: k('xmenu_tabs_leave_do'), act: run({ type: 'layerGroup', widget: w.id, mode: 'leave' }) });
  if (free) rows.push({ ...widgetWhenRow(id('when'), box, st), label: k('see_other'), answered: true });
  else rows.push(...anchorRows(w, id));
  rows.push(head('look', 'xmenu_tune_look'));
  // A widget sized by its own content (`fit`) has its shape among its options.
  if (free && w.widget !== LayersModel.PIN && !LayersModel.isKey(w) && !fitsItself(w, st)) rows.push(sizeRow(id('size'), box, move, k(hud ? 'xmenu_hud_text' : 'xmenu_size'), hud ? TEXT_SIZES : BOX_SIZES));
  rows.push(choiceRow(id('opacity'), k('xmenu_hud_opacity'), Math.round(box.opacity * 100), OPACITIES.map((o) => [o, { text: o + '%' }]), (v) => move({ opacity: String(v) })));
  if (hasPanel(w)) rows.push(toggleRow(id('bare'), k('xmenu_bare_on'), !!box.bare, move({ bare: 'on' }), move({ bare: 'off' })));
  if (free) rows.push(...widgetKeyRows(w, st, id));
  if (isPerf(w)) return rows.concat(head('what', 'xmenu_tune_what'), hudRows(id, st));
  const own = optionRows(w, st, id);
  return own.length ? rows.concat(head('what', 'xmenu_tune_what'), own) : rows;
}

module.exports = { tuneRows, screenFact, screenLabel, screensOf, leadOf, ratioOf, isHud };
