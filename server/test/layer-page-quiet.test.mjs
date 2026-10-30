// A layer window (`/?layer=…`) boots the full dashboard to draw the built-in
// tiles placed on it, so every module that acts on its own runs there too. What
// speaks, rings, chimes, notifies or announces must stay with the main
// dashboard: a second copy did it twice (two chimes, two ringtones, the greeting
// spoken twice), unseen, or marked an announcement read that nobody saw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const AlertToasts = createRequire(import.meta.url)('../js/alert-toasts.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const GUARD = "typeof isLayerPage === 'function' && isLayerPage()";

function ctxAt(search, extra = {}) {
  const ctx = { window: { location: { search } }, ...extra };
  vm.createContext(ctx);
  vm.runInContext(read('../js/utils.js').replace(/^const \$ = .*$/m, ''), ctx);
  return ctx;
}

test('isLayerPage reads the layer key from the URL', () => {
  assert.equal(vm.runInContext('isLayerPage()', ctxAt('?layer=desktop:')), true);
  assert.equal(vm.runInContext('isLayerPage()', ctxAt('?x=1&layer=anchor:lw_abcd')), true);
  assert.equal(vm.runInContext('isLayerPage()', ctxAt('')), false);
  assert.equal(vm.runInContext('isLayerPage()', ctxAt('?panel=agenda')), false);
});

test('a finished timer updates the tile but chimes from the main dashboard only', () => {
  const run = (search) => {
    const calls = { fetch: 0, toast: 0, render: 0 };
    const ctx = ctxAt(search, { fetch: () => { calls.fetch++; return Promise.resolve(); } });
    ctx.window.XenonToast = { show: () => { calls.toast++; } };
    ctx.window.AlertToasts = AlertToasts;
    ctx.t = (k) => k;
    vm.runInContext(read('../js/timer.js'), ctx);
    ctx.renderTimers = () => { calls.render++; };
    vm.runInContext("_timerState = [{ id: 'a', status: 'running' }]; onTimerDone('a', 'Tea'); onTimerChime('a', 'Tea', 60);", ctx);
    return calls;
  };
  assert.deepEqual(run('?layer=desktop:'), { fetch: 0, toast: 0, render: 1 });
  assert.deepEqual(run(''), { fetch: 2, toast: 2, render: 1 });
});

test('the ambient voice never starts in a layer window', () => {
  const boot = (search) => {
    const ctx = ctxAt(search, { document: { addEventListener() {} }, setTimeout() {}, setInterval() {} });
    ctx.window.addEventListener = () => {};
    vm.runInContext(read('../js/ambient.js'), ctx);
    return ctx.window.Ambient;
  };
  assert.equal(boot('?layer=overlay:'), undefined);
  assert.equal(typeof boot('').onGuardianAlert, 'function');
});

test('toasts, announcements, the tour and update notices stay on the main dashboard', () => {
  const at = (file, anchor) => {
    const src = read('../js/' + file);
    const i = src.indexOf(anchor);
    assert.ok(i >= 0, file + ': ' + anchor);
    return src.slice(i, i + 400);
  };
  assert.ok(at('toast.js', '  function show(opts) {').includes('if (' + GUARD + ') return 0;'));
  assert.ok(at('update.js', '  async function boot() {').includes('if (' + GUARD + ') return;'));
  assert.ok(at('onboarding.js', '  function maybeStart() {').includes('if (' + GUARD + ') return;'));
  assert.ok(at('support-appeal.js', '  function init() {').includes('if (' + GUARD + ') return;'));
  // The guard sits before the first look, so no check is ever scheduled.
  for (const [file, look] of [['hub-messages.js', 'checkDaily()'], ['catalog-drop.js', 'checkOnStart()']]) {
    const src = read('../js/' + file);
    const g = src.lastIndexOf('if (' + GUARD + ') return;');
    assert.ok(g > 0 && g < src.indexOf('const look = () => { try { ' + look), file);
  }
});

test('reminders, calls, the wake word and the search hotkey are answered by the main dashboard', () => {
  const main = read('../js/main.js');
  assert.doesNotMatch(main, /checkReminders/, 'the server decides reminders');
  assert.match(main, /if \(need\.events && !isLayerPage\(\)\) \{\n\s*es\.addEventListener\('calendar_reminder'/);
  for (const ev of ['calls', 'wake']) {
    const i = main.indexOf("es.addEventListener('" + ev + "'");
    assert.match(main.slice(i, i + 400), /if \(isLayerPage\(\)\) return;/, ev);
  }
  assert.match(main, /if \(!isNative \|\| isLayerPage\(\)\) return;/);
});

test('the Media tile in a layer window never repeats what the dashboard sends on its own', () => {
  const run = (search) => {
    const posts = [];
    const ctx = ctxAt(search, {
      fetch: (url) => { posts.push(String(url).replace(/^.*\/\/[^/]+/, '')); return Promise.resolve(); },
      localStorage: { getItem: () => 'spotify.exe', setItem() {}, removeItem() {} },
      SERVER: '',
    });
    vm.runInContext(read('../js/media.js'), ctx);
    const picker = { hidden: false };
    ctx.$ = (id) => (id === 'media-source-picker' ? picker : id === 'media-source-select' ? {} : null);
    // The cover colour for the LEDs, and the clearing of a source that went away.
    vm.runInContext("pushAlbumToLighting({ led: '#ff0000' }); renderMediaSourcePicker(null);", ctx);
    return posts;
  };
  assert.deepEqual(run('?layer=desktop:'), []);
  assert.deepEqual(run(''), ['/api/lighting/album', '/media/source']);
  const media = read('../js/media.js');
  assert.match(media, /if \(typeof showCalendar === 'function'\) \{/, 'the agenda is not on the light page');
});
