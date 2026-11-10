import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The Settings search and the "add widget" search index what the page and
// i18n.js already say, plus hidden words per category and per widget. These
// checks keep the three from drifting apart: a category without its words, a
// widget without its words, or a language that silently fell back to English
// would make the search good in some languages and blind in others.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const HTML = read('../index.html');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

function loadI18n() {
  const src = read('../js/i18n.js');
  const cut = src.search(/^function /m);
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(src.slice(0, cut) + ';globalThis.__i18n = i18n;', ctx, { filename: 'i18n.js' });
  return ctx.__i18n;
}
const i18n = loadI18n();

// Categories as the sidebar lists them, plus the one settings.js adds at
// runtime (external calendars).
function categories() {
  const cats = new Set(['calendar']);
  for (const m of HTML.matchAll(/data-settings-cat="([a-z]+)"[^>]*onclick="settingsSetCategory\(/g)) cats.add(m[1]);
  return [...cats];
}

function widgetIds() {
  const src = read('../js/settings.js');
  const m = src.match(/DASHBOARD_WIDGET_IDS = Object\.freeze\(\[([^\]]*)\]/);
  assert.ok(m, 'DASHBOARD_WIDGET_IDS moved');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function assertNativeEverywhere(key) {
  for (const l of LANGS) {
    const v = i18n[l] && i18n[l][key];
    assert.ok(typeof v === 'string' && v.trim(), `${key} missing in ${l}`);
    // Nine languages spread the English block, so a key nobody translated
    // would silently read as English there. Hidden search words must be native.
    if (l !== 'en') assert.notEqual(v, i18n.en[key], `${key} in ${l} is the English text`);
  }
}

test('every Settings category has hidden search words in all 11 languages', () => {
  const cats = categories();
  assert.ok(cats.length >= 25, `only ${cats.length} categories found — the scan broke`);
  for (const cat of cats) assertNativeEverywhere('settings_kw_' + cat);
});

test('every widget the palette can offer has hidden search words in all 11 languages', () => {
  for (const id of widgetIds()) assertNativeEverywhere('palette_kw_' + id);
});

test('the search strings are translated in every language block', () => {
  const src = read('../js/i18n.js');
  for (const key of ['settings_search_placeholder', 'settings_search_empty', 'settings_search_recent',
    'palette_search_placeholder', 'palette_search_empty', 'palette_group_builtin', 'palette_group_store',
    'palette_filter_all', 'palette_filter_installed', 'palette_store_empty', 'palette_store_safe', 'palette_open_store', 'palette_examples']) {
    const n = (src.match(new RegExp('\\b' + key + ':', 'g')) || []).length;
    assert.equal(n, LANGS.length, `${key} is defined ${n} times, expected once per language`);
  }
});

test('the palette categories only name widgets that exist', () => {
  const src = read('../js/palette-model.js');
  const ids = new Set(widgetIds());
  const block = src.match(/const WIDGET_CATEGORIES = \[([\s\S]*?)\n  \];/);
  assert.ok(block, 'WIDGET_CATEGORIES moved');
  for (const m of block[1].matchAll(/'([a-z]+)'/g)) assert.ok(ids.has(m[1]), `${m[1]} is not a widget id`);
});

test('the page wires the search in the right order', () => {
  // The field sits in the sidebar but OUTSIDE the scrolling list, so the
  // phone's folded picker (which hides the list) never hides the search.
  const nav = HTML.indexOf('id="settings-nav"');
  const field = HTML.indexOf('id="settings-search-input"');
  const list = HTML.indexOf('id="settings-nav-scroll"');
  assert.ok(nav > 0 && nav < field && field < list, 'search field between the nav and its list');
  // Results come right after the page's name, with no category of their own, so
  // settingsSetCategory never hides or shows them.
  assert.match(HTML, /id="settings-content">\s*<h1 class="settings-page-title" id="settings-page-title"[^>]*><\/h1>\s*<div class="settings-search-results" id="settings-search-results"[^>]*hidden><\/div>/);
  const pos = (s) => HTML.indexOf(`<script src="js/${s}"></script>`);
  assert.ok(pos('fuzzy-find.js') > 0, 'fuzzy-find.js loaded');
  assert.ok(pos('fuzzy-find.js') < pos('settings-search.js'));
  assert.ok(pos('fuzzy-find.js') < pos('dashboard-palette.js'));
});

test('Esc clears a search before it closes anything', () => {
  const main = read('../js/main.js');
  const esc = main.slice(main.indexOf("if (e.key === 'Escape')"));
  const settings = esc.indexOf('SettingsSearch.handleEscape()');
  const close = esc.indexOf('closeSettings()');
  assert.ok(settings > 0 && settings < close, 'the settings search is cleared before Settings closes');
});

test('search results never go through innerHTML', () => {
  // Labels come from translations and from Store package manifests.
  for (const f of ['../js/settings-search.js', '../js/fuzzy-find.js']) {
    assert.doesNotMatch(read(f), /innerHTML/, `${f} uses innerHTML`);
  }
  const palette = read('../js/dashboard-palette.js');
  // Every item (built-in, Store widget, search result) is drawn by one function;
  // its only markup is the static built-in icon table.
  const fn = palette.slice(palette.indexOf('function makeEntryItem'), palette.indexOf('function renderBlock'));
  assert.ok(fn.length > 200, 'makeEntryItem found');
  assert.doesNotMatch(fn.replace(/ico\.innerHTML = WIDGET_ICONS[^\n]*/, ''), /innerHTML/);
});

test('cards of the categories that are not open are indexed too', () => {
  // settingsSetCategory() puts `hidden` on every card outside the open
  // category, so a visibility test on the CARD indexed one category at a time:
  // "abilita vitals" found nothing unless Bit was already open. Found on the
  // first real use. Only [hidden] BELOW the card may exclude a row.
  const src = read('../js/settings-search.js');
  const build = src.slice(src.indexOf('function build()'), src.indexOf('function ensureIndex('));
  assert.doesNotMatch(build, /reachable\(card\b/);
  assert.match(build, /reachable\(row, card\)/);
});

// ── Rows behind a switch, sections, keys ──────────────────────────────────────
const SEARCH = read('../js/settings-search.js').replace(/\r\n/g, '\n');
function inner(name) {
  const m = new RegExp('^  function ' + name + '\\([\\s\\S]*?\\n  \\}', 'm').exec(SEARCH);
  assert.ok(m, name);
  return m[0];
}

// An element as these functions read it: parents, siblings, and whether it is on screen.
function box({ hidden = false, display = '', shown = true, attrs = {}, row = false } = {}) {
  const el = {
    hidden, style: { display }, dataset: {}, parentElement: null, previousElementSibling: null,
    hasAttribute: (k) => k in attrs,
    getClientRects: () => (shown ? [{}] : []),
    matches: () => row,
    querySelector: () => null,
    closest(sel) {
      for (let n = el; n; n = n.parentElement) {
        if (sel === ROW && n.matches()) return n;
        if (sel === '[data-behind-switch]' && n.hasAttribute('data-behind-switch')) return n;
        if (sel === '[data-settings-win-only]' && n.hasAttribute('data-settings-win-only')) return n;
      }
      return null;
    },
  };
  return el;
}
const ROW = '.row';
const under = (parent, child) => { child.parentElement = parent; return child; };

function searchFns(ctx) {
  const sandbox = { ROW_SEL: ROW, window: {}, ...ctx };
  vm.createContext(sandbox);
  vm.runInContext(['reachable', 'onScreen', 'landing'].map(inner).join('\n') + '\nthis.fns = { reachable, landing };', sandbox);
  return sandbox.fns;
}

test('a row hidden for this PC is not a result, a row behind a switch of its own is', () => {
  const { reachable } = searchFns({});
  const card = box();
  assert.equal(reachable(under(under(card, box({ hidden: true })), box()), card), false);
  assert.equal(reachable(under(under(card, box({ display: 'none' })), box()), card), false);
  const gate = under(card, box({ hidden: true, attrs: { 'data-behind-switch': 1 } }));
  assert.equal(reachable(under(gate, box()), card), true);
  assert.equal(reachable(under(card, box()), card), true);
});

test('a result behind a switch that is off lands on that switch', () => {
  const root = box();
  const master = under(root, box({ row: true }));
  const input = under(master, box());
  const gate = under(root, box({ shown: false, attrs: { 'data-behind-switch': 1 } }));
  gate.dataset.behindSwitch = 'master';
  const row = under(gate, box({ shown: false }));
  const { landing } = searchFns({
    content: () => root,
    document: { getElementById: (id) => (id === 'master' ? input : null) },
  });
  assert.equal(landing(row), master);
  assert.equal(landing(master), master, 'a row on screen is the place itself');
});

test('a row that went away with no switch named lands on the row before it', () => {
  const root = box();
  const before = under(root, box({ row: true }));
  const gone = under(root, box({ shown: false }));
  gone.previousElementSibling = before;
  const { landing } = searchFns({ content: () => root, document: { getElementById: () => null } });
  assert.equal(landing(gone), before);
});

test('every block behind a switch names a switch that is on the page', () => {
  const named = [...HTML.matchAll(/data-behind-switch="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(named.length >= 4);
  for (const id of named) assert.ok(HTML.includes('id="' + id + '"'), id);
});

test('sections and rows that open are entries, and a result says where it sits', () => {
  assert.match(SEARCH, /const PLACE_SEL = 'details, \.settings-section';/);
  assert.match(SEARCH, /card\.querySelectorAll\(PLACE_SEL\)\.forEach/);
  assert.match(SEARCH, /const cardKey = placeOf\(row, card, headKey\);/);
  assert.match(SEARCH, /const cardKey = placeOf\(btn, card, headKey\);/);
});

test('a key beside others in a row of keys is found by its own name', () => {
  // Only rows that became entries hold their keys back.
  const at = SEARCH.indexOf('inRow.add(row)');
  assert.ok(at > SEARCH.indexOf('if (!labelKey || labelKey === headKey) return;'), 'a row with no name of its own is not one');
  assert.match(SEARCH, /if \(\[\.\.\.inRow\]\.some\(\(r\) => r\.contains\(btn\)\) \|\| !reachable\(btn, card\)\) return;/);
});
