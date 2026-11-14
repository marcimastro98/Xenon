// The queue in front of the Windows Search process (server/filesearch.js: dispatch, drain,
// hostRequest). The process answers one query at a time, so one query is in flight, at most one
// waits, and a newer one takes the place of the one waiting, which is told 'superseded'.
//
// The other file search tests replace the whole round trip (`_setHostRunner`) and never reach
// the queue. Here the process itself is made up (`spawnHost`): the queue, the host's bookkeeping
// and the line protocol all run for real, and no PowerShell starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createFileSearch } = require('../filesearch.js');

// A process that only records what it is written and says what the test tells it to.
function fakeHost() {
  const writes = [];
  const waiters = [];
  const spawned = [];
  const fake = { writes, spawned, proc: null, refuseSpawn: false, refuseWrite: false };
  fake.spawnHost = (command, args) => {
    if (fake.refuseSpawn) throw new Error('spawn refused');
    spawned.push([command, args.at(-1)]);
    const proc = new EventEmitter();
    proc.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    proc.stderr = new EventEmitter();
    proc.stdin = Object.assign(new EventEmitter(), {
      write(line) {
        if (fake.refuseWrite) throw new Error('pipe closed');
        writes.push(JSON.parse(line));
        for (const waiter of waiters.splice(0)) waiter();
      },
      // The real process exits when its input closes.
      end() { queueMicrotask(() => proc.emit('exit')); },
    });
    proc.kill = () => {};
    proc.unref = () => {};
    fake.proc = proc;
    return proc;
  };
  /** Resolves when the process has been written `count` requests in all. */
  fake.wrote = async (count) => {
    while (writes.length < count) await new Promise((resolve) => waiters.push(resolve));
    return writes[count - 1];
  };
  fake.answer = (id, out) => {
    const body = Buffer.from(JSON.stringify({ id, ok: true, out })).toString('base64');
    fake.proc.stdout.emit('data', `XESRCH ${body}\n`);
  };
  return fake;
}

function make() {
  const host = fakeHost();
  const search = createFileSearch({
    dataDir: mkdtempSync(path.join(tmpdir(), 'xenon-fsearch-queue-')),
    platform: 'win32',
    spawnHost: host.spawnHost,
  });
  return { host, search };
}
const row = (name) => ({ p: `D:\\Docs\\${name}`, n: name, s: 1, m: 1 });
const names = (answer) => answer.results.map((result) => result.name);
// catalog() reaches the queue after a promise turn and no reading of the disk (a plain word is not
// a pasted path), so one turn of the event loop later the query is in it. Not a wait on a clock.
const queued = () => new Promise((resolve) => setImmediate(resolve));

test('one query in flight, one waiting: a newer one takes the place of the one waiting', async () => {
  const { host, search } = make();
  try {
    const first = search.catalog('alpha');
    const sent = await host.wrote(1);
    assert.deepEqual(host.spawned, [['powershell.exe', '-Serve']], 'the process is started by the first query');
    assert.deepEqual(sent.q.terms, ['alpha']);

    const second = search.catalog('beta');
    const third = search.catalog('gamma');
    assert.deepEqual(await second, { ok: true, wds: 'superseded', results: [] }, 'the one that waited is told so');
    assert.equal(host.writes.length, 1, 'nothing is written while the first is in flight');

    host.answer(sent.id, [row('alpha.txt')]);
    assert.deepEqual([(await first).wds, names(await first)], ['ok', ['alpha.txt']]);
    const next = await host.wrote(2);
    assert.deepEqual(next.q.terms, ['gamma'], 'the answer lets the newest one go, never the one it replaced');
    assert.notEqual(next.id, sent.id);
    host.answer(next.id, [row('gamma.txt')]);
    assert.deepEqual(names(await third), ['gamma.txt']);
    assert.equal(host.spawned.length, 1, 'one process served them all');
  } finally {
    await search.stop();
  }
});

test('a process that cannot be started refuses the query, and the next query tries again', async () => {
  const { host, search } = make();
  try {
    host.refuseSpawn = true;
    assert.equal((await search.catalog('alpha')).wds, 'unavailable');
    host.refuseSpawn = false;
    const later = search.catalog('beta');
    const sent = await host.wrote(1);
    host.answer(sent.id, [row('beta.txt')]);
    assert.deepEqual(names(await later), ['beta.txt'], 'the refused query did not leave the queue busy');
  } finally {
    await search.stop();
  }
});

test('a write the pipe refuses fails that query only: the queue is free for the next', async () => {
  const { host, search } = make();
  try {
    const first = search.catalog('alpha');
    const sent = await host.wrote(1);
    const second = search.catalog('beta');
    await queued();
    host.refuseWrite = true;
    host.answer(sent.id, []);
    assert.equal((await first).wds, 'ok');
    assert.equal((await second).wds, 'error', 'the one waiting was sent next, and its write was refused');

    host.refuseWrite = false;
    const third = search.catalog('gamma');
    const next = await host.wrote(2);
    assert.deepEqual(next.q.terms, ['gamma']);
    host.answer(next.id, [row('gamma.txt')]);
    assert.deepEqual(names(await third), ['gamma.txt']);
  } finally {
    await search.stop();
  }
});

test('a process that dies fails the query in flight, and the one waiting is not left hanging', async () => {
  const { host, search } = make();
  try {
    const first = search.catalog('alpha');
    await host.wrote(1);
    const second = search.catalog('beta');
    await queued();
    host.proc.emit('exit');
    assert.equal((await first).wds, 'error');
    assert.equal((await second).wds, 'unavailable', 'no new process is started right after one died');
    assert.equal(host.spawned.length, 1);
  } finally {
    await search.stop();
  }
});

test('an answer for a request nobody waits for, or a line that is not an answer, is passed over', async () => {
  const { host, search } = make();
  try {
    const first = search.catalog('alpha');
    const sent = await host.wrote(1);
    host.proc.stdout.emit('data', 'noise\nXESRCH not-base64-json\n');
    host.answer(sent.id + 100, [row('other.txt')]);
    host.answer(sent.id, [row('alpha.txt')]);
    assert.deepEqual(names(await first), ['alpha.txt']);
  } finally {
    await search.stop();
  }
});
