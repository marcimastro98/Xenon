// js/xenon-pages.js: the one list of pages that Settings and the Xenon menu's window
// both draw as their rail. Pinned here: both hosts draw from it and nowhere else, every
// row has its name in every language and an icon, every page of Settings has panes to
// show, old names still land, and what a rail may open is what a link may ask for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const load = createRequire(import.meta.url);
const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const Pages = load('../js/xenon-pages.js');
const Icons = load('../js/xenon-menu-icons.js');
const DashboardOpen = load('../js/dashboard-open.js');
const HTML = read('index.html');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

function loadI18n() {
  const src = read('js/i18n.js');
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(src.slice(0, src.search(/^function /m)) + ';globalThis.__i18n = i18n;', ctx);
  return ctx.__i18n;
}

const all = () => [...Pages.rows(Pages.SECTIONS, []), ...Pages.foot()];

test('Settings and the menu\'s window draw the rail from this list, and only from it', () => {
  const list = HTML.slice(HTML.indexOf('id="settings-nav-scroll"'), HTML.indexOf('<div class="settings-nav-footer">'));
  assert.doesNotMatch(list, /<button/, 'no row written by hand in index.html');
  assert.match(read('js/xenon-menu.js'), /Pages\.draw\(Pages\.rows\(/);
  for (const page of ['index.html', 'menu.html']) {
    const html = read(page);
    const at = (f) => html.indexOf(`<script src="js/${f}"></script>`);
    assert.ok(at('xenon-menu-icons.js') > 0 && at('xenon-menu-icons.js') < at('xenon-pages.js'), page + ': icons first');
    assert.ok(at('xenon-pages.js') < at('dashboard-open.js'), page + ': before the links that check a page');
  }
});

test('every row and every group has its name in all 11 languages, and an icon', () => {
  const i18n = loadI18n();
  const { document } = makeDom();
  for (const r of all()) {
    const key = r.head || r.label;
    for (const l of LANGS) assert.ok(typeof i18n[l][key] === 'string' && i18n[l][key].trim(), `${key} in ${l}`);
    // Bit's row carries Bit himself (js/bit-app.js), drawn where the app is loaded.
    if (!r.head && r.icon !== 'bit') assert.ok(Icons.make(document, r.icon), `no icon ${r.icon} for ${r.page}`);
  }
});

test('every page is listed once, and every page of Settings has panes to show', () => {
  assert.equal(new Set(Pages.PAGES).size, Pages.PAGES.length);
  for (const p of Pages.PAGES.filter(Pages.isCat)) assert.match(HTML, new RegExp(`data-settings-cat="${p}"`), p);
});

test('old names land on their page; anything else on none', () => {
  assert.equal(Pages.pageOf('codex'), 'claude');
  assert.equal(Pages.pageOf('ambient'), 'lock');
  for (const old of ['mode', 'widgets', 'look', 'overlay']) assert.equal(Pages.pageOf(old), 'screens', old);
  assert.equal(Pages.pageOf('weather'), 'weather');
  for (const bad of ['', '../x', 'constructor', undefined]) assert.equal(Pages.pageOf(bad), '', String(bad));
});

test('a link may open any page of Settings, never a section of the menu by that door', () => {
  assert.equal(Pages.isCat('capture'), true, 'capture has panes too');
  for (const p of Pages.PAGES.filter(Pages.isCat)) {
    assert.deepEqual(DashboardOpen.normalize({ open: 'settings', cat: p }), { open: 'settings', cat: p }, p);
  }
  for (const s of ['screens', 'now', 'keys', '../x']) {
    assert.deepEqual(DashboardOpen.normalize({ open: 'settings', cat: s }), { open: 'settings' }, s);
  }
});

test('a place lists only its own sections, and a group left empty loses its name', () => {
  const rows = Pages.rows(['screens', 'capture'], ['weather', 'stocks', 'calendar', 'slideshow', 'claude']);
  const pages = rows.filter((r) => r.page).map((r) => r.page);
  assert.ok(pages.includes('screens') && pages.includes('capture'));
  assert.ok(!pages.includes('now') && !pages.includes('keys'));
  assert.ok(!rows.some((r) => r.head === 'settings_nav_widgets'), 'no name over nothing');
  assert.equal(rows[0].page, 'screens', 'the first group has no name: it is Xenon itself');
});

test('rows keep their language key and pick their own page', () => {
  const { document } = makeDom();
  const picked = [];
  const els = Pages.draw(Pages.rows(['screens'], []).slice(0, 3), {
    doc: document, t: (k) => 'T:' + k, icon: () => null, btn: 'b', head: 'h',
    key: (p) => (Pages.isSection(p) ? 'section' : 'cat'), pick: (p) => picked.push(p),
  });
  assert.equal(els[0].dataset.section, 'screens');
  assert.equal(els[1].className, 'h');
  assert.equal(els[1].getAttribute('aria-hidden'), 'true');
  assert.equal(els[2].dataset.cat, 'general');
  assert.equal(els[2].children[0].dataset.i18n, 'settings_cat_general');
  assert.equal(els[2].children[0].textContent, 'T:settings_cat_general');
  els[2].click();
  assert.deepEqual(picked, ['general']);
});

test('Bit opens Xenon on any page by name, and only by those names', () => {
  const line = read('server.js').split('\n').find((l) => l.includes("name: 'open_settings'"));
  const names = [...line.match(/enum: \[([^\]]*)\]/)[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(names, [...Pages.PAGES]);
  assert.match(read('js/ai.js'), /openSettings\(window\.XenonPages \? XenonPages\.pageOf\(/);
});

// Xenon opens on Screens (on General alone in the menu's window). The choice is made at the
// first open: nothing may run while the page loads, and a sheet is known only then.
test('Xenon opens on Screens, on General alone in the menu window, chosen at the first open', () => {
  const src = read('js/settings.js');
  assert.match(src, /^let _settingsCat = '';\r?$/m);
  assert.match(src, /settingsSetCategory\(_settingsCat \|\| \(isSheetPage\(\) \? 'general' : 'screens'\)\)/);
});
