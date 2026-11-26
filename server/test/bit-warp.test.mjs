// js/bit-companion/warp.js: Bit's moving effects. The cells are read off the sprite as drawn (its
// transform groups, mirrored when it walks left), each effect draws on a canvas of its own that is
// gone when it ends, the move happens once whatever goes wrong, and reduced motion only moves it.
// News (send) runs from Bit along the top edge into the island on a canvas that travels with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../js/bit-companion/warp.js', import.meta.url), 'utf8');
const BOX = { left: 100, top: 200, width: 72, height: 68 }; // 4 px per cell on a 18 x 17 stage

function classes() {
  const set = new Set();
  return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) };
}

function spriteOf(paths, { left = false, box = BOX } = {}) {
  const els = paths.map(({ d, fill = '#fff', opacity, transform = 'translate(0 0) scale(1 1)' }) => {
    const attrs = { d, fill, opacity };
    return { parentNode: { getAttribute: () => transform }, getAttribute: (k) => attrs[k] ?? null };
  });
  const svg = { viewBox: { baseVal: { x: -3, y: -5, width: 18, height: 17 } }, getBoundingClientRect: () => box, querySelectorAll: () => els };
  return { classList: classes(), querySelector: () => svg, closest: (sel) => (sel === '.is-left' && left ? {} : null), getBoundingClientRect: () => box };
}

function page({ reduced = false, noContext = false } = {}) {
  const body = [];
  const frames = [];
  const draws = [];
  const made = [];
  let now = 0;
  const canvas = () => {
    const style = { props: {}, ys: [], setProperty(k, v) { style.props[k] = v; if (k === '--warp-ty') style.ys.push(v); } };
    const el = {
      width: 0, height: 0, className: '', style, setAttribute() {},
      remove: () => body.splice(body.indexOf(el), 1),
      getContext: () => (noContext ? null : {
        setTransform() {}, clearRect() {}, globalAlpha: 1, fillStyle: '',
        fillRect: (...a) => draws.push(a),
      }),
    };
    made.push(el);
    return el;
  };
  const ctx = {
    console: { ...console, warn() {} }, Math, Promise, Object, Number, Map, WeakSet, Set,
    document: { createElement: canvas, body: { append: (el) => body.push(el) } },
    matchMedia: () => ({ matches: reduced }),
    requestAnimationFrame: (fn) => frames.push(fn),
    performance: { now: () => now },
    setTimeout: () => 0,
    devicePixelRatio: 1,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  // Runs the frames until the move is over, 100 ms apart, and tells the most canvases seen at once.
  async function run(promise) {
    let done = false;
    let most = 0;
    promise.then(() => { done = true; });
    for (let i = 0; i < 200 && !done; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      most = Math.max(most, body.length);
      now += 100;
      frames.splice(0).forEach((fn) => fn(now));
    }
    assert.equal(done, true, 'the move ends');
    return most;
  }
  return { warp: ctx.BitWarp, body, draws, made, run };
}

test('the cells are the sprite as drawn: its groups, its colours, mirrored when it walks left', () => {
  const { warp } = page();
  const paths = [{ d: 'M0 0h2v1h-2z', fill: '#abc' }, { d: 'M1 1h1v1h-1z', fill: '#def', opacity: '0.5', transform: 'translate(2 0) scale(1 1)' }];
  const cells = warp.cellsOf(spriteOf(paths));
  assert.deepEqual(Array.from(cells, (c) => [c.x, c.y, c.w, c.h, c.c, c.o]), [
    [112, 220, 4, 4, '#abc', 1], [116, 220, 4, 4, '#abc', 1], [124, 224, 4, 4, '#def', 0.5],
  ]);
  const left = warp.cellsOf(spriteOf(paths, { left: true }));
  assert.deepEqual(Array.from(left, (c) => c.x), [156, 152, 144], 'the CSS mirror, read the same way');
  assert.equal(warp.cellsOf(spriteOf(paths, { box: { ...BOX, width: 0 } })).length, 0, 'not on screen, nothing to draw');
});

test('every effect leaves, moves Bit once and arrives, on a canvas that is gone at the end', async () => {
  for (const name of [...page().warp.NAMES, 'download']) {
    const p = page();
    const sprite = spriteOf([{ d: 'M0 0h4v3h-4z' }]);
    let moves = 0;
    let hiddenWhenMoved = null;
    const most = await p.run(p.warp.move(sprite, name, () => { moves += 1; hiddenWhenMoved = sprite.classList.contains('bit-warping'); }));
    assert.equal(moves, 1, name);
    assert.equal(hiddenWhenMoved, true, `${name}: it is not seen jumping`);
    assert.ok(most >= 1 && p.draws.length > 0, `${name}: drawn`);
    assert.equal(p.body.length, 0, `${name}: no canvas left behind`);
    assert.equal(sprite.classList.contains('bit-warping'), false, `${name}: shown again`);
  }
});

test('with reduced motion, or an effect already running on it, Bit only moves', async () => {
  const calm = page({ reduced: true });
  let moves = 0;
  await calm.warp.move(spriteOf([{ d: 'M0 0h1v1h-1z' }]), 'crumble', () => { moves += 1; });
  assert.equal(moves, 1);
  assert.equal(calm.body.length, 0, 'no canvas');
  const p = page();
  const sprite = spriteOf([{ d: 'M0 0h1v1h-1z' }]);
  const first = p.warp.move(sprite, 'beam', () => {});
  let second = 0;
  await p.warp.move(sprite, 'glitch', () => { second += 1; });
  assert.equal(second, 1, 'the second only moves it');
  await p.run(first);
});

test('an effect that cannot draw still moves Bit, once, and shows it', async () => {
  const p = page({ noContext: true });
  const sprite = spriteOf([{ d: 'M0 0h1v1h-1z' }]);
  let moves = 0;
  await p.run(p.warp.move(sprite, 'packet', () => { moves += 1; }));
  assert.equal(moves, 1);
  assert.equal(p.body.length, 0);
  assert.equal(sprite.classList.contains('bit-warping'), false);
});

test('news runs from the top of Bit up, along the top edge and into the island; Bit stays', async () => {
  const p = page();
  const sprite = spriteOf([{ d: 'M0 0h4v3h-4z' }]); // its top centre at 120, 220
  const box = { left: 600, top: 10, width: 120, height: 36 };
  const most = await p.run(p.warp.send(sprite, box));
  assert.equal(most, 1);
  assert.equal(p.body.length, 0, 'no canvas left behind');
  assert.equal(sprite.classList.contains('bit-warping'), false, 'Bit itself never leaves');
  const [c] = p.made;
  const half = c.width / 2;
  assert.ok(c.width < 100 && c.height === c.width, 'a canvas the size of its tail, never of the screen');
  assert.ok(c.style.ys.includes(`${7 - half}px`), 'along the top edge, above the bar');
  assert.deepEqual([c.style.props['--warp-tx'], c.style.props['--warp-ty']], [`${660 - half}px`, `${28 - half}px`], 'into the island');
  const calm = page({ reduced: true });
  await calm.warp.send(sprite, box);
  assert.equal(calm.made.length, 0, 'with reduced motion, nothing runs');
});
