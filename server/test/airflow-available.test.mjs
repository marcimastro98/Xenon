// Which drivers Airflow can use (server/airflow/loop-available.js): every driver is asked
// once a minute; one waiting on something the person fixes with one confirmation (the
// sensor service installed or updated) is asked alone every few seconds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAvailability, SOON_EVERY_MS, SOON_WHYS } = require('../airflow/loop-available.js');

function driver(id, answer) {
  const d = {
    id, answer, asked: 0, released: 0,
    async available() { d.asked += 1; if (d.answer instanceof Error) throw d.answer; return d.answer; },
    async release() { d.released += 1; },
  };
  return d;
}
const fresh = () => ({ availAt: -Infinity, usable: [], unavailable: {} });
// A check the tick waits for to the end (nothing held yet).
async function check(a, st, now) { a.start(st, now); await a.settle(st, true); }

test('available: every driver asked, the usable kept, the others with their reason', async () => {
  const lhm = driver('lhm', { ok: false, why: 'outdated' });
  const link = driver('link', { ok: true, why: null });
  const broken = driver('x', new Error('boom'));
  const st = fresh();
  await check(createAvailability({ drivers: [lhm, link, broken] }), st, 1000);
  assert.equal(st.availAt, 1000);
  assert.deepEqual(st.usable, [link]);
  assert.deepEqual(st.unavailable, { lhm: 'outdated', x: 'error' });
});

test('available: a driver that stops answering lets its fans go', async () => {
  const link = driver('link', { ok: true, why: null });
  const st = fresh();
  const a = createAvailability({ drivers: [link] });
  await check(a, st, 0);
  link.answer = { ok: false, why: 'vendor-app' };
  await check(a, st, 60000);
  assert.equal(link.released, 1);
  assert.deepEqual(st.usable, []);
});

test('available: a driver waiting on the sensor service is asked alone, every few seconds', async () => {
  assert.deepEqual([...SOON_WHYS].sort(), ['no-service', 'outdated']);
  const lhm = driver('lhm', { ok: false, why: 'outdated' });
  const link = driver('link', { ok: true, why: null });
  const st = fresh();
  const a = createAvailability({ drivers: [lhm, link] });
  await check(a, st, 0);
  const asked = () => [lhm.asked, link.asked];
  assert.deepEqual(asked(), [1, 1]);
  assert.equal(await a.soon(st, 1000), false);
  assert.deepEqual(asked(), [2, 1], 'the hub is not asked again');
  assert.equal(await a.soon(st, 1000 + SOON_EVERY_MS - 1), false);
  assert.deepEqual(asked(), [2, 1], 'not before its time');
  lhm.answer = { ok: true, why: null };
  assert.equal(await a.soon(st, 1000 + SOON_EVERY_MS), true, 'the service answers: a full check is due');
});

test('available: nothing the person can fix, nothing asked between the minutes', async () => {
  for (const why of ['no-hub', 'link-off', 'vendor-app', 'no-control', 'no-mode', 'access', 'error', 'platform']) {
    const d = driver('d', { ok: false, why });
    const st = fresh();
    const a = createAvailability({ drivers: [d] });
    await check(a, st, 0);
    assert.equal(await a.soon(st, 10 * SOON_EVERY_MS), false, why);
    assert.equal(d.asked, 1, why);
  }
});

// A busy PC held the service's heartbeat read, and the look at the running apps, for seconds
// (23 Nov 2026): while fans are held the tick waits a moment and takes the answer up later.
test('available: while fans are held a slow check never holds the tick, and its answer is taken up later', async () => {
  let land = () => {};
  const link = driver('link', { ok: true, why: null });
  const slow = { id: 'lhm', asked: 0, released: 0, available() { slow.asked += 1; return new Promise((res) => { land = res; setTimeout(() => res({ ok: false, why: 'error' }), 3000).unref(); }); }, async release() { slow.released += 1; } };
  const st = fresh();
  const a = createAvailability({ drivers: [slow, link], waitMs: 20 });
  a.start(st, 0);
  const t0 = Date.now();
  await a.settle(st, false);
  assert.ok(Date.now() - t0 < 1000, 'the tick went on');
  assert.equal(st.availAt, 0, 'asked once, not again every tick');
  assert.deepEqual(st.usable, [], 'nothing taken before the answers land');
  a.start(st, 1000);
  assert.equal(slow.asked, 1, 'one check at a time');
  land({ ok: true, why: null });
  await a.settle(st, false);
  assert.deepEqual(st.usable, [slow, link]);
});

test('available: a slow answer from a waiting driver is taken up at a later tick', async () => {
  let land = () => {};
  const lhm = { id: 'lhm', answer: { ok: false, why: 'outdated' }, available() { return lhm.answer instanceof Promise ? lhm.answer : Promise.resolve(lhm.answer); }, async release() {} };
  const st = fresh();
  const a = createAvailability({ drivers: [lhm], waitMs: 20 });
  await check(a, st, 0);
  lhm.answer = new Promise((res) => { land = res; setTimeout(() => res({ ok: false, why: 'outdated' }), 3000).unref(); });
  assert.equal(await a.soon(st, SOON_EVERY_MS, false), false, 'not landed yet');
  land({ ok: true, why: null });
  await new Promise((res) => setImmediate(res));
  assert.equal(await a.soon(st, SOON_EVERY_MS + 1000, false), true, 'taken up although not asked again');
  assert.equal(await a.soon(st, SOON_EVERY_MS + 2000, false), false, 'and only once');
});
