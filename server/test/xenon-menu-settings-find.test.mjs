// The Xenon window's search finds rows of Settings too (js/menu/xenon-menu-settings-find.js):
// read once from the dashboard's markup, pages left out here stay out, a pick opens the row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/menu/xenon-menu-settings-find.js');

const ROWS = [
  { id: 'weather|weather_location', kind: 'row', cat: 'weather', labelKey: 'weather_location', catKey: 'settings_cat_weather', cardKey: 'weather_card' },
  { id: 'island|island_position', kind: 'row', cat: 'island', labelKey: 'island_position', catKey: 'settings_cat_island', cardKey: 'island_position' },
  { id: 'cat:weather', kind: 'cat', cat: 'weather', labelKey: 'settings_cat_weather', catKey: 'settings_cat_weather' },
];

function finder({ ok = true } = {}) {
  const fetched = [];
  const built = [];
  const node = (tag, cls, text) => ({ tag, cls, text: text || '', kids: [], listeners: {}, dataset: {},
    appendChild(k) { this.kids.push(k); }, append(...k) { this.kids.push(...k); },
    addEventListener(n, f) { this.listeners[n] = f; } });
  const window = {
    XenonPages: {
      rows: () => [{ page: 'weather', label: 'settings_cat_weather' }, { page: 'island', label: 'settings_cat_island' }, { page: 'screens', label: 'x' }],
      foot: () => [{ page: 'about', label: 'settings_cat_about' }],
      isCat: (p) => p !== 'screens',
    },
    SettingsSearch: { rowsIn: (doc, cats) => { built.push({ doc, cats }); return ROWS; } },
    FuzzyFind: {
      createIndex: (rows) => ({ rows }),
      search: (index, q) => index.rows.filter((r) => r.labelKey.includes(q)).map((entry) => ({ entry })),
      renderHighlighted: (el, text) => { el.text = text; },
    },
  };
  const ctx = {
    window, console: { warn() {} },
    fetch: (url) => { fetched.push(url); return Promise.resolve({ ok, status: ok ? 200 : 500, text: () => Promise.resolve('<html></html>') }); },
    DOMParser: class { parseFromString(s) { return { s }; } },
  };
  vm.runInNewContext(SRC, ctx);
  const opened = [];
  let redraws = 0;
  const o = (query, extra = {}) => ({
    el: node, button: (cls, text) => node('button', cls, text), tt: (k) => 'T:' + k, query, server: 'http://pc', hidden: [],
    none: false, open: (cat, id) => opened.push([cat, id]), redraw: () => { redraws++; }, ...extra,
  });
  return { F: window.XenonMenuSettingsFind, fetched, built, opened, o, redraws: () => redraws };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('the first search reads the dashboard once, by the pages the rail names, then draws again', async () => {
  const f = finder();
  assert.equal(f.F.draw(f.o('location')).length, 0, 'nothing until the rows are read');
  f.F.draw(f.o('location'));
  await settle();
  assert.deepEqual(f.fetched, ['http://pc/'], 'read once');
  assert.equal(f.redraws(), 1);
  assert.deepEqual({ ...f.built[0].cats }, { weather: 'settings_cat_weather', island: 'settings_cat_island', about: 'settings_cat_about' });
  f.F.draw(f.o('location'));
  assert.equal(f.fetched.length, 1);
});

test('a row says where it sits and opens that page on it; a page opens on its top', async () => {
  const f = finder();
  f.F.draw(f.o('weather'));
  await settle();
  const [head, list] = f.F.draw(f.o('weather'));
  assert.equal(head.text, 'T:settings_title');
  assert.equal(list.kids.length, 2);
  const [row, page] = list.kids;
  assert.equal(row.kids[0].kids[0].text, 'T:weather_location');
  assert.equal(row.kids[0].kids[1].text, 'T:settings_cat_weather › T:weather_card');
  row.kids[1].listeners.click();
  page.kids[1].listeners.click();
  assert.deepEqual(f.opened, [['weather', 'weather|weather_location'], ['weather', '']]);
  assert.equal(page.kids[0].kids.length, 1, 'a page has no crumb');
});

test('pages left out here are not results, and "nothing found" shows only when the menu found nothing too', async () => {
  const f = finder();
  f.F.draw(f.o('position'));
  await settle();
  assert.equal(f.F.draw(f.o('position'))[1].kids.length, 1);
  assert.equal(f.F.draw(f.o('position', { hidden: ['island'] })).length, 0);
  const none = f.F.draw(f.o('position', { hidden: ['island'], none: true }));
  assert.equal(none[0].text, 'T:xmenu_search_none');
});

test('a dashboard that cannot be read leaves the menu search as it was, and is tried again', async () => {
  const f = finder({ ok: false });
  f.F.draw(f.o('x'));
  await settle();
  assert.equal(f.redraws(), 0);
  f.F.draw(f.o('x'));
  await settle();
  assert.equal(f.fetched.length, 2);
});

test('the window loads the indexer and the finder before the menu, and the menu draws them', () => {
  const html = read('../menu.html');
  const at = (s) => html.indexOf(`<script src="${s}"></script>`);
  for (const s of ['js/settings-search/rows.js', 'js/settings-search/index-of-rows.js', 'js/settings-search/going.js', 'js/settings-search/settings-search.js', 'js/menu/xenon-menu-settings-find.js']) {
    assert.ok(at(s) > at('js/fuzzy-find.js') && at(s) < at('js/menu/xenon-menu.js'), s);
  }
  assert.match(read('../js/menu/xenon-menu.js'), /XenonMenuSettingsFind\?\.draw\(/);
  assert.match(read('../js/menu/screen-menu-page.js'), /id: row/);
});
