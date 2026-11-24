// Each fan driver in its own time (server/airflow/loop-drivers.js): a LINK hub waiting on USB
// must never hold the board's readings or commands, and calls to one driver never overlap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDriverCalls } = require('../airflow/loop-drivers.js');
const { STALE_MS } = require('../airflow/limits.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A driver whose every call is logged, and which notes a call made while another is running.
function driver(id, { pollMs = 0, applyMs = 0, reading = { id } } = {}) {
  const d = { id, log: [], overlaps: [], running: 0 };
  const call = (name, ms, value) => async () => {
    if (d.running) d.overlaps.push(name);
    d.running += 1;
    d.log.push(name);
    if (ms) await sleep(ms);
    d.running -= 1;
    d.log.push(`${name} done`);
    return value;
  };
  Object.assign(d, { poll: call('poll', pollMs, reading), apply: call('apply', applyMs), release: call('release', 0) });
  return d;
}

test('a slow driver never holds the reading of the others', async () => {
  let now = 0;
  const calls = createDriverCalls({ clock: () => now, waitMs: 30 });
  const board = driver('board');
  const hub = driver('hub', { pollMs: 300 });
  const s = Date.now();
  const [b, h] = await calls.poll([board, hub], false);
  assert.ok(Date.now() - s < 200, `the tick waited ${Date.now() - s} ms`);
  assert.deepEqual(b, { id: 'board' });
  assert.equal(h, null, 'the hub has nothing recent yet');
  await sleep(350);
  now += 1000;
  const [, again] = await calls.poll([board, hub], false);
  assert.deepEqual(again, { id: 'hub' }, 'its reading taken up at the next tick');
});

test('a busy driver is not asked again; its last reading stands while recent, then none', async () => {
  let now = 0;
  const calls = createDriverCalls({ clock: () => now, waitMs: 20 });
  const hub = driver('hub');
  assert.deepEqual((await calls.poll([hub], false))[0], { id: 'hub' });
  hub.poll = async () => { hub.log.push('poll'); await sleep(400); return { id: 'hub', late: true }; };
  now += 1000;
  assert.deepEqual((await calls.poll([hub], false))[0], { id: 'hub' }, 'not landed yet: the last one');
  now += STALE_MS - 1000;
  assert.deepEqual((await calls.poll([hub], false))[0], { id: 'hub' }, 'still recent');
  now += 1;
  assert.equal((await calls.poll([hub], false))[0], null, 'too old');
  assert.equal(hub.log.filter((e) => e === 'poll').length, 2, 'asked once while busy');
  // A call asked of a busy driver waits in its line: a stuck hub would pile one up every tick.
  await sleep(1300);
  assert.equal(hub.log.filter((e) => e === 'poll').length, 2, 'nothing queued behind the busy call');
});

test('a command skips a busy driver and reaches the others at once', async () => {
  const calls = createDriverCalls({ waitMs: 30 });
  const board = driver('board');
  const hub = driver('hub', { pollMs: 300 });
  await calls.poll([board, hub], false);
  const s = Date.now();
  await calls.act([board, hub], (d) => d.apply(), false);
  assert.ok(Date.now() - s < 200, `the command waited ${Date.now() - s} ms`);
  assert.ok(board.log.includes('apply done'));
  assert.ok(!hub.log.includes('apply'), 'the hub gets the next one');
  await sleep(400);
  assert.ok(!hub.log.includes('apply'), 'not even after its call: no command piles up behind it');
});

test('a slow command never holds the tick past the wait, and still lands', async () => {
  const calls = createDriverCalls({ waitMs: 30 });
  const board = driver('board');
  const hub = driver('hub', { applyMs: 300 });
  const s = Date.now();
  await calls.act([board, hub], (d) => d.apply(), false);
  assert.ok(Date.now() - s < 200, `the tick waited ${Date.now() - s} ms`);
  assert.ok(board.log.includes('apply done'));
  await sleep(350);
  assert.ok(hub.log.includes('apply done'));
});

test('letting go reaches a busy driver after its call, never during it', async () => {
  const calls = createDriverCalls({ waitMs: 20 });
  const hub = driver('hub', { pollMs: 150 });
  await calls.poll([hub], false);
  await calls.act([hub], (d) => d.release(), true);
  await sleep(250);
  assert.deepEqual(hub.log, ['poll', 'poll done', 'release', 'release done']);
  assert.deepEqual(hub.overlaps, []);
});

test('calls to one driver run in the order asked, one at a time', async () => {
  const calls = createDriverCalls();
  const d = driver('d', { pollMs: 40, applyMs: 20 });
  await Promise.all([calls.run(d, (x) => x.poll()), calls.run(d, (x) => x.apply()), calls.run(d, (x) => x.release())]);
  assert.deepEqual(d.log, ['poll', 'poll done', 'apply', 'apply done', 'release', 'release done']);
  assert.deepEqual(d.overlaps, []);
});

test('a failed call never stops the next one', async () => {
  const calls = createDriverCalls();
  const d = driver('d');
  await assert.rejects(calls.run(d, async () => { throw new Error('usb'); }));
  assert.equal(await calls.run(d, async () => 'next'), 'next');
  d.poll = async () => { throw new Error('usb'); };
  assert.deepEqual(await calls.poll([d], false), [null]);
});

test('a look waits for every driver to answer', async () => {
  const calls = createDriverCalls({ waitMs: 20 });
  const hub = driver('hub', { pollMs: 150 });
  assert.deepEqual(await calls.poll([hub], true), [{ id: 'hub' }]);
});
