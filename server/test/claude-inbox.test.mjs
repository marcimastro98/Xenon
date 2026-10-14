import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createInbox, MAX_PER_SESSION, MAX_WAITERS } = require('../claude-inbox.js');

// Enough of a ServerResponse for the inbox: it answers once and can be closed.
function fakeRes() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.status = 0;
  res.body = null;
  res.writeHead = (status) => { res.status = status; };
  res.end = (text) => { res.writableEnded = true; res.body = JSON.parse(text); };
  return res;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

// `queue` stands in for the bridge: what takeForTerminal would hand over.
function makeInbox(extra) {
  const queue = new Map();
  const presence = [];
  const inbox = createInbox({
    take: (id) => { const t = queue.get(id) || ''; queue.delete(id); return t; },
    onPresence: (id, present) => presence.push([id, present]),
    holdMs: 40,
    graceMs: 40,
    ...extra,
  });
  return { inbox, queue, presence };
}

test('a message already waiting is answered at once', () => {
  const { inbox, queue } = makeInbox();
  queue.set(ID, 'hello from the tile');
  const res = fakeRes();
  assert.equal(inbox.hold(ID, res), 'answered');
  assert.deepEqual(res.body, { text: 'hello from the tile' });
  assert.equal(inbox.present(ID), true, 'the mod asks again in a moment');
  inbox.stop();
});

test('with nothing waiting the request is held, then answered empty', async () => {
  const { inbox } = makeInbox();
  const res = fakeRes();
  assert.equal(inbox.hold(ID, res), 'held');
  assert.equal(res.body, null);
  assert.equal(inbox.waiting, 1);
  await wait(70);
  assert.deepEqual(res.body, {});
  assert.equal(inbox.waiting, 0);
  inbox.stop();
});

test('wake hands a new message to the newest waiter, and only once', () => {
  const { inbox, queue } = makeInbox();
  const older = fakeRes();
  const newer = fakeRes();
  inbox.hold(ID, older);
  inbox.hold(ID, newer);
  assert.equal(inbox.wake(ID), false, 'nothing queued yet');
  queue.set(ID, 'run the tests');
  assert.equal(inbox.wake(ID), true);
  assert.deepEqual(newer.body, { text: 'run the tests' });
  assert.equal(older.body, null, 'still waiting');
  assert.equal(inbox.wake(ID), false, 'already taken');
  inbox.stop();
});

test('one more request than a session may hold retires the oldest', () => {
  const { inbox } = makeInbox();
  const all = Array.from({ length: MAX_PER_SESSION + 1 }, fakeRes);
  for (const res of all) inbox.hold(ID, res);
  assert.deepEqual(all[0].body, {});
  assert.equal(inbox.waiting, MAX_PER_SESSION);
  inbox.stop();
});

test('presence is reported on change only, and lasts through the gap between asks', async () => {
  const { inbox, presence } = makeInbox();
  inbox.hold(ID, fakeRes());
  assert.deepEqual(presence, [[ID, true]]);
  await wait(50);                 // the hold ran out
  const next = fakeRes();
  inbox.hold(ID, next);           // the next ask, inside the grace
  assert.deepEqual(presence, [[ID, true]], 'no flicker between two asks');
  next.emit('close');             // Claude Code exited
  assert.equal(inbox.present(ID), true, 'not gone on the first sign');
  await wait(60);
  assert.equal(inbox.present(ID), false);
  assert.deepEqual(presence, [[ID, true], [ID, false]]);
  inbox.stop();
});

test('a caller that leaves is forgotten and never handed anything', () => {
  const { inbox, queue } = makeInbox();
  const res = fakeRes();
  inbox.hold(ID, res);
  res.emit('close');
  res.emit('close');              // settling twice is harmless
  assert.equal(inbox.waiting, 0);
  queue.set(ID, 'too late');
  assert.equal(inbox.wake(ID), false);
  assert.equal(queue.get(ID), 'too late', 'still queued for the next ask');
  inbox.stop();
});

test('bad session ids and too many requests are refused', () => {
  const { inbox } = makeInbox({ holdMs: 10_000 });
  for (const bad of ['', '../etc', 'a b', null, 42, 'x'.repeat(81)]) {
    assert.equal(inbox.hold(bad, fakeRes()), 'bad_session');
  }
  for (let i = 0; i < MAX_WAITERS; i++) assert.equal(inbox.hold('s' + i, fakeRes()), 'held');
  assert.equal(inbox.hold('one-too-many', fakeRes()), 'busy');
  inbox.stop();
  assert.equal(inbox.waiting, 0);
});

test('stop answers every held request and holds nothing new', () => {
  const { inbox, queue } = makeInbox({ holdMs: 10_000 });
  const a = fakeRes();
  const b = fakeRes();
  inbox.hold(ID, a);
  inbox.hold('other-session', b);
  inbox.stop();
  assert.deepEqual(a.body, {});
  assert.deepEqual(b.body, {});
  queue.set(ID, 'never taken');
  const late = fakeRes();
  assert.equal(inbox.hold(ID, late), 'answered');
  assert.deepEqual(late.body, {});
  assert.equal(queue.get(ID), 'never taken', 'a stopping hub hands nothing over');
  assert.equal(inbox.present(ID), false);
});
