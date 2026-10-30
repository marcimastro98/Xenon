import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createGuard, guardStep, LIMITS, LEVEL_FPS, LEVEL_RES, LEVEL_STILL } = require('../js/bg-guard.js');
const { buildSrcdoc } = require('../js/custom-bg.js');

// Each guard's fake clock, in ms.
const clocks = new WeakMap();
// Feed `windows` full windows of `ms` per draw, painted `rate` times a second
// (the guard's own fps unless the browser holds it back); → the levels returned.
function feed(g, ms, windows, rate) {
  const out = [];
  let now = clocks.get(g) || 0;
  for (let i = 0; i < windows * LIMITS.size; i++) {
    const lv = guardStep(g, ms, now);
    if (lv > 0) out.push(lv);
    now += 1000 / (rate || g.fps);
  }
  clocks.set(g, now);
  return out;
}

test('a background inside its budget is never touched', () => {
  const g = createGuard(30, LIMITS);
  assert.deepEqual(feed(g, 3, 20), [], '3 ms at 30 fps = 90 ms/s, under the 200 ms/s budget');
  assert.equal(g.level, 0);
  assert.equal(g.fps, 30);
});

test('one slow window (a GC pause, a tab switch) does not trip the guard', () => {
  const g = createGuard(30, LIMITS);
  assert.deepEqual(feed(g, 20, 1), []);
  assert.deepEqual(feed(g, 2, 1), [], 'a good window resets the count');
  assert.deepEqual(feed(g, 20, 1), []);
  assert.equal(g.level, 0);
});

test('a few slow frames inside a window do not move the median', () => {
  const g = createGuard(30, LIMITS);
  for (let w = 0; w < 4; w++) {
    for (let i = 0; i < LIMITS.size; i++) assert.equal(guardStep(g, i < 5 ? 80 : 2, (w * LIMITS.size + i) * 1000 / 30), -1);
  }
  assert.equal(g.level, 0);
});

test('a heavy background steps down: half the frames, then resolution, then still', () => {
  const g = createGuard(30, LIMITS);
  assert.deepEqual(feed(g, 20, LIMITS.windows), [LEVEL_FPS]);
  assert.equal(g.fps, 15, 'level 1 halves the frame rate');
  assert.deepEqual(feed(g, 20, LIMITS.windows), [LEVEL_RES], '20 ms at 15 fps is still 300 ms/s');
  assert.deepEqual(feed(g, 20, LIMITS.windows), [LEVEL_STILL]);
  assert.deepEqual(feed(g, 20, 10), [], 'nothing after the still image');
  assert.equal(g.level, LEVEL_STILL);
});

test('halving the frame rate is enough when the load falls under the budget', () => {
  const g = createGuard(30, LIMITS);
  assert.deepEqual(feed(g, 10, LIMITS.windows), [LEVEL_FPS], '10 ms at 30 fps = 300 ms/s');
  assert.deepEqual(feed(g, 10, 20), [], '10 ms at 15 fps = 150 ms/s: it stays at level 1');
});

test('a frame the browser already holds back is judged on what it really costs', () => {
  const g = createGuard(30, LIMITS);
  assert.deepEqual(feed(g, 25, 10, 1), [], '25 ms once a second is 25 ms/s, whatever the cap says');
  assert.equal(g.level, 0);
  assert.deepEqual(feed(g, 25, LIMITS.windows, 30), [LEVEL_FPS], 'the same draw at full rate does step down');
});

test('the guard functions are self-contained, so the frame can embed their source', () => {
  // The frame gets them through Function#toString: rebuilt with no outer scope,
  // they must behave exactly the same.
  const rebuilt = new Function(createGuard.toString() + guardStep.toString() + 'return { createGuard, guardStep };')();
  const g = rebuilt.createGuard(30, LIMITS);
  let last = -1;
  for (let i = 0; i < LIMITS.windows * LIMITS.size; i++) last = rebuilt.guardStep(g, 20, i * 1000 / 30);
  assert.equal(last, LEVEL_FPS);
});

// ── the real frame script, run with a fake clock ─────────────────────────────

function frameScript(html) {
  const start = html.indexOf('<script>') + '<script>'.length;
  return html.slice(start, html.indexOf('</scr' + 'ipt>', start));
}

// Runs a srcdoc's script where each draw() takes `drawMs`; → what the frame
// told its parent and how often it painted, over `seconds` of fake time.
function runFrame(html, drawMs, seconds) {
  let now = 0, rafs = [], timers = [];
  const messages = [], paints = [], sizes = [];
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ setTransform() {}, clearRect() {}, fillRect() {} }),
  };
  Object.defineProperty(canvas, 'width', { get() { return this._w; }, set(v) { this._w = v; sizes.push(v); } });
  const ctx = {
    innerWidth: 2560, innerHeight: 720, devicePixelRatio: 1,
    document: { getElementById: () => canvas, addEventListener() {}, hidden: false },
    addEventListener() {},
    requestAnimationFrame: (cb) => { rafs.push(cb); return rafs.length; },
    cancelAnimationFrame: () => { rafs = []; },
    setTimeout: (fn, ms) => { timers.push({ at: now + ms, fn }); return timers.length; },
    clearTimeout: () => { timers = []; },
    performance: { now: () => now },
    parent: { postMessage: (m) => messages.push(Object.assign({ at: now }, m)) },
    __drawn: () => { paints.push(now); now += drawMs; },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(frameScript(html), ctx);
  const VSYNC = 1000 / 60;
  for (let tick = now; tick < seconds * 1000; tick += VSYNC) {
    now = Math.max(now, tick);
    const due = timers.filter((x) => x.at <= now);
    timers = timers.filter((x) => x.at > now);
    due.forEach((x) => x.fn());
    const cbs = rafs; rafs = [];
    cbs.forEach((cb) => cb(now));
  }
  return { messages, paints, sizes };
}

const CODE = 'function draw(ctx, t, w, h) { __drawn(); }';

test('in the frame, a heavy background ends as a still image and tells the host each step', () => {
  const { messages, paints } = runFrame(buildSrcdoc(CODE, null, 30), 25, 40);
  const steps = messages.filter((m) => '__xbgSlow' in m);
  assert.deepEqual(steps.map((m) => m.__xbgSlow), [1, 2, 3]);
  const still = steps[2].at;
  assert.ok(still < 25000, 'still within 25 s of mounting, at ' + Math.round(still) + ' ms');
  assert.ok(paints[paints.length - 1] <= still, 'no paint after the still step');
});

test('in the frame, level 2 lowers the canvas to a quarter of the pixels', () => {
  const { sizes } = runFrame(buildSrcdoc(CODE, null, 30), 25, 40);
  assert.equal(sizes[0], 2560, 'full width at first (2560x720 is under the pixel cap)');
  assert.equal(sizes[sizes.length - 1], 1280, 'half the width and height = a quarter of the pixels');
});

test('in the frame, a light background keeps painting at its rate', () => {
  const { messages, paints } = runFrame(buildSrcdoc(CODE, null, 30), 2, 10);
  assert.equal(messages.filter((m) => m && '__xbgSlow' in m).length, 0);
  assert.ok(paints.length > 270, 'about 30 paints a second for 10 s, got ' + paints.length);
});

test('with the guard off, a heavy background is left alone', () => {
  const html = buildSrcdoc(CODE, null, 30, false);
  assert.ok(html.includes('var G=null;'));
  const { messages, paints } = runFrame(html, 25, 10);
  assert.equal(messages.filter((m) => m && '__xbgSlow' in m).length, 0);
  assert.ok(paints[paints.length - 1] > 9000, 'still painting at the end');
});

// ── the setting, on both sides ───────────────────────────────────────────────

// The bgGuard line of each normalizer, read from the shipped source and run
// against the same inputs: both must keep an explicit off, and default to on.
function ruleFrom(file, param) {
  const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const m = /^\s*bgGuard: (.+),\s*$/m.exec(src);
  assert.ok(m, 'no bgGuard line in ' + file);
  return new Function(param, 'return ' + m[1] + ';');
}

test('client and server keep the guard setting the same way', () => {
  const server = ruleFrom('../server.js', 'source');
  const client = ruleFrom('../js/settings.js', 'value');
  for (const [input, want] of [[{}, true], [{ bgGuard: true }, true], [{ bgGuard: false }, false], [{ bgGuard: 'off' }, true]]) {
    assert.equal(server(input), want, 'server ' + JSON.stringify(input));
    assert.equal(client(input), want, 'client ' + JSON.stringify(input));
  }
});
