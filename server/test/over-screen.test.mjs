// server/capabilities/over-screen.js: over a game in exclusive full screen an
// action that opens a window says so, and leaves the game its keyboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { overExclusive, opensWindow, refusedOverGame, OVER_EXCLUSIVE_HINT } = require('../capabilities/over-screen.js');
const { createCapabilities } = require('../capabilities/index.js');

const exclusive = { getFrameStats: () => ({ process: 'game.exe', exclusive: true }) };
const composed = { getFrameStats: () => ({ process: 'game.exe', exclusive: false }) };
const closedMenu = { get: () => ({ open: false }) };

test('only a named game in exclusive full screen counts', () => {
  assert.equal(overExclusive(exclusive), true);
  assert.equal(overExclusive(composed), false);
  assert.equal(overExclusive({ getFrameStats: () => null }), false);
  assert.equal(overExclusive({ getFrameStats: () => ({ process: '', exclusive: true }) }), false, 'nothing read is no game');
  assert.equal(overExclusive({ getFrameStats: () => { throw new Error('x'); } }), false);
  assert.equal(overExclusive(null), false);
});

test('what needs a window on the screen is refused, what needs none is not', () => {
  const needs = [
    { type: 'xenonMenu', mode: 'toggle' }, { type: 'xenonMenu', mode: 'open' },
    { type: 'xenonScreen', screen: 'chat' }, { type: 'screenColor' }, { type: 'screenMeasure' },
    { type: 'screenPin' }, { type: 'screenCover' }, { type: 'screenDraw', mode: 'toggle' },
    { type: 'screenshot', target: 'region', mode: 'take' }, { type: 'screenText' },
    { type: 'layersEdit', mode: 'toggle' },
  ];
  for (const a of needs) assert.equal(opensWindow(a, closedMenu), true, JSON.stringify(a));
  const free = [
    { type: 'screenshot', target: 'screen', mode: 'take' }, { type: 'screenshot', target: 'window', mode: 'take' },
    { type: 'screenshot', target: 'region', mode: 'reveal' }, { type: 'screenText', target: 'screen' },
    { type: 'record', mode: 'toggle' }, { type: 'benchmark', mode: 'toggle' }, { type: 'stutterWhy' },
    { type: 'screenDraw', mode: 'stop' }, { type: 'layersEdit', mode: 'off' }, { type: 'xenonMenu', mode: 'close' },
  ];
  for (const a of free) assert.equal(opensWindow(a, closedMenu), false, JSON.stringify(a));
});

test('a menu already open can always be closed by its key', () => {
  const open = { get: () => ({ open: true }) };
  assert.equal(refusedOverGame({ fps: exclusive, menu: open }, { type: 'xenonMenu', mode: 'toggle' }), false);
  assert.equal(refusedOverGame({ fps: exclusive, menu: closedMenu }, { type: 'xenonMenu', mode: 'toggle' }), true);
});

test('the menu key over an exclusive game opens nothing and says why', async () => {
  const calls = [];
  const menu = {
    get: () => ({ open: false, section: 'now' }), show: () => 'screen',
    toggle: () => { calls.push('toggle'); return 'screen'; }, close: () => 'closed',
    showSheet: () => { calls.push('sheet'); return 'screen'; },
  };
  const caps = createCapabilities({ fps: exclusive, menu });
  const refused = { ok: false, error: 'over_exclusive', hint: OVER_EXCLUSIVE_HINT };
  assert.deepEqual(await caps.run({ type: 'xenonMenu', mode: 'toggle' }), refused);
  assert.deepEqual(await caps.run({ type: 'xenonScreen', screen: 'chat' }), refused);
  assert.match(OVER_EXCLUSIVE_HINT, /borderless/, 'Bit has what to tell the user');
  assert.deepEqual(calls, []);
});

test('over a borderless game the menu opens as ever', async () => {
  const menu = { get: () => ({ open: false, section: 'now' }), show: () => 'screen', toggle: () => 'screen', close: () => 'closed' };
  const caps = createCapabilities({ fps: composed, menu });
  assert.equal((await caps.run({ type: 'xenonMenu', mode: 'toggle' })).ok, true);
});
