import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom, settle, windowKeys } from './mini-dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(HERE, '..', 'js', name), 'utf8');
const SRC = read('dialog-focus.js') + read('performance.js');

// The window behind "Optimize". It stops the page, so it behaves like every other
// dialog that does: the focus goes in and comes back, Esc closes it, Tab stays inside,
// and the moving background holds still under its blur.

const SERVER_ANSWERS = {
  '/windows': { windows: [{ id: 7, app: 'Chrome', title: 'Twelve tabs' }, { id: 8, app: 'OneDrive', title: 'Up to date' }] },
  '/api/performance/stats': { ok: true, apps: [{ proc: 'chrome', memMB: 2100 }], totalMB: 32000, freeMB: 9000 },
  '/api/gamemode/status': { activity: 'other' },
  '/api/performance/plan': { ok: true, plan: { explanation: 'Chrome is the heavy one.', closeApps: ['Chrome'] } },
};

function rig({ opts = {}, useAi = false, platform = 'win32', windows, shield = { ok: true, available: true, cores: 2, moved: [] } } = {}) {
  const { document } = makeDom();
  const freezes = [];
  const performance = {
    opts: { pauseAnimations: true, powerPlan: 'high', priorityBoost: false, manageApps: false, shield: true, ...opts },
    useAi,
    active: false,
  };
  const window = {
    ambientFreeze: (token, on) => freezes.push([token, on]),
    BitApp: { icon: () => '<svg></svg>' },
    XenonPlatform: platform,
  };
  const keys = windowKeys(window);
  vm.runInNewContext(SRC, {
    window,
    document,
    console,
    hubSettings: { performance, aiProvider: 'ollama' },
    normalizePerformance: (p) => p,
    t: () => '',
    SERVER: '',
    fetch: async (url) => ({ json: async () => (url === '/api/performance/shield' ? shield : (windows && url === '/windows' ? { windows } : SERVER_ANSWERS[url])) || {} }),
  });
  const trigger = document.createElement('button');
  document.body.append(trigger);
  trigger.focus();
  const press = (key, shiftKey = false) => {
    keys.slice().forEach((fn) => fn({ key, shiftKey, preventDefault() {}, stopPropagation() {} }));
  };
  return {
    document, freezes, trigger, press, keys,
    open: async () => { await window.PerfMode.optimize(); await settle(); },
    sheet: () => document.querySelector('.perf-sheet-overlay'),
    apply: () => document.querySelector('.perf-btn-primary'),
    cancel: () => document.querySelector('.perf-btn-ghost'),
  };
}

test('it opens with the main key in focus and the background held', async () => {
  const r = rig();
  await r.open();
  assert.equal(r.sheet().hidden, false);
  assert.equal(r.document.activeElement, r.apply());
  assert.deepEqual(r.freezes, [['perf-sheet', true]]);
  assert.equal(r.document.querySelector('.perf-sheet').getAttribute('aria-label'), 'Performance optimization');
});

test('Esc closes it and the focus goes back where it was', async () => {
  const r = rig();
  await r.open();
  r.press('Escape');
  assert.equal(r.sheet().hidden, true);
  assert.equal(r.document.activeElement, r.trigger);
  assert.deepEqual(r.freezes, [['perf-sheet', true], ['perf-sheet', false]]);
  assert.equal(r.keys.length, 0, 'no key listener stays behind');
});

test('Cancel does the same, and a second close changes nothing', async () => {
  const r = rig();
  await r.open();
  r.cancel().click();
  r.cancel().click();
  assert.equal(r.sheet().hidden, true);
  assert.equal(r.freezes.length, 2);
});

test('a trigger that left the page takes no focus back', async () => {
  const r = rig();
  await r.open();
  r.trigger.remove();
  r.press('Escape');
  assert.notEqual(r.document.activeElement, r.trigger);
});

test('opened again, it holds the background again', async () => {
  const r = rig();
  await r.open();
  r.press('Escape');
  await r.open();
  assert.equal(r.sheet().hidden, false);
  assert.equal(r.freezes.length, 3);
  assert.equal(r.keys.length, 1);
});

test('Tab goes round inside and skips what is hidden', async () => {
  const r = rig();
  await r.open();
  const pause = r.document.querySelector('[data-opt="pauseAnimations"]');
  const plan = r.document.querySelector('[data-opt="powerPlan"]');
  const shield = r.document.querySelector('[data-opt="shield"]');

  r.press('Tab');
  assert.equal(r.document.activeElement, pause, 'from the last key back to the first row');
  r.press('Tab');
  assert.equal(r.document.activeElement, plan);
  r.press('Tab');
  assert.equal(r.document.activeElement, shield, 'the priority row is hidden with no app to boost');
  r.press('Tab');
  assert.equal(r.document.activeElement, r.cancel());
  r.press('Tab', true);
  assert.equal(r.document.activeElement, shield);
});

test('the head says where to undo it, once', async () => {
  const r = rig();
  await r.open();
  const head = r.document.querySelector('.perf-sheet-head');
  assert.equal(head.querySelector('.perf-sheet-title').textContent, 'Performance optimization');
  assert.equal(head.querySelector('.perf-sheet-hint').textContent, 'You can undo everything from Settings → Performance.');
  assert.equal(r.document.querySelectorAll('.perf-sheet-hint').length, 1);
});

test('a row is a box and its name, with no label beside it', async () => {
  const r = rig();
  await r.open();
  const row = r.document.querySelector('.perf-sheet-opt');
  assert.deepEqual(row.children.map((c) => c.tag), ['input', 'span']);
});

test('without a plan from Bit there is no line for it', async () => {
  const r = rig();
  await r.open();
  assert.equal(r.document.querySelector('.perf-sheet-intro').hidden, true);
});

test('Bit\'s plan shows as plain words and picks its apps', async () => {
  const r = rig({ opts: { manageApps: true }, useAi: true });
  await r.open();
  const intro = r.document.querySelector('.perf-sheet-intro');
  assert.equal(intro.hidden, false);
  assert.equal(intro.textContent, 'Chrome is the heavy one.');
  const [chrome, onedrive] = r.document.querySelectorAll('.perf-sheet-app input');
  assert.equal(chrome.checked, true);
  assert.equal(onedrive.checked, false);
});

test('the memory closes the row, and only a measured app has one', async () => {
  const r = rig({ opts: { manageApps: true } });
  await r.open();
  const [chrome, onedrive] = r.document.querySelectorAll('.perf-sheet-app');
  assert.deepEqual(chrome.children.map((c) => c.className || c.tag), ['input', 'perf-sheet-app-name', 'perf-sheet-app-title', 'perf-sheet-app-mem']);
  assert.equal(chrome.querySelector('.perf-sheet-app-mem').textContent, '2.1 GB');
  assert.deepEqual(onedrive.children.map((c) => c.className || c.tag), ['input', 'perf-sheet-app-name', 'perf-sheet-app-title']);
});

test('with nothing to close it says so once, with no heading over it', async () => {
  const r = rig({ opts: { manageApps: true }, windows: [] });
  await r.open();
  assert.equal(r.document.querySelector('.perf-sheet-apps').hidden, false);
  assert.equal(r.document.querySelector('.perf-sheet-apps-head').hidden, true);
  assert.equal(r.document.querySelector('.perf-sheet-apps-empty').textContent, 'No background apps to close.');
});

test('off Windows it offers only what works there', async () => {
  const r = rig({ opts: { manageApps: true }, platform: 'linux' });
  await r.open();
  assert.ok(r.document.querySelector('[data-opt="pauseAnimations"]'));
  assert.equal(r.document.querySelector('[data-opt="powerPlan"]'), null);
  assert.equal(r.document.querySelector('[data-opt="priorityBoost"]'), null);
  assert.equal(r.document.querySelector('.perf-sheet-apps').hidden, true, 'closing apps is a Windows lever');
});

test('the shield row shows where the PC can do it, on any OS, and takes the saved choice', async () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const r = rig({ platform });
    await r.open();
    const row = r.document.querySelector('.perf-sheet-opt-shield');
    assert.equal(row.hidden, false, platform);
    assert.equal(r.document.querySelector('[data-opt="shield"]').checked, true, platform);
  }
  const off = rig({ opts: { shield: false } });
  await off.open();
  assert.equal(off.document.querySelector('[data-opt="shield"]').checked, false);
});

test('a PC that cannot do it has no row, and no answer counts as cannot', async () => {
  for (const shield of [{ ok: true, available: false, cores: 0, moved: [] }, null]) {
    const r = rig({ shield });
    await r.open();
    assert.equal(r.document.querySelector('.perf-sheet-opt-shield').hidden, true);
    assert.equal(r.document.querySelector('[data-opt="shield"]').checked, false);
  }
});

test('the lyrics hold still with everything else when a session pauses animations', () => {
  const view = readFileSync(new URL('../js/lyrics-view.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../components/LyricsView/LyricsView.css', import.meta.url), 'utf8');
  assert.match(view, /const FROZEN = '[^']*\.perf-mode/, 'the global CSS rule does not reach a script animation');
  for (const part of ['.lyv-track', '.lyv-line', '.lyv-dot', '.lyv-w']) assert.ok(css.includes('body.perf-mode ' + part), part);
});

test('a row the sheet hides is gone: its own display does not beat the hidden attribute', () => {
  const css = readFileSync(new URL('../components/PerformancePanel/PerformancePanel.css', import.meta.url), 'utf8');
  assert.match(css, /\.perf-sheet-opt \{\s+display: flex;/);
  assert.match(css, /\.perf-sheet-opt\[hidden\] \{ display: none; \}/, 'a shield this PC cannot run would still be offered');
});
