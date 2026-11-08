// The "+" panel is a gallery: a person picks a widget by what it looks like, so each card
// shows the tile's real picture. What has to stay true, on the panel's real code:
//  1. One list of pictures for the browser and the server, so nothing asks for a file that
//     is not there.
//  2. A card always has something in its frame: the picture, or the glyph when there is
//     none or it does not load.
//  3. "For supporters" is a line of words, and the line saying what the widget adds stays.
//  4. A widget already placed stays a quiet row: a tap goes to it, it adds nothing.
//  5. Esc takes one step at a time, and a panel that goes lets go of the keyboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom, windowKeys, settle } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const PM = require('../js/palette-model.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const STRINGS = {
  palette_title: 'Add widget',
  palette_supporters: 'For supporters',
  palette_placed: 'Already on the dashboard',
  palette_placed_here: 'On this page',
  layout_widget_weather: 'Weather',
  layout_widget_system: 'System',
  layout_widget_lyrics: 'Lyrics',
  layout_widget_screen: 'Screen',
  layout_widget_sub_lyrics: 'Timing per song',
  layout_widget_lyrics_desc: 'The words of the song',
  layout_widget_weather_desc: 'Weather now and in the next days',
};
const IDS = ['weather', 'system', 'lyrics', 'screen'];

function rig({ touch = false, packages = [], catalog = [], examples = [] } = {}) {
  const { document } = makeDom();
  const make = document.createElement.bind(document);
  document.createElement = (tag) => Object.assign(make(tag), { ownerDocument: document, scrollIntoView() {} });
  document.createTextNode = (text) => Object.assign(make('#text'), { textContent: text });
  document.createElementNS = (_ns, tag) => document.createElement(tag);
  const window = { PaletteModel: PM };
  const keys = windowKeys(window);
  const added = [];
  const widgets = {
    weather: { visible: false, page: 'home' },
    system: { visible: true, page: 'home' },
    lyrics: { visible: false, page: 'home' },
    screen: { visible: false, page: 'home' },
  };
  window.matchMedia = () => ({ matches: touch });
  window.DashboardGrid = {
    addableWidgetIds: (w, _groups, ids) => ids.filter((id) => w[id].visible === false),
    addWidgetToPage: (id, page) => added.push(`${id} on ${page}`),
  };
  window.CustomWidget = {
    getPackages: async () => packages,
    cachedPackages: () => packages,
    packageIcon: () => null,
    missingExamples: () => examples,
  };
  const box = {
    window, document,
    DASHBOARD_WIDGET_IDS: IDS,
    getDashboardLayout: () => ({ widgets, groups: {}, copies: [], pages: [{ id: 'home' }] }),
    t: (key) => STRINGS[key] || '',
    i18n: { en: STRINGS },
    lang: 'en',
    applyTranslations: () => {},
    requestAnimationFrame: (fn) => { fn(); return 1; },
    setTimeout, clearTimeout,
    fetch: async () => ({ json: async () => ({ entries: catalog }) }),
    console,
  };
  vm.runInNewContext(read('../js/dialog-focus.js'), { window, document });
  vm.runInNewContext(read('../js/fuzzy-find.js'), box);
  vm.runInNewContext(read('../js/dashboard-palette.js'), box);
  const press = (key) => {
    const ev = { key, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    keys.slice().forEach((fn) => fn(ev));
    return ev;
  };
  const items = () => Array.from(document.querySelectorAll('.widget-palette-item'));
  const named = (name) => items().find((b) => b.querySelector('.widget-palette-label').textContent === name);
  return { document, window, added, press, items, named, panel: window.DashboardPalette };
}

test('the browser and the server read one list of pictures', () => {
  const server = require('../tile-previews.js');
  assert.equal(server.PREVIEW_TILES, PM.PREVIEW_TILES);
  assert.equal(server.previewPath, PM.previewPath);
  assert.equal(PM.previewPath('weather'), 'assets/tile-previews/weather.webp');
  assert.equal(PM.previewPath('screen'), null);
});

test('a Store widget has the Store\'s first picture, and none when the Store has none', () => {
  assert.equal(PM.storeShot({ id: 'a b', screenshot: true }), 'https://assets.xenon-app.com/community/shots/a%20b.webp');
  assert.equal(PM.storeShot({ id: 'nova', shots: 2 }), 'https://assets.xenon-app.com/community/shots/nova.webp');
  assert.equal(PM.storeShot({ id: 'nova' }), null);
  assert.equal(PM.storeShot(null), null);
});

test('a card shows the tile\'s real picture, loaded only when it comes into view', () => {
  const r = rig();
  r.panel.open('home');
  const img = r.named('Weather').querySelector('.widget-palette-pic img');
  assert.equal(img.src, 'assets/tile-previews/weather.webp');
  assert.equal(img.loading, 'lazy');
  assert.equal(img.decoding, 'async');
  assert.equal(img.alt, '', 'the name beside it already says it');
  r.panel.close();
});

test('a tile with no picture shows its glyph in the same frame', () => {
  const r = rig();
  r.panel.open('home');
  const frame = r.named('Screen').querySelector('.widget-palette-pic');
  assert.ok(frame.querySelector('.widget-palette-ico'));
  assert.equal(frame.querySelector('img'), null);
  r.panel.close();
});

test('a picture that does not load leaves the glyph, never a broken image', () => {
  const r = rig();
  r.panel.open('home');
  const frame = r.named('Weather').querySelector('.widget-palette-pic');
  frame.querySelector('img')._handlers.error.forEach((fn) => fn({}));
  assert.equal(frame.querySelector('img'), null);
  assert.ok(frame.querySelector('.widget-palette-ico'));
  r.panel.close();
});

test('a card says in one line what the widget is for', () => {
  const r = rig();
  r.panel.open('home');
  assert.equal(r.named('Weather').querySelector('.widget-palette-sub').textContent, 'Weather now and in the next days');
  assert.equal(r.named('Screen').querySelector('.widget-palette-sub'), null, 'no line rather than a raw key');
  r.panel.close();
});

test('"For supporters" is a plain line, and what the widget adds stays under it', () => {
  const r = rig();
  r.panel.open('home');
  const card = r.named('Lyrics');
  assert.equal(card.querySelector('.widget-palette-badge'), null);
  assert.equal(card.querySelector('.widget-palette-note').textContent, 'For supporters');
  assert.equal(card.querySelector('.widget-palette-sub').textContent, 'Timing per song');
  r.panel.close();
});

test('a widget already placed stays a quiet row that goes to it', () => {
  const r = rig();
  r.panel.open('home');
  const row = r.named('System');
  assert.ok(row.classList.contains('is-placed'));
  assert.equal(row.querySelector('.widget-palette-pic'), null, 'a row has no picture to compete with what can be added');
  assert.ok(row.querySelector('.widget-palette-ico'));
  assert.ok(row.querySelector('.widget-palette-go'));
  assert.ok(row.parentElement.classList.contains('is-rows'));
  assert.ok(!r.named('Weather').parentElement.classList.contains('is-rows'));
  r.panel.close();
});

test('an example has no picture to show, so it is a row and not an empty frame', () => {
  const r = rig({ examples: [{ id: 'hello', name: 'Hello Xenon', desc: 'A reference widget' }] });
  r.panel.open('home');
  Array.from(r.document.querySelectorAll('.widget-palette-filter'))
    .find((b) => b.getAttribute('data-i18n') === 'palette_filter_installed').click();
  const row = r.named('Hello Xenon');
  assert.ok(row.classList.contains('is-row'));
  assert.ok(!row.classList.contains('is-placed'), 'it adds a widget: no arrow');
  assert.equal(row.querySelector('.widget-palette-pic'), null);
  assert.equal(row.querySelector('.widget-palette-go'), null);
  assert.ok(row.parentElement.classList.contains('is-rows'));
  r.panel.close();
});

test('a tap adds the widget and closes the panel', () => {
  const r = rig();
  r.panel.open('home');
  r.named('Weather').click();
  assert.deepEqual(r.added, ['weather on home']);
  assert.equal(r.document.getElementById('widget-palette'), null);
});

test('a Store widget shows its glyph at once and the Store\'s picture when the catalog lands', async () => {
  const pkg = { id: 'nova', name: 'Nova Clock', category: 'system' };
  const r = rig({ packages: [pkg], catalog: [{ id: 'nova-clock', pkgId: 'nova', screenshot: true }] });
  r.panel.open('home');
  assert.equal(r.named('Nova Clock').querySelector('img'), null);
  await settle();
  await settle();
  const img = r.named('Nova Clock').querySelector('.widget-palette-pic img');
  assert.equal(img.src, 'https://assets.xenon-app.com/community/shots/nova-clock.webp');
  r.panel.close();
});

test('with a keyboard the cursor is in the search, on a touch screen nothing raises the keyboard', () => {
  const desk = rig();
  desk.panel.open('home');
  assert.equal(desk.document.activeElement, desk.document.querySelector('.widget-palette-search'));
  desk.panel.close();
  const touch = rig({ touch: true });
  touch.panel.open('home');
  assert.equal(touch.document.activeElement, touch.document.querySelector('.widget-palette-modal'));
  touch.panel.close();
});

test('it is a dialog named by its title', () => {
  const r = rig();
  r.panel.open('home');
  const modal = r.document.querySelector('.widget-palette-modal');
  assert.equal(modal.getAttribute('role'), 'dialog');
  assert.equal(modal.getAttribute('aria-modal'), 'true');
  assert.equal(modal.getAttribute('aria-labelledby'), r.document.querySelector('.widget-palette-title').id);
  r.panel.close();
});

test('Esc clears a search first and closes on the next press', () => {
  const r = rig();
  r.panel.open('home');
  const input = r.document.querySelector('.widget-palette-search');
  input.value = 'wea';
  r.press('Escape');
  assert.equal(input.value, '');
  assert.ok(r.document.getElementById('widget-palette'), 'the panel stays');
  r.press('Escape');
  assert.equal(r.document.getElementById('widget-palette'), null);
});

test('a panel closed from outside lets go of the keyboard', () => {
  const r = rig();
  r.panel.open('home');
  r.panel.close();
  assert.equal(r.press('Escape').prevented, false, 'Esc is free again: layout mode can use it');
});

test('search results are the same cards, and the arrows walk them', () => {
  const r = rig();
  r.panel.open('home');
  const input = r.document.querySelector('.widget-palette-search');
  input.value = 'weather';
  input._handlers.input.forEach((fn) => fn({}));
  const found = r.items();
  assert.equal(found.length, 1);
  assert.equal(found[0].dataset.idx, '0');
  assert.ok(found[0].querySelector('.widget-palette-pic img'));
  assert.ok(found[0].classList.contains('is-selected'));
  input._handlers.keydown.forEach((fn) => fn({ key: 'Enter', preventDefault() {} }));
  assert.deepEqual(r.added, ['weather on home']);
});

test('the panel is a glass sheet on Liquid, and nothing lands over it', () => {
  const sheets = read('../styles/liquid-sheets.css');
  assert.match(sheets, /:is\([^)]*\.widget-palette-overlay/);
  assert.match(sheets, /:is\([^)]*\.widget-palette-modal/);
  assert.match(read('../js/interrupt-queue.js'), /'\.widget-palette-overlay'/);
});

test('the old plate is gone: no pill, no green glyphs, no outlined boxes', () => {
  const css = read('../components/DashboardGrid/DashboardGrid.css');
  assert.doesNotMatch(css, /\.widget-palette-badge/);
  assert.doesNotMatch(read('../styles/themes-light.css'), /\.widget-palette-(badge|ico)/);
  assert.doesNotMatch(read('../styles/theme-contract.css'), /\.widget-palette-item/);
  assert.doesNotMatch(read('../styles/themes-comic.css'), /\.widget-palette-(item|cat)/);
  const ico = /\.widget-palette-ico \{[^}]*\}/.exec(css);
  assert.ok(ico);
  assert.doesNotMatch(ico[0], /accent/);
});
