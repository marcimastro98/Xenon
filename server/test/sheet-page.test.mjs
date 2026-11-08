// A sheet: Settings, the Store, Scintille or the gallery alone in the Xenon menu's
// window, instead of a whole dashboard in a window of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const DashboardOpen = require('../js/dashboard-open.js');
const { createScreenMenu } = require('../screen-menu.js');

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

function sheetPage({ settingsHidden = true, overlays = [], section = 'now' } = {}) {
  const listeners = {};
  const settings = { hidden: settingsHidden };
  const replaced = [];
  const posts = [];
  const stored = { 'xenon.menuSection': section };
  const has = (sel) => overlays.some((o) => sel.includes(o));
  const window = {
    location: { replace: (a) => replaced.push(a) },
    addEventListener: (n, f) => { (listeners[n] ||= []).push(f); },
  };
  const ctx = {
    window,
    isSheetPage: () => true,
    DashboardOpen,
    sessionStorage: { setItem: (k, v) => { stored[k] = v; }, getItem: (k) => stored[k] ?? null },
    SERVER: '',
    fetch: (url, o) => { posts.push({ url, body: JSON.parse(o.body) }); return Promise.resolve({ ok: true }); },
    document: {
      body: { dataset: {} },
      getElementById: () => settings,
      querySelector: (sel) => (has(sel) ? {} : null),
      querySelectorAll: (sel) => overlays.filter((o) => sel.includes(o)),
    },
    setTimeout, clearTimeout,
    MutationObserver: class { observe() {} },
    Object,
  };
  vm.runInNewContext(read('../js/sheet-page.js'), ctx);
  const press = (key = 'Escape', extra = {}) => {
    const e = { key, defaultPrevented: false, ...extra };
    listeners.keydown.forEach((f) => f(e));
  };
  return { ctx, window, replaced, posts, stored, press, settings };
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
  assert.deepEqual(pushes.at(-1), { open: true, section: 'now', sheet: { open: 'settings' } });
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
  assert.match(read('../js/sheet-page.js'), /const showing = .*.wn-stage/);
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
  for (const f of ['toast.js', 'capture-gallery.js', 'place-installed.js']) {
    assert.match(read('../js/' + f), /isLayerPage\(\) && !isSheetPage\(\)/, f);
  }
  const widgets = read('../js/custom-widget.js');
  assert.match(widgets, /const layerOnly = .*isSheetPage\(\)/);
  assert.match(widgets, /const layerSurface = .*isSheetPage\(\)/);
  assert.match(read('../js/layers-shell.js'), /panel=sheet/, 'only the main page syncs the layers');
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
  for (const hide of ['.sheet-off:not(.active)', '[data-dash-card]', '.settings-tutorial-group', '.settings-row:has([onclick="openXenonMenu()"])']) {
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
  assert.ok(at(menuHtml, 'dashboard-open.js') < at(menuHtml, 'screen-menu-page.js'));
  const index = read('../index.html');
  assert.ok(at(index, 'dashboard-open.js') < at(index, 'sheet-page.js'));
  assert.ok(at(index, 'sheet-page.js') < at(index, 'main.js'));
  assert.match(index, /components\/SheetPage\/SheetPage\.css/);
  assert.match(read('../js/main.js'), /VALID_PANELS = \[.*'sheet'\]/);
  assert.match(read('../js/main.js'), /XenonSheet\.onMenu/);

  const page = read('../js/screen-menu-page.js');
  assert.doesNotMatch(page, /open-dashboard\?' \+/, 'no screen goes through the dashboard signal any more');
  assert.match(page, /open-dashboard\?open=dashboard/);
  assert.match(read('../js/update.js'), /isSheetPage\(\)\) \{\n\s+try \{ window\.location\.href = .*open-dashboard\?open=update/);
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

test('Esc closes the screen only when nothing sits above it', () => {
  const calls = [];
  const closing = (page) => { page.ctx.closeSettings = () => calls.push('settings'); };

  const plain = sheetPage({ settingsHidden: false });
  closing(plain);
  plain.press();
  assert.deepEqual(calls, ['settings']);

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
