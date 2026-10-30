// The on-screen alerts window of "widgets only" (js/screen-alerts.js): which
// alerts it shows under which settings, the chime it asks the server for, and
// the card rectangles it hands the shell so every other click goes through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const AlertToasts = require('../js/alert-toasts.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/screen-alerts.js');

const tick = () => new Promise((r) => setImmediate(r));

// `widgetsOnly`: the use the window was made for. With the dashboard up it opens
// for Bit's vitals popup alone (js/layers-shell.js).
async function boot({ settings = {}, shell = true, dpr = 2, sounds = true, update = {}, store = {}, widgetsOnly = true } = {}) {
  const shown = [];
  const dismissed = [];
  const posts = [];
  const signals = [];
  const captures = [];
  const listeners = {};
  const timers = [];
  const frames = [];
  const cards = [];
  const callLists = [];
  let seeds = 0;
  const intervals = [];
  const classes = new Set();
  let afterLoad = null;
  const location = { reload() {} };
  Object.defineProperty(location, 'href', { set: (v) => signals.push(v), get: () => '' });
  const window = {
    location,
    devicePixelRatio: dpr,
    __XENON_LAYER_SHELL__: shell,
    AlertToasts,
    UsageMode: { widgetsOnly: () => widgetsOnly },
    XenonToast: { show: (o) => shown.push(o), dismiss: (id) => dismissed.push(id) },
    XenonSound: { play: () => { throw new Error('the page cue would be silent'); } },
    XenonNative: { afterLoad: (fn) => { afterLoad = fn; } },
    CallModal: { onCalls: (d) => callLists.push(d.calls.length), seed: () => { seeds += 1; } },
    matchMedia: () => ({ matches: true }),
    addEventListener() {},
  };
  const document = {
    documentElement: { lang: 'en' },
    body: { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } },
    querySelectorAll: (sel) => (sel.startsWith('.xtoast-stack > .xtoast, .call-overlay > .call-card') ? cards : []),
    addEventListener() {},
  };
  class EventSource {
    constructor(url) { this.url = url; }
    addEventListener(type, fn) { listeners[type] = fn; }
  }
  const ctx = {
    window,
    document,
    lang: 'en',
    i18n: { en: {} },
    t: (k) => (k === 'guardian_alert_mem' ? 'RAM {v}%' : k),
    normalizeLangCode: (v) => v || '',
    notifSoundsOn: () => sounds,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    timeParts: (extra) => ({ ...extra, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }),
    SERVER: 'http://127.0.0.1:3030',
    ThemeTokens: { applySkin() {}, derivePalette() { return {}; }, applyPalette() {}, applyMaterial() {}, applyFont() {} },
    DeckErrorText: require('../js/deck-error-text.js'),
    CaptureToast: { onCapture: (d) => captures.push(d), onRecording() {}, onReplay() {} },
    AlertToasts,
    EventSource,
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: (id) => { intervals[id - 1] = null; },
    fetch: async (url, opts = {}) => {
      if (url.endsWith('/settings')) return { ok: true, json: async () => ({ settings }) };
      if (url.endsWith('/update/check')) return { ok: true, json: async () => update };
      if (opts.method === 'POST') posts.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({}) };
    },
  };
  ctx.window.document = document;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  await tick(); await tick(); await tick();
  const emit = (type, data) => listeners[type]({ data: JSON.stringify(data) });
  const load = () => afterLoad && afterLoad();
  const settle = () => { while (frames.length) frames.shift()(); while (timers.length) timers.shift()(); };
  const addCard = (r) => cards.push({ getBoundingClientRect: () => r });
  return { shown, dismissed, store, posts, signals, captures, classes, emit, load, settle, addCard, cards, listeners, window, callLists, intervals, seeds: () => seeds };
}

test('routine alerts follow the Notifiche switches, the alerts switch covers everything', async () => {
  const on = await boot();
  on.emit('stocks_alert', { symbol: 'AAPL', dir: 'up', changePct: 5 });
  assert.equal(on.shown.length, 1);

  const popupsOff = await boot({ settings: { notifications: { popups: false } } });
  popupsOff.emit('stocks_alert', { symbol: 'AAPL', dir: 'up', changePct: 5 });
  popupsOff.emit('timer_done', { label: 'Pasta' });
  assert.deepEqual(popupsOff.shown.map((s) => s.type), ['timer']);

  const off = await boot({ settings: { notifications: { onScreen: false } } });
  off.emit('stocks_alert', { symbol: 'AAPL', dir: 'up', changePct: 5 });
  off.emit('timer_done', { label: 'Pasta' });
  off.emit('capture', { kind: 'screenshot' });
  assert.equal(off.shown.length, 0);
  assert.equal(off.captures.length, 0);
  assert.equal(off.posts.length, 0);
});

test('a timer asks the server for the chime; Guardian needs Guardian on', async () => {
  const b = await boot();
  b.emit('timer_chime', { label: '', every: 60 });
  assert.deepEqual(b.posts.map((p) => [p.url, p.body.kind]), [['http://127.0.0.1:3030/api/chime', 'wake']]);
  b.emit('guardian_alert', { type: 'cpu', value: 95 });
  assert.equal(b.shown.length, 1);

  const g = await boot({ settings: { aiFeatures: { enabled: true, guardian: true } } });
  g.emit('guardian_alert', { type: 'mem', value: 93 });
  assert.equal(g.shown.length, 1);
  assert.deepEqual([g.shown[0].type, g.shown[0].title], ['warning', 'RAM 93%']);
});

test('a card cue is played by the server: the page never gets the click audio needs', async () => {
  const b = await boot();
  for (const type of ['warning', 'error', 'notification', 'update', 'timer', 'info', 'success']) b.window.XenonSound.play(type);
  assert.deepEqual(b.posts.map((p) => p.body.kind), ['warning', 'error', 'notification', 'update'],
    'timer has its own chime, info/success are silent');
  const quiet = await boot({ sounds: false });
  quiet.window.XenonSound.play('warning');
  assert.equal(quiet.posts.length, 0, 'the Notifiche sounds switch still rules');
});

test('an incoming call shows the call card and rings through the server', async () => {
  const b = await boot();
  assert.equal(b.seeds(), 1, 'a call already ringing when the window opened is asked for');
  b.emit('calls', { calls: [{ id: 'c1' }] });
  assert.deepEqual(b.callLists, [1]);
  b.window.XenonSound.ring(true);
  b.window.XenonSound.ring(true);
  const rings = () => b.posts.filter((p) => p.body.kind === 'ring').length;
  assert.equal(rings(), 1, 'asked on every paint, rings once per cycle');
  const tick = b.intervals.filter(Boolean).at(-1);
  tick();
  assert.equal(rings(), 2);
  b.window.XenonSound.ring(false);
  assert.equal(b.intervals.filter(Boolean).includes(tick), false, 'the ring stops with the card');

  const off = await boot({ settings: { notifications: { onScreen: false } } });
  assert.equal(off.seeds(), 0);
  off.emit('calls', { calls: [{ id: 'c1' }] });
  assert.deepEqual(off.callLists, [0], 'alerts off: the card stays closed');
  const quiet = await boot({ sounds: false });
  quiet.window.XenonSound.ring(true);
  assert.equal(quiet.posts.length, 0);
});

test('a calendar reminder shows its card and its alarm, whatever the pop-up switches say', async () => {
  const b = await boot({ settings: { notifications: { popups: false } } });
  b.emit('calendar_reminder', { id: 'a', title: 'Dentist', startsAt: '2026-10-27T11:05:00Z', feed: false });
  assert.equal(b.shown.length, 1);
  assert.equal(b.shown[0].type, 'reminder');
  assert.equal(b.shown[0].title, 'Dentist');
  assert.match(b.shown[0].message, /11:05/);
  assert.deepEqual(b.posts.map((p) => p.body.kind), ['reminder']);
  const quiet = await boot({ sounds: false });
  quiet.emit('calendar_reminder', { id: 'a', title: 'Dentist', startsAt: '2026-10-27T11:05:00Z' });
  assert.equal(quiet.shown.length, 1);
  assert.equal(quiet.posts.length, 0, 'the Notifiche sounds switch silences the alarm');
  const off = await boot({ settings: { notifications: { onScreen: false } } });
  off.emit('calendar_reminder', { id: 'a', title: 'Dentist', startsAt: '2026-10-27T11:05:00Z' });
  assert.deepEqual([off.shown.length, off.posts.length], [0, 0]);
});

test('a benchmark card can show its file; captures go to the shared capture toasts', async () => {
  const b = await boot();
  b.emit('benchmark', { result: { ok: true, avgFps: 100, low1Fps: 60 } });
  b.shown[0].actions[0].onClick();
  assert.deepEqual(b.posts.at(-1).body, { type: 'benchmark', mode: 'reveal' });
  b.emit('capture', { kind: 'screenshot', id: 'c1' });
  assert.equal(b.captures.length, 1);
  // A broken payload never stops the stream.
  assert.doesNotThrow(() => b.listeners.stocks_alert({ data: '{' }));
});

test('game mode holds routine cards back like on the dashboard', async () => {
  const b = await boot();
  b.emit('status', { gaming: true });
  assert.ok(b.classes.has('game-mode'));
  // A light status update says nothing about the game.
  b.emit('status', { cpu: 3 });
  assert.ok(b.classes.has('game-mode'));
  b.emit('status', { gaming: false });
  assert.ok(!b.classes.has('game-mode'));
  const off = await boot({ settings: { gameMode: false } });
  off.emit('status', { gaming: true });
  assert.ok(!off.classes.has('game-mode'));
});

test('the window is cut to the cards, in device pixels, only once loaded and once per change', async () => {
  const b = await boot({ dpr: 2 });
  b.addCard({ left: 100, top: 16, width: 300, height: 80 });
  b.settle();
  assert.equal(b.signals.length, 0, 'nothing before the page has loaded');
  b.load();
  b.settle();
  assert.deepEqual(b.signals, ['xenon-app:alert-rects?d=' + encodeURIComponent('180,12,640,200')]);
  b.settle();
  assert.equal(b.signals.length, 1, 'the same cards are not sent twice');
  b.cards.length = 0;
  b.settle();
  // A load sends again; the settle after it is deduplicated.
  b.load();
  b.settle();
  assert.equal(b.signals.at(-1), 'xenon-app:alert-rects?d=');
});

test('in a browser tab there is no shell to signal', async () => {
  const b = await boot({ shell: false });
  b.addCard({ left: 0, top: 0, width: 10, height: 10 });
  b.load();
  b.settle();
  assert.equal(b.signals.length, 0);
});

test('the page loads what it uses, in order', () => {
  const html = read('../screen-alerts.html');
  const order = ['js/utils.js', 'js/state.js', 'layer-i18n.js', 'js/theme-tokens.js', 'js/native-bridge.js', 'js/toast.js',
    'js/alert-toasts.js', 'js/deck-error-text.js', 'js/capture-toast.js', 'js/call-modal.js', 'js/screen-bit.js', 'js/screen-alerts.js'];
  const at = order.map((f) => html.indexOf(`src="${f}"`));
  assert.ok(at.every((i) => i > 0), JSON.stringify(at));
  assert.deepEqual(at.slice().sort((a, b) => a - b), at);
  assert.doesNotMatch(html, /src="js\/main\.js"/);
  assert.doesNotMatch(html, /src="js\/ai\.js"/, 'Bit loads only when called');
  assert.match(html, /<template id="screen-bit-markup"><!-- bit markup --><\/template>/);
});

test('the automatic update last minute: one card, "In an hour" postpones, any other phase closes it', async () => {
  const b = await boot();
  b.emit('update_auto', { phase: 'countdown', version: 'v4.12.0', seconds: 60, endsAt: 1 });
  assert.equal(b.shown.length, 1);
  const card = b.shown[0];
  assert.deepEqual([card.type, card.title, card.duration, card.important], ['update', 'Update in a minute', 60000, true]);
  assert.equal(card.message, 'Version 4.12.0. The app restarts on its own.');
  card.actions[0].onClick();
  await tick();
  assert.deepEqual(b.posts.map((p) => p.url), ['http://127.0.0.1:3030/update/auto/postpone']);
  b.emit('update_auto', { phase: 'countdown', version: '4.12.0', seconds: 60 });
  assert.deepEqual(b.dismissed, [1], 'a new countdown replaces the old card');
  b.emit('update_auto', { phase: 'cancelled', version: '4.12.0', reason: 'postponed' });
  assert.deepEqual(b.dismissed, [1, 2]);
  assert.equal(b.shown.length, 2, 'cancelled, applying and failed show nothing of their own');

  const off = await boot({ settings: { notifications: { onScreen: false } } });
  off.emit('update_auto', { phase: 'countdown', version: '4.12.0', seconds: 60 });
  assert.equal(off.shown.length, 0);
});

test('a newer Xenon: one card per version, it opens the dashboard on the update screen, a skip holds', async () => {
  const b = await boot({ update: { updateAvailable: true, latest: 'v4.12.0', current: '4.11.13' } });
  assert.equal(b.shown.length, 1, 'checked at boot');
  const card = b.shown[0];
  assert.equal(card.duration, 0, 'it stays until tapped or closed');
  assert.match(card.message, /\(v4\.12\.0\)$/);
  card.onClick();
  assert.deepEqual(b.signals.filter((s) => s.startsWith('xenon-app:open')), ['xenon-app:open-dashboard?open=update']);
  assert.equal(b.intervals.length >= 1, true);
  await b.intervals.at(-1)();
  assert.equal(b.shown.length, 1, 'the six-hourly look does not repeat it');
  card.actions[0].onClick();
  assert.equal(b.store['xenon.update.dismissed'], '4.12.0', 'the same key js/update.js reads');

  const skipped = await boot({ update: { updateAvailable: true, latest: '4.12.0' }, store: { 'xenon.update.dismissed': 'v4.12.0' } });
  assert.equal(skipped.shown.length, 0);
  const current = await boot({ update: { updateAvailable: false, latest: '4.11.13' } });
  assert.equal(current.shown.length, 0);
  const off = await boot({ settings: { notifications: { onScreen: false } }, update: { updateAvailable: true, latest: '4.12.0' } });
  assert.equal(off.shown.length, 0);
});

test('"Hey Xenon" wakes Bit here only with the alerts on; the voice signals reach ai.js once it is in', async () => {
  const off = await boot({ settings: { usageMode: 'widgets', notifications: { onScreen: false } } });
  let woke = 0;
  off.window.ScreenBit = { wake: () => { woke += 1; } };
  off.emit('wake', { at: 1 });
  assert.equal(woke, 0);

  const b = await boot({ settings: { usageMode: 'widgets' } });
  b.window.ScreenBit = { wake: () => { woke += 1; } };
  b.emit('stt_silence', { id: 'x' });
  b.emit('speak_start', {});
  b.emit('wake', { at: 1 });
  assert.equal(woke, 1);
  const heard = [];
  b.window._aiOnSttSilence = (id) => heard.push('silence:' + id);
  b.window._aiOnSpeakStart = () => heard.push('speak');
  b.emit('stt_silence', { id: 'x' });
  b.emit('speak_start', {});
  assert.deepEqual(heard, ['silence:x', 'speak']);
});

test('Bit talking is a card too, and the voice runs in the transparent ambient look', () => {
  assert.match(SRC, /const CARDS = '[^']*body\.ai-voice-mode \.ai-voice-stage[,']/);
  assert.match(SRC, /hubSettings = \{ \.\.\.next, aiVoiceAmbient: true \};/);
});

test('a Deck shortcut\'s "talk to Xenon AI" step is claimed here and wakes Bit; the others are left alone', async () => {
  const ScreenBit = require('../js/screen-bit.js');
  const b = await boot({ settings: { usageMode: 'widgets' } });
  let woke = 0;
  b.window.ScreenBit = { claims: ScreenBit.claims, wake: () => { woke += 1; } };
  b.emit('deck_shortcut', { nonce: 'n1', action: { type: 'ai', mode: 'prompt', prompt: 'hi' } });
  b.emit('deck_shortcut', { nonce: 'n2', action: { type: 'playSound', file: 'a.mp3' } });
  b.emit('deck_shortcut', { nonce: 'n3', action: { type: 'ai', mode: 'voice' } });
  await tick(); await tick(); await tick();
  assert.deepEqual(b.posts.filter((p) => p.url.endsWith('/deck/shortcut-claim')).map((p) => p.body), [{ nonce: 'n3' }]);
  assert.equal(woke, 0, 'the fake server answers {} = not ours');

  const off = await boot({ settings: { usageMode: 'widgets', notifications: { onScreen: false } } });
  off.window.ScreenBit = { claims: ScreenBit.claims, wake() {} };
  off.emit('deck_shortcut', { nonce: 'n4', action: { type: 'ai', mode: 'voice' } });
  await tick();
  assert.equal(off.posts.length, 0, 'alerts off: the dashboard, or nobody');
});

test("with the dashboard up the window shows Bit's vitals popup and leaves every other alert to the dashboard", async () => {
  const up = await boot({ widgetsOnly: false });
  up.emit('stocks_alert', { symbol: 'AAPL', dir: 'up', changePct: 5 });
  up.emit('timer_done', { label: 'Pasta' });
  assert.equal(up.shown.length, 0, 'the dashboard shows these itself');
  up.emit('vitals_nag', { id: 'n1', text: 'Drink some water!', until: Date.now() + 8000 });
  assert.deepEqual(up.shown.map((s) => [s.kicker, s.title]), [['Bit', 'Drink some water!']]);
});
