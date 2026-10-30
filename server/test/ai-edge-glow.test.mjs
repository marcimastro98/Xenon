// Xenon AI's edge glow on the other screens (js/ai-edge-glow.js): which screens
// it lights, what it tells the shell and when it stays quiet. The shell side
// (payload rule, pixels, breathing) is unit-tested in apps/native (layers/glow.rs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/ai-edge-glow.js');
const bit = createRequire(import.meta.url)('../../packages/core/src/bit.js');

const D1 = '\\\\.\\DISPLAY1';
const D2 = '\\\\.\\DISPLAY2';
const D3 = '\\\\.\\DISPLAY3';
const DISPLAYS = [{ id: D1, primary: true }, { id: D2 }, { id: D3 }];

function boot({ native = true, caps = { aiGlow: true, displays: DISPLAYS, display: { active: D2 } }, settings = {}, layerPage = false, reducedMotion = false, accent = '10, 20, 30', withBit = false, surface } = {}) {
  const timers = [];
  const intervals = [];
  const cleared = [];
  const signals = [];
  const observers = [];
  const docListeners = {};
  const classes = new Set();
  const location = {};
  Object.defineProperty(location, 'href', { set: (v) => signals.push(v), get: () => '' });
  const window = {
    location,
    __XENON_NATIVE__: native,
    __XENON_NATIVE_CAPS__: caps,
    XenonNative: { afterLoad: (fn) => fn() },
    matchMedia: () => ({ matches: reducedMotion }),
    Xenon: withBit ? { bit } : undefined,
    AiSurface: surface,
  };
  const body = { classList: { contains: (c) => classes.has(c) } };
  const document = {
    body,
    visibilityState: 'visible',
    documentElement: {},
    addEventListener: (type, fn) => { docListeners[type] = fn; },
  };
  const ctx = {
    window,
    document,
    hubSettings: settings,
    isLayerPage: () => layerPage,
    getComputedStyle: () => ({ getPropertyValue: () => accent }),
    MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: (id) => { cleared.push(id); },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const flush = () => { while (timers.length) timers.shift()(); };
  const setClasses = (...names) => {
    classes.clear();
    names.forEach((n) => classes.add(n));
    observers.forEach((o) => o.fn());
    flush();
  };
  const sent = () => signals.map((s) => {
    assert.match(s, /^xenon-app:ai-glow\?d=/);
    return JSON.parse(decodeURIComponent(s.slice('xenon-app:ai-glow?d='.length)));
  });
  return { glow: window.AiEdgeGlow, ctx, document, docListeners, setClasses, sent, flush, intervals, cleared, observers };
}

test('auto lights only the screen Bit was called from: the dashboard\'s, else the main one', () => {
  const { glow } = boot();
  assert.deepEqual([...glow.screensFor('auto', DISPLAYS, D2, false)], [D2]);
  assert.deepEqual([...glow.screensFor('auto', [{ id: D1, primary: true }], D1, false)], [D1]);
  // Nothing known about where the dashboard is: the main screen.
  assert.deepEqual([...glow.screensFor('auto', DISPLAYS, '', false)], [D1]);
  assert.deepEqual([...glow.screensFor('auto', [{ id: D2 }, { id: D3 }], 'gone', false)], [D2]);
  // The dashboard already glows there by itself: the shell lights nothing.
  assert.deepEqual([...glow.screensFor('auto', DISPLAYS, D2, true)], []);
});

test('main, second and all pick what they say', () => {
  const { glow } = boot();
  assert.deepEqual([...glow.screensFor('main', DISPLAYS, D2, false)], [D1]);
  assert.deepEqual([...glow.screensFor('second', DISPLAYS, D2, false)], [D2]);
  assert.deepEqual([...glow.screensFor('all', DISPLAYS, D2, false)], [D1, D2, D3]);
  assert.deepEqual([...glow.screensFor('second', [{ id: D1, primary: true }], D1, false)], []);
  assert.deepEqual([...glow.screensFor('off', DISPLAYS, D2, false)], []);
});

test('a screen where the dashboard draws its own glow is never lit twice', () => {
  const { glow } = boot();
  assert.deepEqual([...glow.screensFor('all', DISPLAYS, D2, true)], [D1, D3]);
  assert.deepEqual([...glow.screensFor('auto', [{ id: D1, primary: true }], D1, true)], []);
});

test('junk display lists and unknown modes are survived', () => {
  const { glow } = boot();
  assert.deepEqual([...glow.screensFor('all', null, '', false)], []);
  assert.deepEqual([...glow.screensFor('all', [null, {}, { id: 7 }], '', false)], ['7']);
  assert.equal(glow.normalizeMode('everywhere'), 'auto');
  assert.equal(glow.normalizeMode('off'), 'off');
});

test('the voice state comes from the classes ai.js sets', () => {
  const { glow } = boot();
  const body = (...c) => ({ classList: { contains: (x) => c.includes(x) } });
  assert.equal(glow.voiceState(body()), 'off');
  assert.equal(glow.voiceState(body('voice-speaking')), 'off', 'no voice chat, no glow');
  assert.equal(glow.voiceState(body('ai-voice-mode')), 'listening');
  assert.equal(glow.voiceState(body('ai-voice-mode', 'voice-thinking')), 'thinking');
  assert.equal(glow.voiceState(body('ai-voice-mode', 'voice-speaking')), 'speaking');
});

test('a voice chat lights the chosen screens and its end turns them off', () => {
  const b = boot();
  b.setClasses('ai-voice-mode', 'voice-listening');
  b.setClasses('ai-voice-mode', 'voice-speaking');
  b.setClasses();
  const sent = b.sent();
  assert.deepEqual(sent.map((s) => s.state), ['listening', 'speaking', 'off']);
  assert.deepEqual(sent[0].monitors, [D2]);
  assert.deepEqual(sent[0].rgb, [10, 20, 30]);
  assert.equal(sent[0].still, false);
  assert.deepEqual(Object.keys(sent[2]), ['state']);
});

test('nothing is re-sent when nothing changed, and a burst is one signal', () => {
  const b = boot();
  b.setClasses('ai-voice-mode', 'voice-listening');
  b.setClasses('ai-voice-mode', 'voice-listening', 'other');
  b.observers.forEach((o) => { o.fn(); o.fn(); o.fn(); });
  b.flush();
  assert.equal(b.sent().length, 1);
});

test('while lit it keeps the shell\'s timeout from firing, and stops when off', () => {
  const b = boot();
  b.setClasses('ai-voice-mode', 'voice-thinking');
  assert.equal(b.intervals.length, 1);
  b.intervals[0]();
  assert.equal(b.sent().length, 2, 'the keepalive re-sends the same state');
  b.setClasses();
  assert.equal(b.cleared.length, 1);
});

test('off in Settings, a screen choice with nothing to light, or reduced motion', () => {
  const off = boot({ settings: { aiEdgeGlow: 'off' } });
  off.setClasses('ai-voice-mode', 'voice-speaking');
  assert.equal(off.sent().length, 0);

  const single = boot({ settings: { aiEdgeGlow: 'second' }, caps: { aiGlow: true, displays: [{ id: D1, primary: true }], display: { active: D1 } } });
  single.setClasses('ai-voice-mode');
  assert.equal(single.sent().length, 0);

  const still = boot({ reducedMotion: true });
  still.setClasses('ai-voice-mode');
  assert.equal(still.sent()[0].still, true);
});

test('the dashboard\'s own ambient glow keeps its screen out while it is visible', () => {
  const b = boot({ settings: { aiEdgeGlow: 'all' } });
  b.setClasses('ai-voice-mode', 'ai-voice-ambient');
  assert.deepEqual(b.sent()[0].monitors, [D1, D3]);
  b.document.visibilityState = 'hidden';
  b.docListeners.visibilitychange();
  b.flush();
  assert.deepEqual(b.sent()[1].monitors, [D1, D2, D3]);
});

test('the edge takes the theme accent, as the dashboard\'s own glow, even with Bit on the page', () => {
  // Bit's yellow and lavender on the other screens looked unrelated to the
  // dashboard's accent glow; the shell itself turns thinking lavender.
  const b = boot({ withBit: true });
  b.setClasses('ai-voice-mode', 'voice-listening');
  b.setClasses('ai-voice-mode', 'voice-thinking');
  b.setClasses('ai-voice-mode', 'voice-speaking');
  assert.deepEqual(b.sent().map((s) => s.rgb), [[10, 20, 30], [10, 20, 30], [10, 20, 30]]);
});

test('a theme without an accent falls back to a valid colour', () => {
  const b = boot({ accent: 'nonsense' });
  b.setClasses('ai-voice-mode');
  assert.deepEqual(b.sent()[0].rgb, [0, 170, 255]);
});

test('a browser, an older shell or a layer page never sends a glow signal', () => {
  for (const opts of [{ native: false }, { caps: { displays: DISPLAYS } }, { layerPage: true }]) {
    const b = boot(opts);
    assert.equal(b.observers.length, 0);
    b.glow.refresh();
    b.flush();
    assert.equal(b.sent().length, 0);
  }
});

test('from the alerts window (Bit with no dashboard) the setting is named and the shell picks the screens', () => {
  const b = boot({ native: undefined, caps: { aiGlow: true }, surface: 'screen', settings: { aiEdgeGlow: 'second' } });
  b.setClasses('ai-voice-mode', 'voice-speaking');
  b.setClasses();
  const sent = b.sent();
  assert.deepEqual(sent.map((s) => s.state), ['speaking', 'off']);
  assert.equal(sent[0].screens, 'second');
  assert.equal('monitors' in sent[0], false);
  const auto = boot({ native: undefined, caps: { aiGlow: true }, surface: 'screen' });
  auto.setClasses('ai-voice-mode', 'voice-listening');
  assert.equal(auto.sent()[0].screens, 'auto', 'even with the ambient card visible: nothing of it shows');
  const off = boot({ native: undefined, caps: { aiGlow: true }, surface: 'screen', settings: { aiEdgeGlow: 'off' } });
  off.setClasses('ai-voice-mode', 'voice-listening');
  assert.equal(off.sent().length, 0);
  const oldShell = boot({ native: undefined, caps: {}, surface: 'screen' });
  assert.equal(oldShell.observers.length, 0, 'a shell without the alerts caps gets no signal');
});
