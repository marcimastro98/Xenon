// Edit mode of the widget layers (server/layers-edit.js): a runtime state that
// says so only when it changes, and turns itself off when nobody edits, so a
// forgotten edit mode never keeps the screen blocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLayersEdit, IDLE_MS } = require('../layers-edit.js');

function harness() {
  const sent = [];
  const timers = new Map();
  let next = 1;
  const edit = createLayersEdit({
    broadcast: (on) => sent.push(on),
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  const fire = () => { const all = [...timers.values()]; timers.clear(); all.forEach(t => t.fn()); };
  return { edit, sent, timers, fire };
}

test('starts off and broadcasts only real changes', () => {
  const { edit, sent } = harness();
  assert.equal(edit.get(), false);
  assert.equal(edit.set(true), true);
  edit.set(true);
  assert.equal(edit.set(false), false);
  edit.set(false);
  assert.deepEqual(sent, [true, false]);
});

test('only true turns it on', () => {
  const { edit } = harness();
  for (const v of ['true', 1, {}, null, undefined]) assert.equal(edit.set(v), false);
});

test('ten minutes without an edit turn it off, and say so', () => {
  const { edit, sent, timers, fire } = harness();
  edit.set(true);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].ms, IDLE_MS);
  assert.equal(IDLE_MS, 10 * 60 * 1000);
  fire();
  assert.equal(edit.get(), false);
  assert.deepEqual(sent, [true, false]);
});

test('an edit keeps it open for another full wait; off or stop leaves no timer', () => {
  const { edit, timers } = harness();
  edit.touch();
  assert.equal(timers.size, 0, 'touching while off arms nothing');
  edit.set(true);
  const first = [...timers.keys()][0];
  edit.touch();
  assert.equal(timers.size, 1);
  assert.notEqual([...timers.keys()][0], first, 'the wait starts over');
  edit.set(false);
  assert.equal(timers.size, 0);
  edit.set(true);
  edit.stop();
  assert.equal(timers.size, 0);
});

test('what was kept when it went on comes back once when it goes off, by hand or by the timer', () => {
  const ended = [];
  const timers = [];
  const edit = createLayersEdit({ onEnd: (v) => ended.push(v), setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  edit.set(true);
  edit.keep(['overlay']);
  edit.set(false);
  edit.set(false);
  assert.deepEqual(ended, [['overlay']], 'once');
  edit.set(true);
  edit.set(false);
  assert.equal(ended.length, 1, 'nothing kept, nothing to give back');
  edit.set(true);
  edit.keep(['desktop']);
  timers.at(-1)();
  assert.deepEqual(ended.at(-1), ['desktop'], 'the idle timer gives it back too');
});
