'use strict';
// The "Widgets" section of the Xenon menu: every widget on the screen, wherever it
// sits. Where is one of its adjustments (menu-tune.js), not a section of its own.

const LayersModel = require('./js/layers-model.js');
const LayerWhen = require('./js/layer-when.js');
const LayerSee = require('./js/layer-see.js');
require('./js/palette-model.js'); // nothing is taken from it here, but it runs code when it loads
const { previewPath } = require('./tile-previews.js');
const { ANCHOR_CORNERS, k, run, open, heading, cornerKey, spotOf, comboText, widgetName } = require('./menu-rows.js');
const { tuneRows, screenFact, screenLabel, screensOf, leadOf, ratioOf, isHud } = require('./menu-tune.js');
const { fitsItself } = require('./menu-widget-options.js');
const { pageWhenRow, whenFact, pageFact } = require('./menu-when.js');
const { functionRow } = require('./menu-keys.js');
const { FUNCTIONS, keyFor } = require('./menu-functions.js');

const GUIDE_URL = 'https://xenon-app.com/create/#sdk';
const MAKER_URL = 'https://xenon-app.com/maker/';

// Where a widget is: an attached one sits on its app's window, so its box on the
// screen says nothing; the app's name and the corner do.
function placeOf(w) {
  if (w.surface === 'anchor' && w.anchor) {
    return [k('xmenu_on_app', { app: LayerWhen.appName(w.anchor.app) }), cornerKey(ANCHOR_CORNERS[w.anchor.corner] || 'top-right')];
  }
  return [cornerKey(spotOf(w.rect))];
}

const seeWords = (w) => {
  const say = LayerSee.labelOf(w);
  return say.text ? { text: say.text } : k(say.key, say.vars);
};

// The rule that holds it back right now, if any: the words say the answer it was given.
function ruleHolds(w, box, live) {
  if ((live.whenOff || []).includes(box.id)) return true;
  return box.show === 'gaming' ? !live.gaming : box.show === 'notGaming' && !!live.gaming;
}

// Whether the screen shows it at this moment, and if not what brings it. On an app it
// depends on a window Xenon does not track here, so nothing is claimed.
function nowOf(w, st) {
  const L = st.layers;
  const off = (words) => ({ on: false, says: words });
  if (w.off) return off(k('xmenu_widget_off'));
  if (!L.enabled || L.hidden.includes(w.surface)) return off(k('see_off_all'));
  if (w.surface === 'anchor') return { on: true };
  if ((w.page || L.page) !== L.page) return { ...off(k('see_off_page')), peek: k('see_peek') };
  const box = leadOf(w, L.widgets);
  // Hidden by its own key: the key brings it back, so that is what it says.
  if (box.key && ((st.layerNow || {}).keyOff || []).includes(box.id)) {
    return off(k(box.key.hold ? 'see_off_hold' : 'see_off_key', { key: comboText(box.key.combo) }));
  }
  if (ruleHolds(w, box, st.layerNow || {})) {
    return { ...off({ pair: [k('see_off_when'), seeWords(w)] }), peek: { pair: [k('see_peek_when'), seeWords(w)] } };
  }
  return { on: true, says: k('see_now') };
}

// The same picture the Add list shows for it.
function widgetThumb(w, st) {
  if (w.kind === 'sdk') {
    const shot = (st.shots || {})[w.pkg];
    return shot ? { shot } : {};
  }
  const key = LayersModel.isKey(w) && (st.deckKeys || []).find((c) => c.id === w.instance);
  if (key) return key.shot ? { shot: key.shot } : {};
  const picture = previewPath(w.widget);
  return picture ? { picture } : {};
}

// One of several tabs says which: they share a place on the screen.
function tabFact(w, widgets) {
  if (!w.group) return [];
  const box = LayersModel.boxes(widgets).find((b) => b.members.some((x) => x.id === w.id));
  if (!box || box.members.length < 2) return [];
  return [k('xmenu_tab_of', { i: box.members.findIndex((x) => x.id === w.id) + 1, n: box.members.length })];
}

// Where the widget's picture goes on the drawing of its screen.
function atOf(w, st) {
  if (w.surface === 'anchor' && w.anchor) {
    const { corner, w: width, h: height, icon } = w.anchor;
    return { surface: 'anchor', corner: ANCHOR_CORNERS[corner] || 'top-right', app: LayerWhen.appName(w.anchor.app), width, height, ...(icon ? { icon } : {}) };
  }
  const screens = screensOf(st);
  const screen = screens.find((m) => m.key === w.monitor) || screens[0];
  const box = leadOf(w, st.layers.widgets);
  return {
    surface: w.surface, rect: box.rect, opacity: box.opacity, ratio: ratioOf(screen), lead: box.id, bare: !!box.bare,
    monitor: screen && screens.some((m) => m.key === w.monitor) ? w.monitor : '', ...(isHud(w) ? { words: true } : {}),
  };
}

// Tabs go before what the widget shows, so they land in the Where tab of the
// widget's screen (js/xenon-menu-widget-view.js), not in What it shows.
function withTabs(rows, tabs, id) {
  const what = rows.findIndex((r) => r.id === `${id}:h-what`);
  return what < 0 ? [...rows, ...tabs] : [...rows.slice(0, what), ...tabs, ...rows.slice(what)];
}

// Tabs come from here and from the same button on the screen, never from a drag.
function tabsRow(w, st) {
  const box = leadOf(w, st.layers.widgets);
  // A box sized by its own content cannot hold tabs (menu-widget-options.js),
  // so it is neither offered here nor given any.
  const others = LayersModel.boxes(st.layers.widgets)
    .filter((b) => b.lead.id !== box.id && b.lead.surface !== 'anchor' && !fitsItself(b.lead, st));
  if (w.surface === 'anchor' || !others.length || fitsItself(w, st)) return [];
  return [{
    kind: 'choice', id: `${w.id}:tabs`, label: k('see_tabs'), value: '',
    options: others.map((b) => ({ value: b.lead.id, label: widgetName(b.lead, st), act: run({ type: 'layerGroup', widget: w.id, with: b.lead.id, mode: 'join' }) })),
  }];
}

function widgetRow(w, st) {
  const L = st.layers;
  const group = LayerSee.groupOf(w);
  const when = group === 'other' ? whenFact(w) : [];
  const screen = screenFact(w, st);
  const now = nowOf(w, st);
  const visible = (v) => run({ type: 'layerMove', target: w.id, visible: v });
  // With everything hidden, this switch would change nothing on the screen.
  const free = L.enabled && !L.hidden.includes(w.surface);
  return {
    kind: 'widget', id: w.id, label: widgetName(w, st), ...widgetThumb(w, st), page: w.page || L.page, at: atOf(w, st),
    on: !w.off, acts: free ? { on: visible('on'), off: visible('off') } : {}, group, shown: now.on,
    value: [...tabFact(w, L.widgets), ...placeOf(w), ...(screen ? [screen] : []), ...when, ...(w.bare ? [k('xmenu_bare')] : [])],
    ...(now.says ? { now: now.says } : {}),
    // What its own screen says instead, while the menu holds it up (layers-peek.js).
    ...(now.peek ? { peek: now.peek } : {}),
    tune: withTabs(tuneRows(w, st), tabsRow(w, st), w.id),
    act: run({ type: 'layerRemove', target: w.id }),
  };
}

const { storeShots, addChoices, addRow } = require('./menu/widget-add-choices.js');

// The real screens, for the map: as they stand on the desktop when the shell says so.
function mapRow(st) {
  const screens = screensOf(st);
  return {
    kind: 'map', id: 'map', label: k('see_show_me'),
    screens: screens.map((m, i) => ({ key: m.primary ? '' : m.key, label: screenLabel(m, i, screens), width: m.width, height: m.height, x: m.x, y: m.y })),
  };
}

// One change back, there only when there is one.
const undoRow = (st) => (st.layerSteps ? [{ kind: 'button', id: 'undoStep', label: k('layer_edit_step'), act: run({ type: 'layersUndo', mode: 'step' }) }] : []);

// What the places and the pages are, each shown moving. Open until a widget is placed.
function guideRow(st) {
  const card = (demo, see) => ({ demo, label: k('see_' + see), sub: k(`see_${see}_sub`) });
  const places = [card('desktop', 'desktop'), card('overlay', 'always')];
  const anchor = (st.probes || {}).layerAnchor ? [card('anchor', 'app')] : [];
  return {
    kind: 'guide', id: 'guide', label: k('xmenu_guide'), sub: k('xmenu_sub_guide'), open: !st.layers.widgets.length,
    cards: [...places, ...anchor, { demo: 'pages', label: k('xmenu_pages'), sub: k('xmenu_sub_pages') }],
  };
}

// The three ways to make one: tell Bit, write it, or build it in the Maker.
function ownWidgetRow() {
  return {
    kind: 'button', id: 'ownWidget', label: k('xmenu_own_widget'), sub: k('xmenu_sub_own_widget'),
    actions: [
      { label: k('xmenu_bit'), icon: 'bit', act: open('chat'), closes: true },
      { label: k('xmenu_own_code'), act: run({ type: 'openUrl', url: GUIDE_URL }) },
      { label: k('xmenu_own_maker'), act: run({ type: 'openUrl', url: MAKER_URL }) },
    ],
  };
}

// What you made or installed, and the way in for a code or a file you already have.
function yourWidgetsRow() {
  return {
    kind: 'button', id: 'yourWidgets', label: k('xmenu_your_widgets'), sub: k('xmenu_sub_your_widgets'),
    actions: [
      { label: k('xmenu_open'), act: open('store:__installed'), closes: true },
      { label: k('xmenu_import'), act: open('import'), closes: true },
    ],
  };
}

const NEW_PAGE = run({ type: 'layerPageEdit', mode: 'create' });

function pagesRow(L) {
  const options = L.pages.map((pg, i) => ({ value: pg.id, label: pg.name ? { text: pg.name } : k('layer_page_n', { n: i + 1 }), act: run({ type: 'layerPage', page: pg.id }) }));
  if (options.length < LayersModel.MAX_PAGES) options.push({ value: 'new', label: k('xmenu_new_page'), act: NEW_PAGE });
  return { kind: 'pages', id: 'pages', label: k('xmenu_pages'), sub: k('xmenu_sub_pages_pick'), how: k('xmenu_pages_how'), value: L.page, options };
}

// The key that changes page, on the screen of a page: most people who ask how pages
// change never get as far as the Keys section, and in the list it read as a page.
function pageKeyRow(st) {
  if (!(st.probes || {}).shortcuts) return [];
  const fn = FUNCTIONS.find((f) => f.id === 'page');
  return [{ ...functionRow(fn, keyFor(st.deck, fn)), id: 'pageKey', label: k('xmenu_page_key'), sub: null }];
}

// The page the chips have selected: its name, and what deleting it takes with it.
function pageEditRow(st) {
  const L = st.layers;
  const i = L.pages.findIndex((pg) => pg.id === L.page);
  const pg = L.pages[i];
  if (!pg) return [];
  return [{
    kind: 'pageEdit', id: 'pageEdit', label: pg.name ? { text: pg.name } : k('layer_page_n', { n: i + 1 }),
    page: pg.id, name: pg.name || '', widgets: L.widgets.filter((w) => w.page === pg.id).length, max: LayersModel.PAGE_NAME_MAX, says: pageFact(pg),
    rename: { type: 'layerPageEdit', mode: 'rename', page: pg.id },
    remove: run({ type: 'layerPageEdit', mode: 'delete', page: pg.id }),
  }, pageWhenRow(pg, st)];
}

// One page is no choice yet: this row says what pages are for and starts the second.
function firstPageRow() {
  return { kind: 'button', id: 'newPage', label: k('xmenu_pages'), sub: k('xmenu_sub_pages'), action: k('xmenu_new_page'), act: NEW_PAGE };
}

function widgetsSection(st) {
  if (!(st.probes || {}).layers) return [{ kind: 'status', id: 'noLayers', label: k('xmenu_widgets_none'), value: k('xmenu_needs_app') }];
  const L = st.layers;
  const guide = guideRow(st);
  const placed = L.widgets.length > 0;
  return [
    addRow(st),
    ...(placed ? [mapRow(st), ...undoRow(st)] : []),
    ...(placed ? placedRows(st) : [{ kind: 'status', id: 'noWidgets', label: k('xmenu_no_widgets'), value: k('xmenu_no_widgets_hint') }, guide]),
    heading('pages', 'xmenu_pages'),
    ...(L.pages.length > 1 ? [pagesRow(L), ...pageKeyRow(st), ...pageEditRow(st)] : [firstPageRow()]),
    heading('more', 'xmenu_more_widgets'),
    { kind: 'button', id: 'store', label: k('xmenu_add_store'), sub: k('xmenu_sub_store'), action: k('xmenu_open'), act: open('store:__screen'), closes: true },
    yourWidgetsRow(),
    ownWidgetRow(),
    ...(placed ? [guide] : []),
  ];
}

// A page's heading: its name, and which one the screen is showing now.
function pageHeading(pg, i, L) {
  const label = pg.name ? { text: pg.name } : k('layer_page_n', { n: i + 1 });
  return { kind: 'heading', nested: true, id: 'h-page-' + pg.id, label, ...(pg.id === L.page ? { note: k('xmenu_page_now') } : {}) };
}

// Everything placed, on every page, every tab: a list of the page in use alone hid
// what a person had added.
function placedRows(st) {
  const L = st.layers;
  const rows = [
    heading('yours', 'xmenu_your_widgets'),
    { kind: 'toggle', id: 'shown', label: k('xmenu_widgets_shown'), sub: k('xmenu_sub_shown'), on: L.enabled && LayersModel.surfaceShown(L, 'all'),
      acts: { on: run({ type: 'layersToggle', mode: 'on', surface: 'all' }), off: run({ type: 'layersToggle', mode: 'off', surface: 'all' }) } },
    { kind: 'button', id: 'edit', label: k('xmenu_edit'), sub: k('xmenu_sub_edit'), action: k('xmenu_do_start'), act: run({ type: 'layersEdit', mode: 'on' }), closes: true, returns: true },
  ];
  if (L.pages.length < 2) return rows.concat(L.widgets.map((w) => widgetRow(w, st)));
  L.pages.forEach((pg, i) => {
    const here = L.widgets.filter((w) => w.page === pg.id || (!w.page && pg.id === L.page));
    if (here.length) rows.push(pageHeading(pg, i, L), ...here.map((w) => widgetRow(w, st)));
  });
  return rows;
}

module.exports = { widgetsSection, addChoices, storeShots, MAKER_URL };
