// The Xenon menu as a dialog over the dashboard: the keyboard stays in it, Esc goes one
// step at a time, and it gives Esc up while a key is being recorded or a search is typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom, windowKeys, settle } from './mini-dom.mjs';

const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

function rig() {
  const { document } = makeDom();
  const window = { addEventListener() {} };
  const keys = windowKeys(window);
  const view = { steps: 0, holds: false, shown: [] };
  const box = {
    window, document, t: (k) => k, SERVER: '',
    setTimeout, clearTimeout,
  };
  box.XenonMenuView = window.XenonMenuView = {
    create(root) {
      const nav = document.createElement('button');
      nav.className = 'xm-nav-btn';
      nav.setAttribute('aria-current', 'true');
      const focus = nav.focus;
      nav.focus = (how) => { view.focusedHow = how; focus.call(nav, how); };
      root.append(nav);
      return {
        show: (s) => view.shown.push(s),
        load: async () => {},
        destroy() {},
        holdsEsc: () => view.holds,
        stepBack: () => { if (view.steps > 0) { view.steps -= 1; return true; } return false; },
      };
    },
  };
  vm.runInNewContext(read('js/dialog-focus.js'), box);
  vm.runInNewContext(read('js/xenon-menu-panel.js'), box);
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  const press = (key) => {
    let stopped = false;
    keys.slice().forEach((fn) => fn({ key, shiftKey: false, preventDefault() {}, stopPropagation() { stopped = true; } }));
    return stopped;
  };
  return { document, opener, press, view, panel: window.XenonMenuPanel };
}

test('the keyboard comes in and goes back to where it was', async () => {
  const { document, opener, panel, press } = rig();
  panel.open('now');
  await settle();
  assert.equal(document.activeElement.className, 'xm-nav-btn');
  press('Escape');
  assert.equal(panel.isOpen(), false);
  assert.equal(document.activeElement, opener);
});

test('it opens with no ring: the ring is for Tab, and nobody may be at the keyboard', async () => {
  const { panel, view } = rig();
  panel.open('now');
  await settle();
  assert.equal(view.focusedHow && view.focusedHow.focusVisible, false);
});

test('Esc goes back one step before it closes', async () => {
  const { panel, press, view } = rig();
  panel.open('widgets');
  await settle();
  view.steps = 1;
  assert.equal(press('Escape'), true);
  assert.equal(panel.isOpen(), true);
  press('Escape');
  assert.equal(panel.isOpen(), false);
});

test('Esc is left alone while a key is being recorded or a search typed', async () => {
  const { panel, press, view } = rig();
  panel.open('keys');
  await settle();
  view.holds = true;
  assert.equal(press('Escape'), false, 'what is going on inside answers it');
  assert.equal(panel.isOpen(), true);
});

test('Tab stays in the menu', async () => {
  const { document, panel, press, opener } = rig();
  panel.open('now');
  await settle();
  press('Tab');
  assert.notEqual(document.activeElement, opener);
});

test('a closed menu lets go of the keyboard', async () => {
  const { document, panel, press, opener } = rig();
  panel.open('now');
  await settle();
  panel.close();
  assert.equal(document.querySelector('.xm-scrim'), null);
  assert.equal(press('Tab'), false);
  assert.equal(document.activeElement, opener);
});

test('nothing starts over the menu: a screensaver, a promo', () => {
  assert.match(read('js/ambient-mode.js'), /const OVERLAY_SELECTOR = '[^']*\.xm-scrim/);
  assert.match(read('js/interrupt-queue.js'), /'\.xm-scrim',/);
});
