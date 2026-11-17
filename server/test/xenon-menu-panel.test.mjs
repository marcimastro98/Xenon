// The Xenon menu inside the dashboard (js/menu/xenon-menu-panel.js): its sections are pages
// of Settings. A section is drawn into #settings-place, another page of Settings takes
// it away, Esc goes one step at a time and is given up while a key is recorded or a
// search typed, and in the menu's own window (a sheet) the sections go back to the menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));   // objects made inside the vm
const Pages = createRequire(import.meta.url)('../js/menu/xenon-pages.js');

function rig({ sheet = false } = {}) {
  const { document, MutationObserver } = makeDom();
  const overlay = document.createElement('div');
  overlay.id = 'settings-overlay';
  overlay.hidden = true;
  const place = document.createElement('div');
  place.id = 'settings-place';
  overlay.append(place);
  document.body.append(overlay);
  const calls = { opened: [], closed: 0, menu: [], created: 0, shown: [], destroyed: 0, runs: [] };
  const view = { steps: 0, holds: false, opts: null };
  const window = { addEventListener() {}, XenonPages: Pages };
  window.XenonSheet = sheet ? { onMenu: (o) => calls.menu.push(o) } : undefined;
  window.DashboardOpen = { run: (o) => calls.runs.push(o) };
  window.XenonMenuView = {
    create(root, opts) {
      calls.created += 1;
      view.opts = opts;
      view.root = root;
      return {
        show: (s) => calls.shown.push(s),
        load: async () => {},
        destroy: () => { calls.destroyed += 1; },
        holdsEsc: () => view.holds,
        stepBack: () => { if (view.steps > 0) { view.steps -= 1; return true; } return false; },
      };
    },
  };
  const box = {
    window, document, MutationObserver, t: (k) => k, SERVER: '', setTimeout, clearTimeout,
    XenonPages: Pages, XenonMenuView: window.XenonMenuView,
    isSheetPage: () => sheet,
    openSettings: (cat) => { calls.opened.push(cat); overlay.hidden = false; },
    closeSettings: () => { calls.closed += 1; overlay.hidden = true; },
  };
  vm.runInNewContext(read('js/menu/xenon-menu-panel.js'), box);
  const panel = window.XenonMenuPanel;
  // What settingsSetCategory does: the overlay opens, the page is asked to draw.
  const go = (cat) => { overlay.hidden = false; panel.page(Pages.pageOf(cat) || cat); };
  return { document, overlay, place, panel, calls, view, go };
}

test('a section of the menu is drawn in Settings, with no rail of its own, by one view', () => {
  const { place, calls, view, go } = rig();
  go('screens');
  assert.equal(place.dataset.settingsCat, 'screens', 'Settings shows the box on this page');
  assert.equal(place.children[0].id, 'xm-root');
  assert.equal(view.opts.bare, true);
  assert.equal(view.opts.place, 'dashboard');
  go('keys');
  assert.equal(calls.created, 1, 'the next section reuses the view');
  assert.deepEqual(calls.shown, ['screens', 'keys']);
});

test('a page of Settings takes the menu away; the box hides with the other pages', () => {
  const { place, calls, go } = rig();
  go('now');
  go('weather');
  assert.equal(place.dataset.settingsCat, '');
  assert.equal(place.children.length, 0);
  assert.equal(calls.destroyed, 1);
});

test('closing Settings drops the menu, and it opens fresh next time', () => {
  const { place, overlay, calls, go } = rig();
  go('screens');
  overlay.hidden = true;
  assert.equal(calls.destroyed, 1);
  assert.equal(place.children.length, 0);
  go('screens');
  assert.equal(calls.created, 2);
});

test('the old ways in still land: a section, an old name, nothing', () => {
  const { panel, calls } = rig();
  panel.open('now');
  panel.open('widgets');
  panel.open('mode');
  panel.open('');
  assert.deepEqual(calls.opened, ['now', 'screens', 'screens', 'screens']);
});

test('Esc goes back one step, is left alone while a key is recorded, and then closes', () => {
  const { panel, view, go } = rig();
  assert.equal(panel.escape(), false, 'nothing open, nothing taken');
  go('screens');
  view.steps = 1;
  assert.equal(panel.escape(), true, 'a widget\'s screen goes back to the list');
  assert.equal(panel.escape(), false, 'then Settings closes');
  view.holds = true;
  assert.equal(panel.escape(), true, 'what is going on inside answers it');
});

test('a row leading to another page stays in Settings; any other closing row closes it', () => {
  const { calls, view, go } = rig();
  go('now');
  view.opts.onClose({ open: 'settings:weather' });
  assert.equal(calls.closed, 0);
  view.opts.onClose({ run: { type: 'screenshot' } });
  assert.equal(calls.closed, 1);
  view.opts.onOpen('settings:weather');
  view.opts.onOpen('gallery:shots');
  assert.deepEqual(plain(calls.runs), [{ open: 'settings', cat: 'weather' }, { open: 'gallery', kind: 'shots' }]);
});

test('in the menu\'s own window Settings sends the sections back to the menu; capture stays a page', () => {
  const { place, calls, go } = rig({ sheet: true });
  go('keys');
  assert.deepEqual(plain(calls.menu), [{ open: true, section: 'keys' }]);
  go('capture');
  assert.equal(calls.menu.length, 1, 'capture is Settings\' own page there');
  assert.equal(calls.created, 0);
  assert.equal(place.dataset.settingsCat, '');
});

test('nothing starts over the menu: a screensaver, a promo', () => {
  assert.match(read('js/ambient/ambient-mode.js'), /const OVERLAY_IDS = \[[^\]]*'settings-overlay'/);
  assert.match(read('js/alerts/interrupt-queue.js'), /'#settings-place > #xm-root',/);
  assert.doesNotMatch(read('js/ambient/ambient-mode.js') + read('js/alerts/interrupt-queue.js'), /xm-scrim/);
});
