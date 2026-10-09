'use strict';
// js/claude-thread.js — keeps a session's conversation current in the Claude
// tile. Pinned: the end of a turn is never missed (re-reads after any state
// change, including waiting -> idle, until the transcript says the turn
// closed), an older answer never overwrites a newer one, a failed read keeps
// what is shown, and the Stop hook's final text fills in until the file has it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { create, withProvisional, sameThread, SETTLE_MS } = require('../js/claude-thread.js');

function harness(replies) {
  const timers = [];
  const calls = [];
  let changes = 0;
  const ctl = create({
    fetchJson: (url) => { calls.push(url); return replies.shift() || Promise.resolve(null); },
    onChange: () => { changes++; },
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    setEvery: () => ({}), clearEvery: () => {},
  });
  return { ctl, timers, calls, changes: () => changes };
}
const msg = (role, text) => ({ role, text, at: 0 });
const flush = () => new Promise((r) => setImmediate(r));

test('withProvisional adds the Stop text only when the transcript lacks it', () => {
  const sess = { state: 'idle', lastSaid: 'Done: the tile now shows the end.' };
  const old = [msg('user', 'fix it'), msg('assistant', 'Working on it')];
  assert.equal(withProvisional(old, sess, false).at(-1).provisional, true);
  const has = old.concat([msg('assistant', 'Done:  the tile now shows the end.')]);
  assert.equal(withProvisional(has, sess, false).length, 3, 'whitespace differences still match');
  assert.equal(withProvisional(old, sess, true).length, 2, 'a closed turn trusts the file');
  assert.equal(withProvisional(old, { ...sess, state: 'running' }, false).length, 2);
});

test('sameThread compares length and the last message', () => {
  assert.equal(sameThread([msg('assistant', 'a')], [msg('assistant', 'a')]), true);
  assert.equal(sameThread([msg('assistant', 'a')], [msg('assistant', 'b')]), false);
  assert.equal(sameThread([], [msg('user', 'x')]), false);
});

test('any state change re-reads until the turn is closed, waiting -> idle included', async () => {
  const h = harness([Promise.resolve({ ok: true, closed: false, messages: [msg('user', 'q')] })]);
  h.ctl.open('s1');
  await flush();
  h.ctl.sync({ state: 'waiting' });
  h.ctl.sync({ state: 'idle' });
  assert.deepEqual(h.timers.map((t) => t.ms), SETTLE_MS);
  // A read that sees the closing lines cancels the remaining settle reads.
  const replies = [Promise.resolve({ ok: true, closed: true, messages: [msg('user', 'q'), msg('assistant', 'end')] })];
  const h2 = harness(replies);
  h2.ctl.open('s1');
  h2.ctl.sync({ state: 'running' });
  h2.ctl.sync({ state: 'idle' });
  await flush();
  assert.equal(h2.timers.length, 0, 'closed turn stops the settle reads');
  assert.equal(h2.ctl.view({ state: 'idle' }).at(-1).text, 'end');
});

test('an older answer never overwrites a newer one; a failure keeps the thread', async () => {
  let resolveOld;
  const oldReply = new Promise((r) => { resolveOld = r; });
  const h = harness([oldReply, Promise.resolve({ ok: true, messages: [msg('assistant', 'new')] }), Promise.resolve(null)]);
  h.ctl.open('s1');
  h.ctl.load();
  await flush();
  resolveOld({ ok: true, messages: [msg('assistant', 'old')] });
  await flush();
  assert.equal(h.ctl.view(null).at(-1).text, 'new');
  await h.ctl.load();
  assert.equal(h.ctl.view(null).at(-1).text, 'new', 'null answer keeps what is shown');
});

test('showFull asks the server for uncut messages', async () => {
  const h = harness([Promise.resolve({ ok: true, messages: [] }), Promise.resolve({ ok: true, messages: [] })]);
  h.ctl.open('s9');
  await flush();
  h.ctl.showFull();
  assert.match(h.calls.at(-1), /full=1$/);
});
