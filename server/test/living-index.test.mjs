import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLivingIndex } = require('../living-index.js');

// A host on the other end of the pipes: it records what it is asked and answers
// with `reply`. `helperExe` is this very process, so the file always exists.
function fakeHosts(reply = () => ({ ok: true })) {
  const spawned = [];
  const asked = [];
  const spawn = () => {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.unref = () => {};
    proc.kill = () => {};
    proc.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const req = JSON.parse(line);
        asked.push(req);
        const env = { id: req.id, ...reply(req) };
        proc.stdout.write('XEIDX ' + Buffer.from(JSON.stringify(env)).toString('base64') + '\n');
      }
    });
    spawned.push(proc);
    return proc;
  };
  return { spawn, spawned, asked, helperExe: process.execPath };
}

const ROOTS = ['C:\\'];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the walk waits for its start time, then starts by itself', async () => {
  const hosts = fakeHosts();
  const index = createLivingIndex({ ...hosts, startDelayMs: 40 });
  index.setRoots(ROOTS);
  assert.equal(hosts.spawned.length, 0, 'nothing runs while the PC is starting');
  await wait(90);
  assert.equal(hosts.spawned.length, 1);
  index.stop();
});

test('with no delay the walk starts when the roots are set', () => {
  const hosts = fakeHosts();
  const index = createLivingIndex(hosts);
  index.setRoots(ROOTS);
  assert.equal(hosts.spawned.length, 1);
  index.stop();
});

test('a search opens the way at once, the status does not', async () => {
  const hosts = fakeHosts(() => ({ ok: true, items: [], building: true }));
  const index = createLivingIndex({ ...hosts, startDelayMs: 60000 });
  index.setRoots(ROOTS);
  const before = await index.stats();
  assert.equal(before.building, true);
  assert.equal(before.starting, true);
  assert.equal(await index.overview('C:\\'), null, 'the disk map falls back to what it has');
  assert.equal(hosts.spawned.length, 0, 'a widget reading the status is not a search');
  const out = await index.query({ terms: ['x'] });
  assert.deepEqual(out.items, []);
  assert.equal(hosts.spawned.length, 1);
  index.stop();
});

test('a held index does not start, and starts when the hold ends', async () => {
  const hosts = fakeHosts();
  const index = createLivingIndex(hosts);
  index.hold(true);
  index.setRoots(ROOTS);
  assert.equal(hosts.spawned.length, 0);
  assert.equal(await index.query({ terms: ['x'] }), null, 'the other search backend answers');
  assert.equal(hosts.spawned.length, 0, 'not even for a search, a game is running');
  assert.equal((await index.stats()).held, true);
  index.hold(false);
  assert.equal(hosts.spawned.length, 1);
  index.stop();
});

test('a running host is told once per change, and stays running', async () => {
  const hosts = fakeHosts();
  const index = createLivingIndex(hosts);
  index.setRoots(ROOTS);
  index.hold(true);
  index.hold(true);
  index.hold(false);
  index.hold(false);
  await wait(10);
  assert.deepEqual(hosts.asked.map((r) => [r.op, r.on]), [['hold', true], ['hold', false]]);
  assert.equal(hosts.spawned.length, 1);
  index.stop();
});

test('an older host that refuses the hold changes nothing', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  const hosts = fakeHosts((req) => (req.op === 'hold' ? { ok: false, err: 'unknown op' } : { ok: true, ready: true }));
  const index = createLivingIndex(hosts);
  index.setRoots(ROOTS);
  index.hold(true);
  await wait(10);
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, []);
  assert.equal((await index.stats()).ready, true);
  index.stop();
});

test('a host that dies during a game is not started again during it', async () => {
  const hosts = fakeHosts();
  const index = createLivingIndex(hosts);
  index.setRoots(ROOTS);
  index.hold(true);
  hosts.spawned[0].emit('exit');
  await wait(5);
  assert.equal(index._running(), false);
  assert.equal(await index.query({ terms: ['x'] }), null);
  assert.equal(hosts.spawned.length, 1, 'no respawn during the game');
  index.stop();
});

test('after stop nothing starts: not the timer, not the end of a hold', async () => {
  const hosts = fakeHosts();
  const index = createLivingIndex({ ...hosts, startDelayMs: 30 });
  index.setRoots(ROOTS);
  index.hold(true);
  index.stop();
  index.hold(false);
  await wait(60);
  assert.equal(hosts.spawned.length, 0);
});
