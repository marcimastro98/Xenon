// exclusive-hint.js: a game in exclusive full screen hides the widgets over it.
// Said once per game, only with something on the overlay, never on a guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createExclusiveHint } = require('../exclusive-hint.js');
const { rowValues, parseHeader } = require('../fpsmon.js');

function setup({ exclusive = true, overlay = true } = {}) {
  const sent = [];
  const st = { exclusive, overlay, process: 'Game.exe' };
  const hint = createExclusiveHint({
    fps: { getFrameStats: () => ({ process: st.process, exclusive: st.exclusive, avgFps: 60 }) },
    overlayShown: () => st.overlay,
    broadcast: (p) => sent.push(p),
  });
  return { hint, sent, st };
}

test('said once per game, with the process name', () => {
  const { hint, sent } = setup();
  for (let i = 0; i < 5; i++) hint.onTick('Game.exe');
  assert.deepEqual(sent, [{ process: 'Game.exe' }]);
});

test('nothing on the overlay, or not exclusive: nothing to say', () => {
  const a = setup({ overlay: false });
  a.hint.onTick('Game.exe');
  assert.equal(a.sent.length, 0);
  const b = setup({ exclusive: false });
  b.hint.onTick('Game.exe');
  assert.equal(b.sent.length, 0);
  // A widget placed later in the same game is still told about.
  a.st.overlay = true;
  a.hint.onTick('Game.exe');
  assert.equal(a.sent.length, 1);
});

test('the game closing, or another one, asks again', () => {
  const { hint, sent } = setup();
  hint.onTick('Game.exe');
  hint.onTick('');
  hint.onTick('Game.exe');
  hint.onTick('Other.exe');
  assert.equal(sent.length, 3);
});

test('a reader that throws or knows nothing says nothing', () => {
  const sent = [];
  const hint = createExclusiveHint({ fps: { getFrameStats: () => { throw new Error('x'); } }, overlayShown: () => true, broadcast: (p) => sent.push(p) });
  assert.equal(hint.onTick('Game.exe'), null);
  const linux = createExclusiveHint({ fps: { getFrameStats: () => null }, overlayShown: () => true, broadcast: (p) => sent.push(p) });
  assert.equal(linux.onTick('Game.exe'), null);
  assert.equal(createExclusiveHint({ fps: { getFrameStats: () => ({ exclusive: true }) }, overlayShown: () => { throw new Error('x'); } }).onTick('G'), null);
  assert.equal(sent.length, 0);
});

test('fpsmon: only "Hardware: Legacy" presents are exclusive full screen', () => {
  const cols = parseHeader(['Application', 'ProcessID', 'PresentMode', 'MsBetweenPresents']);
  const row = (mode) => rowValues(cols, ['game.exe', '42', mode, '8.3']);
  assert.equal(row('Hardware: Legacy Flip').exclusive, true);
  assert.equal(row('Hardware: Legacy Copy to front buffer').exclusive, true);
  assert.equal(row('Hardware: Independent Flip').exclusive, false, 'borderless with flip: overlays still show');
  assert.equal(row('Hardware Composed: Independent Flip').exclusive, false);
  const noMode = parseHeader(['Application', 'ProcessID', 'MsBetweenPresents']);
  assert.equal(rowValues(noMode, ['game.exe', '42', '8.3']).exclusive, false);
});
