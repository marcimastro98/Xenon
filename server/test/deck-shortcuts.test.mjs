// Keyboard shortcuts on Deck keys: the combo rules (js/deck-shortcuts.js), the
// model keeping them on a key, shared codes dropping them, and the runner that
// plays a key's tap from its shortcut (deck-shortcut-runner.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../js/deck-shortcuts.js');
const { createDeckShortcutRunner } = require('../deck-shortcut-runner.js');
const { triggerSteps } = require('../js/deck-actions.js');

// ── combos ──────────────────────────────────────────────────────────────────
test('combos are spelled one way, whatever was typed', () => {
  assert.equal(S.normalizeShortcut('Shift+CTRL+F9'), 'ctrl+shift+f9');
  assert.equal(S.normalizeShortcut('cmd+option+k'), 'alt+win+k');
  assert.equal(S.normalizeShortcut('control + super + space'), 'ctrl+win+space');
  assert.equal(S.normalizeShortcut('ctrl+f12'), 'ctrl+f12');
});

test('what every app already uses, or no registrar can name, is refused', () => {
  for (const bad of ['ctrl+c', 'f9', 'alt+a', 'ctrl+shift', 'ctrl+shift+a+b', 'ctrl+shift+numpad1',
    'ctrl+shift+f13', 'ctrl+shift+tab', '', null, 42, 'ctrl+shift+é']) {
    assert.equal(S.normalizeShortcut(bad), '', JSON.stringify(bad));
  }
});

test('combos other software owns say who owns them', () => {
  assert.equal(S.reservedBy('alt+f4'), 'system');
  assert.equal(S.reservedBy('Alt+Shift+F10'), 'nvidia');
  assert.equal(S.reservedBy('win+alt+r'), 'gamebar');
  assert.equal(S.reservedBy('ctrl+shift+t'), 'apps');
  // Ctrl+Alt+letter is AltGr on many layouts: it types characters.
  assert.equal(S.reservedBy('ctrl+alt+e'), 'altgr');
  assert.equal(S.reservedBy('ctrl+alt+7'), 'altgr');
  assert.equal(S.reservedBy('ctrl+alt+shift+e'), '');
  assert.equal(S.reservedBy('ctrl+alt+f9'), '');
  assert.equal(S.reservedBy('ctrl+shift+f9'), '');
  assert.equal(S.reservedBy('ctrl+c'), '');
});

test('a key press becomes a combo from the physical key', () => {
  const ev = (code, mods = {}) => Object.assign({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, mods);
  assert.equal(S.comboFromKeyEvent(ev('KeyK', { ctrlKey: true, shiftKey: true })), 'ctrl+shift+k');
  assert.equal(S.comboFromKeyEvent(ev('Digit3', { altKey: true, metaKey: true })), 'alt+win+3');
  assert.equal(S.comboFromKeyEvent(ev('F10', { ctrlKey: true })), 'ctrl+f10');
  assert.equal(S.comboFromKeyEvent(ev('Space', { ctrlKey: true, altKey: true })), 'ctrl+alt+space');
  assert.equal(S.comboFromKeyEvent(ev('ShiftLeft', { shiftKey: true })), null);
  assert.equal(S.comboFromKeyEvent(ev('Numpad1', { ctrlKey: true, altKey: true })), null);
  assert.equal(S.comboFromKeyEvent(ev('F13', { ctrlKey: true })), null);
  assert.equal(S.comboFromKeyEvent(null), null);
});

test('a combo reads like a person would say it', () => {
  assert.equal(S.formatShortcut('ctrl+shift+f9'), 'Ctrl + Shift + F9');
  assert.equal(S.formatShortcut('ctrl+alt+win+space', true), 'Control + Option + Cmd + Space');
  assert.equal(S.formatShortcut(''), '');
});

// ── keys in the store ───────────────────────────────────────────────────────
function key(id, shortcut, tap) {
  return { kind: 'action', id, title: 'T ' + id, shortcut, triggers: { tap: tap === undefined ? { type: 'openUrl', url: 'https://x.test/play' } : tap } };
}
function configs() {
  return {
    b: { profiles: [{ name: 'Work', root: { pages: [{ keys: [key('b1', 'ctrl+shift+f9'), null, 'junk'] }] } }] },
    a: { profiles: [{ name: 'Game', root: { pages: [{ keys: [
      key('a1', 'ctrl+shift+f9'),
      { kind: 'folder', id: 'f', folder: { pages: [{ keys: [key('a2', 'Alt+Shift+F2')] }] } },
      key('a3', 'ctrl+c'),
    ] }] } }] },
    __presets: { profiles: [{ root: { pages: [{ keys: [key('p1', 'ctrl+shift+f8')] }] } }] },
  };
}

test('shortcuts are collected across Decks and folders; the first key keeps a combo', () => {
  const { list, duplicates } = S.collectShortcuts(configs());
  assert.deepEqual(list.map((s) => [s.keyId, s.combo, s.profile]), [['a1', 'ctrl+shift+f9', 'Game'], ['a2', 'alt+shift+f2', 'Game']]);
  assert.deepEqual(duplicates.map((s) => s.keyId), ['b1']);
  assert.deepEqual(S.collectShortcuts(null), { list: [], duplicates: [] });
  assert.deepEqual(S.collectShortcuts({ x: { profiles: 'no' } }), { list: [], duplicates: [] });
});

test('a key is found by id, folders included', () => {
  assert.equal(S.findKey(configs(), 'a2').instance, 'a');
  assert.equal(S.findKey(configs(), 'p1'), null);
  assert.equal(S.findKey(configs(), 'nope'), null);
});

test('a config round-trip keeps the shortcut', () => {
  const dm = require('../js/deck-model.js');
  const fn = dm.normalizeDeckConfig;
  assert.ok(fn, 'deck-model exports a config normalizer');
  const out = fn(configs().a);
  const keys = JSON.stringify(out);
  assert.match(keys, /"shortcut":"ctrl\+shift\+f9"/);
  assert.match(keys, /"shortcut":"alt\+shift\+f2"/);
  assert.doesNotMatch(keys, /ctrl\+c/);
});

test('a shared Deck profile never carries a shortcut', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../js/preset-share.js', import.meta.url), 'utf8');
  assert.match(src, /delete key\.shortcut;/);
});

// ── the runner ──────────────────────────────────────────────────────────────
function harness(store, opts = {}) {
  const ran = [];
  const events = [];
  const runner = createDeckShortcutRunner({
    readConfigs: async () => store,
    steps: triggerSteps,
    run: async (a) => { ran.push(a); return opts.fail && opts.fail(a) ? { ok: false, error: 'boom' } : { ok: true }; },
    broadcast: (event, data) => { events.push([event, data]); if (opts.onBroadcast) opts.onBroadcast(event, data, runner); },
    claimMs: opts.claimMs || 50,
    soundPlayer: opts.soundPlayer,
    serverFirst: opts.serverFirst,
  });
  return { runner, ran, events };
}

test('a press runs the key tap, every step in order', async () => {
  const tap = { steps: [{ action: { type: 'openUrl', url: 'https://x.test/play' }, delayMs: 0 }, { action: { type: 'openUrl', url: 'https://x.test/next' }, delayMs: 20 }] };
  const store = { main: { profiles: [{ root: { pages: [{ keys: [key('k', 'ctrl+shift+f9', tap)] }] } }] } };
  const { runner, ran, events } = harness(store);
  const t0 = Date.now();
  assert.deepEqual(await runner.press('k', 'ctrl+shift+f9'), { ok: true });
  assert.ok(Date.now() - t0 >= 15, 'the pause was kept');
  assert.deepEqual(ran.map((a) => a.url.split('/').pop()), ['play', 'next']);
  assert.equal(events.length, 0);
  runner.stop();
});

test('a key edited since registration does nothing', async () => {
  const store = { main: { profiles: [{ root: { pages: [{ keys: [key('k', 'ctrl+shift+f10')] }] } }] } };
  const { runner, ran } = harness(store);
  assert.deepEqual(await runner.press('k', 'ctrl+shift+f9'), { ok: false, error: 'gone' });
  assert.deepEqual(await runner.press('missing', 'ctrl+shift+f10'), { ok: false, error: 'gone' });
  assert.equal(ran.length, 0);
  runner.stop();
});

test('a held key does not stack runs', async () => {
  const tap = { steps: [{ action: { type: 'openUrl', url: 'https://x.test/play' }, delayMs: 40 }] };
  const store = { main: { profiles: [{ root: { pages: [{ keys: [key('k', 'ctrl+shift+f9', tap)] }] } }] } };
  const { runner, ran } = harness(store);
  const first = runner.press('k', 'ctrl+shift+f9');
  assert.deepEqual(await runner.press('k', 'ctrl+shift+f9'), { ok: false, error: 'busy' });
  await first;
  assert.equal(ran.length, 1);
  runner.stop();
});

test('a failed step is told once, and the rest still run', async () => {
  const tap = { steps: [{ action: { type: 'openUrl', url: 'https://x.test/play' }, delayMs: 0 }, { action: { type: 'openUrl', url: 'https://x.test/next' }, delayMs: 0 }] };
  const store = { main: { profiles: [{ root: { pages: [{ keys: [key('k', 'ctrl+shift+f9', tap)] }] } }] } };
  const { runner, ran, events } = harness(store, { fail: (a) => a.url.endsWith('play') });
  assert.deepEqual(await runner.press('k', 'ctrl+shift+f9'), { ok: false, error: 'boom' });
  assert.equal(ran.length, 2);
  assert.deepEqual(events, [['deck_shortcut_failed', { title: 'T k', error: 'boom' }]]);
  runner.stop();
});

test('a key with nothing on its tap says so', async () => {
  const store = { main: { profiles: [{ root: { pages: [{ keys: [key('k', 'ctrl+shift+f9', null)] }] } }] } };
  const { runner, events } = harness(store);
  assert.deepEqual(await runner.press('k', 'ctrl+shift+f9'), { ok: false, error: 'no_action' });
  assert.equal(events[0][0], 'deck_shortcut_failed');
  runner.stop();
});

test('a dashboard-only step goes to the first dashboard that claims it', async () => {
  const tap = { type: 'appMixer' };
  const store = { main: { profiles: [{ root: { pages: [{ keys: [key('k', 'ctrl+shift+f9', tap)] }] } }] } };
  let second = null;
  const { runner, ran, events } = harness(store, {
    onBroadcast: (event, data, r) => {
      if (event !== 'deck_shortcut') return;
      assert.equal(r.claim(data.nonce), true);
      second = r.claim(data.nonce);
    },
  });
  assert.deepEqual(await runner.press('k', 'ctrl+shift+f9'), { ok: true });
  assert.equal(second, false, 'only one dashboard runs it');
  assert.equal(ran.length, 0, 'never run on the server');
  assert.equal(events[0][1].action.type, 'appMixer');
  runner.stop();
});

test('no dashboard to claim it: the step fails and says why', async () => {
  const store = { main: { profiles: [{ root: { pages: [{ keys: [key('k', 'ctrl+shift+f9', { type: 'soundStopAll' })] }] } }] } };
  const { runner, events } = harness(store, { claimMs: 20 });
  assert.deepEqual(await runner.press('k', 'ctrl+shift+f9'), { ok: false, error: 'no_dashboard' });
  assert.deepEqual(events.map((e) => e[0]), ['deck_shortcut', 'deck_shortcut_failed']);
  assert.equal(runner.claim('stale'), false);
  runner.stop();
});

test('a widget handler is told it was a tap', async () => {
  const tap = { type: 'sdkHandler', handler: 'pkg:go' };
  const store = { main: { profiles: [{ root: { pages: [{ keys: [key('k', 'ctrl+shift+f9', tap)] }] } }] } };
  const { runner, ran } = harness(store);
  await runner.press('k', 'ctrl+shift+f9');
  assert.deepEqual(ran[0].gesture, { type: 'tap' });
  runner.stop();
});

test('stop settles a step still waiting for a dashboard', async () => {
  const store = { main: { profiles: [{ root: { pages: [{ keys: [key('k', 'ctrl+shift+f9', { type: 'appMixer' })] }] } }] } };
  const { runner } = harness(store, { claimMs: 60000 });
  const p = runner.press('k', 'ctrl+shift+f9');
  await new Promise((r) => setTimeout(r, 10));
  runner.stop();
  assert.deepEqual(await p, { ok: false, error: 'no_dashboard' });
});

// ── sounds with no dashboard (deck-sound-player.js) ─────────────────────────
function fakePlayer(playingFiles = []) {
  const calls = [];
  return {
    calls,
    play: async (a) => { calls.push(['play', a.mode || 'play', a.file]); return { ok: true }; },
    playing: async (f) => playingFiles.includes(f),
    stopAll: () => { calls.push(['stopAll']); return { ok: true }; },
    stop: () => calls.push(['stop']),
  };
}
const soundStore = (tap) => ({ main: { profiles: [{ root: { pages: [{ keys: [key('k', 'ctrl+shift+f9', tap)] }] } }] } });

test('a sound nobody claims is played by the PC', async () => {
  const player = fakePlayer();
  const { runner, events } = harness(soundStore({ type: 'playSound', file: 'C:\s\a.mp3' }), { claimMs: 20, soundPlayer: player });
  assert.deepEqual(await runner.press('k', 'ctrl+shift+f9'), { ok: true });
  assert.deepEqual(events.map((e) => e[0]), ['deck_shortcut'], 'offered first, no failure told');
  assert.deepEqual(player.calls, [['play', 'play', 'C:\s\a.mp3']]);
  runner.stop();
  assert.deepEqual(player.calls.at(-1), ['stop'], 'shutdown stops the clips');
});

test('a sound a dashboard claims is not played twice', async () => {
  const player = fakePlayer();
  const { runner } = harness(soundStore({ type: 'playSound', file: 'C:\s\a.mp3' }), {
    soundPlayer: player,
    onBroadcast: (event, data, r) => { if (event === 'deck_shortcut') r.claim(data.nonce); },
  });
  assert.deepEqual(await runner.press('k', 'ctrl+shift+f9'), { ok: true });
  assert.equal(player.calls.length, 0);
  runner.stop();
});

test('widgets only: the PC plays at once, with no offer to wait on', async () => {
  const player = fakePlayer();
  const { runner, events } = harness(soundStore({ type: 'playSound', file: 'C:\s\a.mp3' }), {
    claimMs: 60000, soundPlayer: player, serverFirst: () => true,
  });
  assert.deepEqual(await runner.press('k', 'ctrl+shift+f9'), { ok: true });
  assert.equal(events.length, 0);
  assert.equal(player.calls.length, 1);
  runner.stop();
});

test('stop all stops the PC clips and still tells the dashboards', async () => {
  const player = fakePlayer();
  const { runner, events } = harness(soundStore({ type: 'soundStopAll' }), { claimMs: 20, soundPlayer: player });
  assert.deepEqual(await runner.press('k', 'ctrl+shift+f9'), { ok: true });
  assert.deepEqual(player.calls, [['stopAll']]);
  assert.deepEqual(events.map((e) => e[0]), ['deck_shortcut'], 'unclaimed is no failure: nothing was playing there');
  runner.stop();
});

test('a toggle stops the clip the PC is playing instead of offering it', async () => {
  const player = fakePlayer(['C:\s\a.mp3']);
  const { runner, events } = harness(soundStore({ type: 'playSound', file: 'C:\s\a.mp3', mode: 'toggle' }), { soundPlayer: player });
  assert.deepEqual(await runner.press('k', 'ctrl+shift+f9'), { ok: true });
  assert.deepEqual(player.calls, [['play', 'toggle', 'C:\s\a.mp3']]);
  assert.equal(events.length, 0);
  runner.stop();
});
