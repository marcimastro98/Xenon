// A sheet: Settings, the Store, Scintille or the gallery alone in the Xenon menu's
// window, instead of a whole dashboard in a window of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const DashboardOpen = require('../js/grid/dashboard-open.js');
const { createScreenMenu } = require('../menu/screen-menu.js');

const ID = '0123456789abcdef';

function menu(available = true) {
  const pushes = [];
  const m = createScreenMenu({ host: { menus: () => available }, broadcast: (s) => pushes.push(s) });
  return { m, pushes };
}

// utils.js is a plain page script: only the two address checks run here.
function pageChecks(search) {
  const src = read('../js/utils.js');
  const from = src.indexOf('function isLayerPage()');
  const to = src.indexOf('function openSettingsCategory');
  const ctx = { window: { location: { search } } };
  vm.runInNewContext(src.slice(from, to).replace(/\/\/ A tile's[\s\S]*$/, ''), ctx);
  return ctx;
}

function sheetPage({ settingsHidden = true, overlays = [], section = 'now', search = '' } = {}) {
  const listeners = {};
  const settings = { hidden: settingsHidden };
  const replaced = [];
  const posts = [];
  const stored = { 'xenon.menuSection': section };
  const has = (sel) => overlays.some((o) => sel.includes(o));
  const window = {
    location: { search, replace: (a) => replaced.push(a), set href(v) { signals.push(v); } },
    addEventListener: (n, f) => { (listeners[n] ||= []).push(f); },
    __xenonSignal: (u) => u,
  };
  const signals = [];
  const classes = new Set();
  const ctx = {
    window,
    isSheetPage: () => true,
    DashboardOpen,
    sessionStorage: { setItem: (k, v) => { stored[k] = v; }, getItem: (k) => stored[k] ?? null },
    SERVER: '',
    fetch: (url, o) => { posts.push({ url, body: JSON.parse(o.body) }); return Promise.resolve({ ok: true }); },
    document: {
      readyState: 'complete',
      documentElement: { classList: { add: (c) => classes.add(c) } },
      body: { dataset: {} },
      getElementById: () => settings,
      querySelector: (sel) => (has(sel) ? {} : null),
      querySelectorAll: (sel) => overlays.filter((o) => sel.includes(o)),
    },
    setTimeout, clearTimeout,
    MutationObserver: class { observe() {} },
    Object,
  };
  vm.runInNewContext(read('../js/ai/sheet-page.js'), ctx);
  const press = (key = 'Escape', extra = {}) => {
    let stopped = false;
    const e = { key, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; }, stopImmediatePropagation() { stopped = true; }, ...extra };
    for (const f of listeners.keydown) { if (stopped) break; f(e); }
  };
  return { ctx, window, replaced, posts, stored, press, settings, signals, classes, listeners };
}

test('only the screens the menu window can hold open as a sheet, with safe values only', () => {
  const { sheet, sheetAddress } = DashboardOpen;
  assert.equal(sheetAddress({ open: 'settings', cat: 'appearance' }), '/?panel=sheet&open=settings&cat=appearance');
  assert.equal(sheetAddress({ open: 'store' }), '/?panel=sheet&open=store');
  assert.equal(sheetAddress({ open: 'sparks' }), '/?panel=sheet&open=sparks');
  assert.equal(sheetAddress({ open: 'gallery', filter: 'video', id: ID }), `/?panel=sheet&open=gallery&filter=video&id=${ID}`);
  assert.equal(sheetAddress({ open: 'chat' }), '/?panel=sheet&open=chat');
  assert.equal(sheetAddress({ open: 'mixer' }), '/?panel=sheet&open=mixer');
  assert.equal(sheetAddress({ open: 'macro', id: 'k1' }), '/?panel=sheet&open=macro&id=k1');
  assert.equal(sheetAddress({ open: 'settings', cat: '../x' }), '/?panel=sheet&open=settings');
  // A row of Settings found by the Xenon window's search: its id only with its page, only as the search names rows.
  assert.equal(sheetAddress({ open: 'settings', cat: 'weather', id: 'weather|weather_location' }), '/?panel=sheet&open=settings&id=weather%7Cweather_location&cat=weather');
  assert.equal(sheetAddress({ open: 'settings', cat: 'about', id: 'about|deck_act_bugReport#2' }), '/?panel=sheet&open=settings&id=about%7Cdeck_act_bugReport%232&cat=about');
  for (const id of ['<b>', 'weather|x y', 'weather', 'Weather|x', 'weather|' + 'x'.repeat(81), 7]) {
    assert.equal(sheetAddress({ open: 'settings', cat: 'weather', id }), '/?panel=sheet&open=settings&cat=weather', String(id));
  }
  assert.equal(sheetAddress({ open: 'settings', id: 'weather|weather_location' }), '/?panel=sheet&open=settings', 'no page, no row');
  for (const open of ['update', 'dashboard', 'nope', '', null]) {
    assert.equal(sheet({ open }), null, String(open));
    assert.equal(sheetAddress({ open }), '');
  }
  assert.equal(sheet(null), null);
  assert.equal(sheet('settings'), null);
});

test('the server opens a sheet only where a shell draws the menu, and forgets it when the menu changes', () => {
  const off = menu(false);
  assert.equal(off.m.showSheet({ open: 'settings' }), 'closed', 'the caller opens the dashboard as before');
  assert.equal(off.pushes.length, 0);

  const { m, pushes } = menu();
  assert.equal(m.showSheet({ open: 'update' }), 'closed', 'nothing a sheet cannot show');
  assert.equal(m.showSheet({ open: 'settings', cat: 'nope', evil: 1 }), 'screen');
  assert.deepEqual(pushes.at(-1), { open: true, section: 'screens', sheet: { open: 'settings' } });
  assert.deepEqual(m.get().sheet, { open: 'settings' }, 'the window that opens now reads it');

  m.show({ section: 'keys' });
  assert.equal(pushes.at(-1).section, 'keys');
  assert.equal(pushes.at(-1).sheet, undefined);

  m.showSheet({ open: 'store' });
  m.show({ section: 'keys' });
  assert.equal(m.get().sheet, undefined, 'the same section still takes the window back from a sheet');
  assert.equal(pushes.at(-1).sheet, undefined);

  m.showSheet({ open: 'gallery' });
  m.close();
  assert.equal(m.get().sheet, undefined, 'closed, the next open is the menu');
});

test("What's New in the menu window: the stage counts as the screen, and closing it goes back to the menu", () => {
  assert.match(read('../js/ai/sheet-page.js'), /const showing = .*.wn-stage/);
  const m = menu().m;
  assert.equal(m.showSheet({ open: 'whatsnew' }), 'screen');
  assert.deepEqual(m.get().sheet, { open: 'whatsnew' });
});

test('a sheet is quiet like a layer page, and only the exact address is one', () => {
  for (const s of ['?panel=sheet', '?panel=sheet&open=store', '?x=1&panel=sheet']) {
    const c = pageChecks(s);
    assert.equal(c.isSheetPage(), true, s);
    assert.equal(c.isLayerPage(), true, s);
  }
  for (const s of ['', '?panel=sheets', '?panel=media', '?open=settings']) {
    assert.equal(pageChecks(s).isSheetPage(), false, s);
    assert.equal(pageChecks(s).isLayerPage(), false, s);
  }
  const layer = pageChecks('?layer=overlay:1');
  assert.equal(layer.isLayerPage(), true);
  assert.equal(layer.isSheetPage(), false);
});

test('what a sheet must keep doing: toasts, the gallery, placing what was installed, and no widget frames', () => {
  for (const f of ['alerts/toast.js', 'capture-gallery/capture-gallery.js', 'store-catalog/place-installed.js']) {
    assert.match(read('../js/' + f), /isLayerPage\(\) && !isSheetPage\(\)/, f);
  }
  const widgets = read('../js/custom-widget/custom-widget.js');
  assert.match(widgets, /const layerOnly = .*isSheetPage\(\)/);
  assert.match(widgets, /const layerSurface = .*isSheetPage\(\)/);
  assert.match(read('../js/layers-shell/layers-shell.js'), /panel=sheet/, 'only the main page syncs the layers');
  assert.match(read('../js/custom-bg.js'), /function apply\(code, assets, fps, guard\) \{[^}]*isSheetPage\(\)\) return;/, 'no animated background behind a sheet');
});

test('a low window keeps the pages in reach: the rows under them scroll with them', () => {
  const css = read('../components/SheetPage/SheetPage.css');
  const low = css.slice(css.indexOf('@media (min-width: 721px) and (max-height: 560px)'));
  assert.match(low, /#settings-overlay \.settings-nav \{ overflow-y: auto; \}/);
  assert.match(low, /#settings-overlay \.settings-nav-scroll \{ flex: 0 0 auto; overflow: visible; \}/);
});

// The page's own rules name the overlay's id: a rule that hides a row here has to weigh
// as much, or the widgets-only list comes back whole (it did, 30 rows instead of 19).
test('what the window hides outweighs the page', () => {
  const css = read('../components/SheetPage/SheetPage.css');
  for (const hide of ['.sheet-off:not(.active)', '[data-dash-card]', '.settings-row:has([onclick="openXenonMenu()"])']) {
    const line = css.split('\n').find((l) => l.includes(hide));
    assert.ok(line, hide);
    assert.ok(line.includes('#settings-overlay'), hide + ' has no id');
  }
});

test('the pages are wired: the menu goes to a sheet in place, and the dashboard stays a signal', () => {
  const menuHtml = read('../menu.html');
  const at = (html, file) => {
    const i = html.indexOf(`<script src="js/${file}"`);
    assert.ok(i >= 0, file);
    return i;
  };
  assert.ok(at(menuHtml, 'grid/dashboard-open.js') < at(menuHtml, 'menu/screen-menu-page.js'));
  const index = read('../index.html');
  assert.ok(at(index, 'grid/dashboard-open.js') < at(index, 'ai/sheet-page.js'));
  assert.ok(at(index, 'ai/sheet-page.js') < at(index, 'main.js'));
  assert.match(index, /components\/SheetPage\/SheetPage\.css/);
  assert.match(read('../js/main.js'), /VALID_PANELS = \[.*'sheet'\]/);
  assert.match(read('../js/main.js'), /\['XenonSheet', 'LayersShell', 'UsageAskKey'\]\.forEach\(\(name\) => \{ try \{ window\[name\]\?\.onMenu/);

  const page = read('../js/menu/screen-menu-page.js');
  assert.doesNotMatch(page, /open-dashboard\?' \+/, 'no screen goes through the dashboard signal any more');
  assert.match(page, /open-dashboard\?open=dashboard/);
  assert.match(read('../js/update/update.js'), /isSheetPage\(\)\) \{\n\s+try \{ window\.location\.href = .*open-dashboard\?open=update/);
});

test('a screen asked for elsewhere replaces the sheet; a menu section goes back to the menu on it', () => {
  const a = sheetPage();
  a.ctx.window.XenonSheet.onMenu({ open: true, section: 'now', sheet: { open: 'store' } });
  assert.deepEqual(a.replaced, ['/?panel=sheet&open=store']);

  const b = sheetPage();
  b.ctx.window.XenonSheet.onMenu({ open: true, section: 'keys' });
  assert.deepEqual(b.replaced, ['/menu?back=1']);
  assert.equal(b.stored['xenon.menuSection'], 'keys');

  const c = sheetPage();
  c.ctx.window.XenonSheet.onMenu({ open: false, section: 'now' });
  c.ctx.window.XenonSheet.onMenu(null);
  assert.deepEqual(c.replaced, [], 'closed: the shell takes the window away');
});

test('Esc closes the screen only when nothing sits above it', async () => {
  const calls = [];
  const closing = (page) => { page.ctx.closeSettings = () => calls.push('settings'); };

  // Settings is a page of the window: Esc closes the window, never back to Screens.
  const plain = sheetPage({ settingsHidden: false });
  closing(plain);
  plain.press();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, []);
  assert.deepEqual(plain.posts, [{ url: '/screen-menu', body: { open: false } }]);
  assert.deepEqual(plain.replaced, ['/menu?back=1']);

  const widget = sheetPage({ settingsHidden: false });
  widget.ctx.window.XenonMenuPanel = { escape: () => true };
  widget.press();
  assert.deepEqual(widget.posts, [], "a widget's screen in Settings closes first");

  const searching = sheetPage({ settingsHidden: false });
  searching.settings.value = 'meteo';
  closing(searching);
  searching.press();
  assert.deepEqual(searching.posts, [], 'a search is cleared first');
  calls.length = 0;

  calls.length = 0;
  const dialog = sheetPage({ settingsHidden: false, overlays: ['.preset-modal-overlay'] });
  closing(dialog);
  dialog.press();
  assert.deepEqual(calls, [], 'a dialog over Settings closes first');

  const select = sheetPage({ settingsHidden: false, overlays: ['.cs-wrap.cs-open'] });
  closing(select);
  select.press();
  assert.deepEqual(calls, [], 'an open list closes first');

  const answered = sheetPage({ settingsHidden: false });
  closing(answered);
  answered.press('Escape', { defaultPrevented: true });
  answered.press('a');
  assert.deepEqual(calls, []);
});

test('Settings in the window has no close button: it would only lead back to Screens', () => {
  assert.ok(read('../components/SheetPage/SheetPage.css').includes('body[data-panel="sheet"] #settings-overlay .settings-close { display: none; }'));
});

test('a dashboard-only mark sits on the whole card, so no orphan toggle stays behind its title', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const marked = html.match(/<[a-z]+ data-dash-card[^>]*>/g);
  assert.ok(marked.length >= 3);
  for (const tag of marked) assert.match(tag, /class="settings-group /);
});

test('a screen opened straight from a key closes the window: no menu lands over the game', async () => {
  const direct = sheetPage({ section: '' });
  direct.ctx.window.XenonSheet.back();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(direct.posts, [{ url: '/screen-menu', body: { open: false } }]);
  assert.deepEqual(direct.replaced, ['/menu?back=1'], 'hidden, the window still goes back to its page');

  const fromMenu = sheetPage({ section: 'keys' });
  fromMenu.ctx.window.XenonSheet.back();
  assert.deepEqual(fromMenu.posts, [], 'opened from the menu, it goes back to the menu');
  assert.deepEqual(fromMenu.replaced, ['/menu?back=1']);
});

test("Bit's pocket alone in its own little window: it says when it is done, and the menu's moves are not its own", async () => {
  const p = sheetPage({ section: '', search: '?panel=sheet&open=pocket&alone=pocket' });
  assert.ok(p.classes.has('is-pocket-window'));
  p.ctx.window.XenonSheet.onMenu({ open: true, section: 'keys' });
  assert.deepEqual(p.replaced, [], 'the menu opening elsewhere leaves it be');
  p.ctx.window.XenonSheet.back();
  await Promise.resolve();
  assert.deepEqual(p.signals, ['xenon-app:bit-pocket-close']);
  assert.deepEqual([p.posts, p.replaced], [[], []], 'no menu to close, no page to change');
  p.ctx.window.XenonSheet.back();
  assert.equal(p.signals.length, 1, 'once');
  const opened = [];
  p.ctx.DashboardOpen = { run: (req) => opened.push(req) };
  p.ctx.window.XenonSheet.again();
  p.ctx.window.XenonSheet.back();
  assert.equal(JSON.stringify([opened, p.signals.length]), JSON.stringify([[{ open: 'pocket' }], 2]), 'opened again, a fresh pocket that can close again');

  const menu = sheetPage({ section: '' });
  assert.ok(!menu.classes.has('is-pocket-window'));
  menu.ctx.window.XenonSheet.again();
  assert.deepEqual(menu.signals, []);
});

test('the pocket window goes when the pocket closes, whatever a page left behind it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pocket = sheetPage({ section: '', search: '?panel=sheet&open=pocket&alone=pocket', overlays: ['.bitc-overlay'] });
  const menu = sheetPage({ section: '', overlays: ['.bitc-overlay'] });
  for (const p of [pocket, menu]) {
    p.ctx.document.getElementById = (id) => (id === 'settings-overlay' ? p.settings : null); // no Settings list to shorten
    p.listeners.load.forEach((f) => f());
  }
  t.mock.timers.tick(1500); // the page's grace, then the settle of what it sees
  t.mock.timers.tick(400);
  assert.deepEqual(pocket.signals, ['xenon-app:bit-pocket-close'], 'the room behind it does not keep it');
  assert.deepEqual([menu.signals, menu.posts], [[], []], "in the menu's window the room is a screen of its own");
});

test('the pocket window fits its card and runs keys only once it is gone', () => {
  const css = read('../components/BitPocket/BitPocket.css');
  assert.match(css, /html.is-pocket-window .bitp.is-sheet .bitp-card { position: static;/);
  const pocket = read('../js/bit-companion/pocket.js');
  assert.ok(pocket.indexOf('window.XenonSheet?.back()') < pocket.indexOf("post('/screen-menu', { run: what.run })"));
});
