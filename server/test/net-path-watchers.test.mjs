import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSampler } = require('../net-path/sampler.js');
const { createPinger, MAX_GAP } = require('../net-path/pinger.js');

const turn = () => new Promise((resolve) => setImmediate(resolve));

// Fake timers: run(ms) moves the clock and fires what falls due, letting each
// tick finish before the next.
function timers() {
  let t = 0;
  const due = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, unref() {} }; due.push(h); return h; },
    clearTimer: (h) => { const i = due.indexOf(h); if (i >= 0) due.splice(i, 1); },
    count: () => due.length,
    async run(ms) {
      const end = t + ms;
      for (;;) {
        due.sort((a, b) => a.at - b.at);
        if (!due.length || due[0].at > end) break;
        const h = due.shift();
        t = Math.max(t, h.at);
        h.fn();
        await turn();
      }
      t = end;
    },
  };
}

test('the sampler probes once per period and hands every answer on', async () => {
  const k = timers();
  const got = [];
  let calls = 0;
  const s = createSampler(async () => { calls += 1; return 7; }, (v) => got.push(v), { periodMs: 1000, ...k });
  await k.run(0);
  assert.deepEqual(got, [7]);
  await k.run(999);
  assert.equal(calls, 1);
  await k.run(1);
  assert.deepEqual(got, [7, 7]);
  s.stop();
  assert.equal(k.count(), 0);
});

test('a slow probe is never overlapped; the next starts when it ends', async () => {
  const k = timers();
  let inflight = 0;
  let most = 0;
  let release = null;
  const probe = () => {
    inflight += 1;
    most = Math.max(most, inflight);
    return new Promise((resolve) => { release = () => { inflight -= 1; resolve(5); }; });
  };
  const got = [];
  const s = createSampler(probe, (v) => got.push(v), { periodMs: 1000, ...k });
  await k.run(0);
  await k.run(5000);
  assert.equal(most, 1);
  release();
  await turn();
  assert.deepEqual(got, [5]);
  await k.run(0);
  assert.equal(inflight, 1);
  assert.equal(most, 1);
  s.stop();
});

test('stop drops an answer still on its way and arms nothing', async () => {
  const k = timers();
  let release = null;
  const got = [];
  const s = createSampler(() => new Promise((resolve) => { release = resolve; }), (v) => got.push(v), { ...k });
  await k.run(0);
  s.stop();
  release(9);
  await turn();
  assert.deepEqual(got, []);
  assert.equal(k.count(), 0);
});

test('a probe that throws counts as an echo that never came back', async () => {
  const k = timers();
  const got = [];
  const s = createSampler(async () => { throw new Error('boom'); }, (v) => got.push(v), { ...k });
  await k.run(0);
  assert.deepEqual(got, [null]);
  s.stop();
});

function fakeSpawn({ throws = false } = {}) {
  const spawned = [];
  const spawn = (command, args, opts) => {
    if (throws) throw new Error('spawn failed');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.kill = () => { child.killed = true; child.emit('exit', null, 'SIGTERM'); };
    spawned.push({ command, args, opts, child });
    return child;
  };
  return { spawn, spawned };
}

const reply = (seq, ms) => `64 bytes from 192.0.2.1: icmp_seq=${seq} ttl=57 time=${ms} ms\n`;

function pinging() {
  const f = fakeSpawn();
  const watch = createPinger({ command: 'ping', args: (ip) => ['-n', ip], spawn: f.spawn });
  const got = [];
  const w = watch('192.0.2.1', (v) => got.push(v));
  return { f, watch, got, w, out: (text) => f.spawned[0].child.stdout.emit('data', text) };
}

test('one long-running ping per address, in the C locale, answers and losses in order', () => {
  const { f, got, w, out } = pinging();
  assert.equal(f.spawned.length, 1);
  const { command, args, opts } = f.spawned[0];
  assert.equal(command, 'ping');
  assert.deepEqual(args, ['-n', '192.0.2.1']);
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(opts.env.LC_ALL, 'C');
  out(`PING 192.0.2.1 (192.0.2.1) 56(84) bytes of data.\n${reply(1, 12.3)}no answer yet for icmp_seq=2\n${reply(3, 11)}`);
  assert.deepEqual(got, [12.3, null, 11]);
  assert.equal(w.dead(), false);
});

test('a line split across chunks is read once, whole', () => {
  const { got, out } = pinging();
  out('64 bytes from 192.0.2.1: icmp_se');
  assert.deepEqual(got, []);
  out('q=1 ttl=57 time=9.5 ms\n');
  assert.deepEqual(got, [9.5]);
});

test('a jump in icmp_seq counts the missing echoes as lost, at most MAX_GAP of them', () => {
  const { got, out } = pinging();
  out(reply(1, 10) + reply(4, 10));
  assert.deepEqual(got, [10, null, null, 10]);
  got.length = 0;
  out(reply(100, 10));
  assert.equal(got.length, MAX_GAP + 1);
  assert.equal(got.filter((v) => v === null).length, MAX_GAP);
});

test('a repeated, late or duplicate answer is not counted twice', () => {
  const { got, out } = pinging();
  out(`${reply(5, 10)}${reply(5, 11)}${reply(3, 12)}64 bytes from 192.0.2.1: icmp_seq=6 ttl=57 time=12.0 ms (DUP!)\n${reply(6, 13)}`);
  assert.deepEqual(got, [10, 13]);
});

test('an over-long line without a newline is dropped, not kept growing', () => {
  const { got, out } = pinging();
  out('x'.repeat(5000));
  out(reply(1, 5));
  assert.deepEqual(got, [5]);
});

test('stop kills the child; a child that exits on its own reads dead too', () => {
  const { f, watch, w } = pinging();
  w.stop();
  assert.equal(f.spawned[0].child.killed, true);
  assert.equal(w.dead(), true);
  const w2 = watch('192.0.2.1', () => {});
  f.spawned[1].child.emit('exit', 2, null);
  assert.equal(w2.dead(), true);
});

test('a missing ping is remembered and never spawned again', () => {
  const { f, watch, w } = pinging();
  f.spawned[0].child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
  assert.equal(w.dead(), true);
  assert.equal(watch('192.0.2.1', () => {}).dead(), true);
  assert.equal(f.spawned.length, 1);
});

test('a spawn that throws gives a dead watcher, not an exception', () => {
  const f = fakeSpawn({ throws: true });
  const w = createPinger({ command: 'ping', args: (ip) => [ip], spawn: f.spawn })('192.0.2.1', () => {});
  assert.equal(w.dead(), true);
});
