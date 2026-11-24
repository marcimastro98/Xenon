// A motherboard whose lights nothing drives: with iCUE closed and Xenon's own Motherboard switch
// off, a flash or an effect reached only the lights Xenon held (a LINK hub) and never the fans on
// the board. The engine looks for a board Xenon could drive, only listing USB devices and at most
// once a minute (lighting-native/board-probe.js), and says it in the status; the Lighting page's
// Devices tab then offers to drive them with one tap (lights/drivers.js, lighting-drivers.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from './browser-source.mjs';

const require = createRequire(import.meta.url);
const { createBoardProbe, SPAN_MS, LIST_LIMIT_MS } = require('../lighting-native/board-probe.js');

function clock() {
  let t = 1000;
  const timers = [];
  return {
    now: () => t, timers,
    pass: (ms) => { t += ms; },
    later: (fn, ms) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer; },
    cancel: (timer) => { if (timer) timer.live = false; },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test('the boards are listed once a minute at most, one look at a time, and a look that fails or hangs finds none', async () => {
  const c = clock();
  let looks = 0;
  let answer = () => Promise.resolve([{}, {}]);
  const probe = createBoardProbe({ discover: () => { looks += 1; return answer(); }, now: c.now, later: c.later, cancel: c.cancel });
  assert.equal(probe.found(), 0, 'nothing known before the first look');
  const [a, b] = await Promise.all([probe.refresh(), probe.refresh()]);
  assert.deepEqual([a, b, looks, probe.found()], [2, 2, 1, 2], 'two asks, one look');
  assert.equal(c.timers[0].live, false, 'its time limit let go');
  c.pass(SPAN_MS - 1);
  assert.equal(await probe.refresh(), 2);
  assert.equal(looks, 1, 'within the minute: the last answer');
  c.pass(1);
  answer = () => Promise.reject(new Error('no access'));
  assert.equal(await probe.refresh(), 0, 'refused: none');
  c.pass(SPAN_MS);
  answer = () => new Promise(() => {});
  const hanging = probe.refresh();
  await tick();
  const limit = c.timers.at(-1);
  assert.equal(limit.ms, LIST_LIMIT_MS);
  limit.fn();
  assert.equal(await hanging, 0, 'a list that never answers stops the page for two seconds at most');
});

test('the status says the boards found only while Xenon does not drive them, and the page asks for a look first', () => {
  const status = readFileSync(new URL('../lights/status.js', import.meta.url), 'utf8');
  assert.match(status, /idleBoards: own\.enabled \? 0 : boardProbe\.found\(\)/);
  assert.match(status, /native: nativeStatus\(\),/);
  const routes = readFileSync(new URL('../lights/routes.js', import.meta.url), 'utf8');
  assert.match(routes, /if \(!native\.status\(\)\.enabled\) await boardProbe\.refresh\(\);\n\s+json\(lighting\.getStatus\(\)\);/);
  const probe = readFileSync(new URL('../lighting-native/board-probe.js', import.meta.url), 'utf8');
  assert.ok(!/\.open\(/.test(probe), 'it never opens a device: that wakes the chip');
});

test('the two lines exist in every language of the app', () => {
  for (const lang of ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pt', 'ru', 'zh']) {
    const src = readFileSync(new URL(`../js/i18n/${lang}.js`, import.meta.url), 'utf8');
    assert.match(src, /\n {2}lighting_board_idle: '(?:[^'\\]|\\.)*iCUE/, lang);
    assert.match(src, /\n {2}lighting_board_take: '[^']*Xenon/, lang);
  }
});
