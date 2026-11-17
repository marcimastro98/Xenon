// A helper that holds SOME combos keeps running, so the exit path never looked
// again at the ones another app held when it started: Alt+Space stayed dead for
// the whole session after that app let it go. These run the real listener code
// from server.js against a fake helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineSource } from './engine-source.mjs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const server = engineSource().replace(/\r\n/g, '\n');

function slice(from, to) {
  const start = server.indexOf(from);
  const end = server.indexOf(to, start);
  assert.ok(start > 0 && end > start, 'listener code moved: ' + from);
  return server.slice(start, end + to.length);
}

function rig(helperReady) {
  const code = [
    slice('const _hotkey = {', '\n'),
    // On this branch the pieces live in separate modules, so each is cut out on its own.
    'let _hotkeyRetryTimer = null;',
    slice('const HOTKEY_RETRY_MS', '\n}\n'),
    slice('function _scheduleHotkeyRetry(ms) {', '\n}\n'),
    slice('function _recheckTakenHotkeys() {', '\n}\n'),
    slice('function _cancelHotkeyRetry() {', '\n}\n'),
    slice('function refreshHotkeyListener() {', '  proc.unref();\n}\n'),
    'this._hotkey = _hotkey; this.refreshHotkeyListener = refreshHotkeyListener;',
  ].join('\n');
  const timers = [];
  const spawned = [];
  const ctx = {
    _serverHubSettings: { searchSettings: { hotkeyEnabled: true, hotkeyCombo: 'alt+space' } },
    _hotkeyBindings: () => [{ slot: 'spotlight', combo: 'alt+space' }, { slot: 'menu', combo: 'ctrl+alt+shift+f7' }],
    _linuxHotkey: null,
    _shuttingDown: false,
    _widgetKeys: { setRelease() {} },
    fs: { existsSync: () => true },
    HELPER_EXE: 'helper',
    routeHotkeyIndex() {}, routeHotkeyRelease() {},
    Math, Date, Number, Array, Object, JSON, String,
    setTimeout: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    spawn: () => {
      const p = new EventEmitter();
      p.stdout = new EventEmitter(); p.stdout.setEncoding = () => {};
      p.stdin = { end: () => setImmediate(() => p.emit('exit', 0)) };
      p.kill = () => {}; p.unref = () => {};
      spawned.push(p);
      const held = helperReady(spawned.length);
      setImmediate(() => p.stdout.emit('data', JSON.stringify({ event: 'ready', registered: held }) + '\n'));
      return p;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const runTimer = () => { const t = timers.shift(); assert.ok(t, 'a timer is pending'); t.fn(); return t.ms; };
  return { ctx, timers, spawned, runTimer };
}
const tick = () => new Promise((r) => setImmediate(r));

test('a combo another app held at start is looked at again, and taken once it is free', async () => {
  // First helper: Alt+Space (index 0) belongs to someone else. Second one: free.
  const r = rig((n) => (n === 1 ? [1] : [0, 1]));
  r.ctx.refreshHotkeyListener();
  await tick();
  assert.equal(r.ctx._hotkey.state, 'taken');
  assert.equal(r.ctx._hotkey.slots.menu, 'listening');
  assert.equal(r.timers.length, 1, 'a recheck is booked');
  assert.equal(r.runTimer(), 15000);
  // The new helper starts only after the old one let its combos go.
  assert.equal(r.spawned.length, 1);
  await tick(); await tick();
  assert.equal(r.spawned.length, 2);
  await tick();
  assert.equal(r.ctx._hotkey.state, 'listening');
  assert.equal(r.ctx._hotkey.slots.spotlight, 'listening');
  assert.equal(r.timers.length, 0, 'nothing more to look at');
  assert.equal(r.ctx._hotkey.takenChecks, 0);
});

test('a combo that stays taken is looked at less and less often, never faster than the cap', async () => {
  const r = rig(() => [1]);
  r.ctx.refreshHotkeyListener();
  const waits = [];
  for (let i = 0; i < 7; i++) {
    await tick();
    waits.push(r.runTimer());
    await tick(); await tick();
  }
  assert.deepEqual(waits, [15000, 30000, 60000, 120000, 240000, 300000, 300000]);
  assert.equal(r.spawned.length, 8);
});

test('no recheck when everything was free', async () => {
  const r = rig(() => [0, 1]);
  r.ctx.refreshHotkeyListener();
  await tick();
  assert.equal(r.ctx._hotkey.state, 'listening');
  assert.equal(r.timers.length, 0);
});

test('a shutdown between stopping the old helper and its exit starts no new one', async () => {
  const r = rig(() => [1]);
  r.ctx.refreshHotkeyListener();
  await tick();
  r.ctx._shuttingDown = true;
  r.runTimer();
  await tick(); await tick();
  assert.equal(r.spawned.length, 1);
});
