// Bit on the search bar (js/spotlight-bit.js) and the one way to reach him from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';
import { engineSource } from './engine-source.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/spotlight-bit.js');

function element() {
  const el = {
    className: '',
    children: [],
    classes: new Set(),
    classList: { add: (c) => el.classes.add(c) },
    appendChild(child) { el.children.push(child); return child; },
    setAttribute() {},
  };
  return el;
}

function setup({ engine = true, reduced = false } = {}) {
  const calls = { moods: [], clips: [], mounts: [] };
  const timers = [];
  const player = {
    setMood: (m) => calls.moods.push(m),
    play: (c) => { calls.clips.push(c); return Promise.resolve(); },
  };
  let clock = 100000;
  const window = {
    matchMedia: () => ({ matches: reduced }),
    BitApp: engine ? {
      TILE_HOLD: ['overlay-frozen', 'game-mode'],
      mount: (_host, opts) => { calls.mounts.push(opts); return player; },
    } : undefined,
  };
  const ctx = vm.createContext({
    window,
    document: { createElement: element, createElementNS: element },
    Date: { now: () => clock },
    Promise,
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].f = null; },
  });
  vm.runInContext(SRC, ctx);
  const fire = () => { for (const t of timers.splice(0)) if (t.f) t.f(); };
  return { calls, fire, api: window.SpotlightBit, tick: (ms) => { clock += ms; } };
}

test('without the engine the button is a plain chat icon and every event is quiet', async () => {
  const s = setup({ engine: false });
  const button = element();
  const bit = s.api.create(button);
  assert.ok(button.classes.has('is-plain'));
  bit.typing(); bit.noResults('x'); bit.wave(); bit.greet(); bit.stop();
  await bit.press();
  assert.deepEqual(s.calls.clips, []);
});

test('typing listens and goes back to idle only after the keys stop', () => {
  const s = setup();
  const bit = s.api.create(element());
  bit.typing();
  bit.typing();
  bit.typing();
  assert.deepEqual([...s.calls.moods], ['listen', 'listen', 'listen']);
  s.fire();
  assert.deepEqual([...s.calls.moods], ['listen', 'listen', 'listen', 'idle']);
  assert.deepEqual([...s.calls.clips], [], 'never a clip per key');
});

test('one idea per phrase: the same empty search stays quiet', () => {
  const s = setup();
  const bit = s.api.create(element());
  bit.noResults('zzz');
  bit.noResults('zzz');
  bit.noResults('zzzz');
  assert.deepEqual([...s.calls.clips], ['idea', 'idea']);
});

test('a phrase asked again after the bar was reset gets its idea again', () => {
  const s = setup();
  const bit = s.api.create(element());
  bit.noResults('zzz');
  bit.stop();
  bit.noResults('zzz');
  assert.deepEqual([...s.calls.clips], ['idea', 'idea']);
});

test('reaching for Bit waves, at most once every few seconds', () => {
  const s = setup();
  const bit = s.api.create(element());
  bit.wave();
  s.tick(1000);
  bit.wave();
  s.tick(3000);
  bit.wave();
  assert.deepEqual([...s.calls.clips], ['wave', 'wave']);
});

test('the greeting changes each time, and two callers make one greeting', () => {
  const s = setup();
  const bit = s.api.create(element());
  bit.greet();
  bit.greet();
  s.fire();
  bit.greet();
  s.fire();
  assert.equal(s.calls.clips.length, 2);
  assert.notEqual(s.calls.clips[0], s.calls.clips[1]);
});

test('a press hops, and waits for it only when motion is allowed', async () => {
  const moving = setup();
  const done = moving.api.create(element()).press();
  moving.fire();
  await done;
  assert.deepEqual([...moving.calls.clips], ['hop']);

  const still = setup({ reduced: true });
  await still.api.create(element()).press();
  assert.deepEqual([...still.calls.clips], ['hop']);
});

test('a Bit on the search overlay is not held by the freeze that overlay asks for', () => {
  const s = setup();
  s.api.create(element(), { onOverlay: true });
  s.api.create(element());
  assert.deepEqual([...s.calls.mounts[0].hold], ['game-mode']);
  assert.equal(s.calls.mounts[1].hold, undefined);
  assert.equal(s.calls.mounts[0].label, undefined, 'decorative: the button carries the name');
});

test('alone in the list, the ask row shows it is what Enter sends, without a second clip', () => {
  const spot = read('../js/spotlight.js');
  assert.ok(spot.includes('if (index === 0) setSelected(0, true);'));
  assert.ok(spot.includes('if (!quiet && bit && lastResults[selIndex]'));
});

test('every place with the bar loads Bit before spotlight.js', () => {
  const tiles = read('../js/layer-tiles.js');
  const row = tiles.slice(tiles.indexOf("search: tile('search'"));
  for (const src of [read('../spotlight.html'), read('../index.html'), row]) {
    const bit = src.indexOf('js/spotlight-bit.js');
    assert.ok(bit > 0 && bit < src.indexOf('js/spotlight.js'));
  }
});

test('one Bit: the separate AI search is gone from the client and the server', () => {
  const spot = read('../js/spotlight.js');
  for (const old of ['setAiMode', 'runAiSearch', '/search/ai', 'spot-ai']) assert.ok(!spot.includes(old), old);
  assert.ok(!engineSource().includes("'/search/ai'"));
  assert.ok(!engineSource('server/remote-access.js').includes('/search/ai'));
  assert.ok(!read('../filesearch.js').includes('searchStructured'));
});

test('the chat heads show the face and keep the name for screen readers', () => {
  const html = read('../index.html');
  assert.match(html, /id="ai-panel-title"><span class="ai-header-face" data-chatf="bit" aria-hidden="true"><\/span><span class="ai-header-name">Bit<\/span>/);
  assert.match(read('../components/MediaPanel/MediaPanel.css'), /\.bit-chat-face:not\(:empty\) \+ \.bit-chat-name \{[^}]*clip-path/);
  assert.match(read('../components/AIPanel/AIPanel.css'), /\.ai-header-face:not\(:empty\) \+ \.ai-header-name \{[^}]*clip-path/);
  // The search window and the alerts window never run media.js, so the panel fills its own head.
  assert.match(read('../js/ai-bit-chat.js'), /paintLauncher\(\);\n\s*mountHeads\(\);/);
});
