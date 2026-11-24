// Airflow's fan commands on a thread of their own (server/airflow/fan-files.js): on a PC busy
// on every core the antivirus held file opens long enough to fill libuv's shared pool, and a
// fan command waited 26 s behind them (23 Nov 2026). fan.json, which the antivirus holds, is
// read on the pool, and the thread ends when Airflow stops asking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, promises as fsp } from 'node:fs';
import { pbkdf2 } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const { createFanFiles } = require('../airflow/fan-files.js');
const { MAX_FILE_BYTES } = require('../sensor-service/reader.js');

function dir() {
  const root = mkdtempSync(join(tmpdir(), 'xenon-fan-files-'));
  mkdirSync(join(root, 'fan'));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

// A thread answering like the real one, each call taking `callMs`.
const fakeThread = (callMs) => () => new Worker(`
  const { parentPort } = require('node:worker_threads');
  parentPort.on('message', ({ id, op }) => {
    if (${callMs}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${callMs});
    parentPort.postMessage({ id, ok: true, value: op === 'list' ? [] : null });
  });`, { eval: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the calls: create never writes through a name already there, list, stat, unlink', async () => {
  const d = dir();
  const files = createFanFiles();
  try {
    const name = join(d.root, 'fan', 'fan-1-2');
    await files.create(name);
    await assert.rejects(files.create(name), { code: 'EEXIST' });
    assert.deepEqual(await files.list(join(d.root, 'fan')), ['fan-1-2']);
    const st = await files.stat(name);
    assert.equal(st.file, true);
    assert.equal(st.dir, false);
    assert.ok(Math.abs(st.mtimeMs - Date.now()) < 60000);
    assert.equal((await files.stat(join(d.root, 'fan'))).dir, true);
    await files.unlink(name);
    assert.deepEqual(readdirSync(join(d.root, 'fan')), []);
    await assert.rejects(files.stat(name), { code: 'ENOENT' });
  } finally { await files.close(); d.done(); }
});

test('readJson: the file parsed; nothing for a folder, a file over the limit, a broken or missing one', async () => {
  const d = dir();
  const files = createFanFiles();
  try {
    const file = join(d.root, 'fan.json');
    writeFileSync(file, JSON.stringify({ at: 5, data: { v: 1 } }));
    assert.deepEqual(await files.readJson(file), { at: 5, data: { v: 1 } });
    assert.equal(await files.readJson(join(d.root, 'fan')), null, 'a folder');
    writeFileSync(file, JSON.stringify({ at: 5, pad: ' '.repeat(MAX_FILE_BYTES) }));
    assert.equal(await files.readJson(file), null, 'over the limit');
    writeFileSync(file, '{ "at": ');
    assert.equal(await files.readJson(file), null, 'broken');
    assert.equal(await files.readJson(join(d.root, 'none.json')), null, 'missing');
  } finally { await files.close(); d.done(); }
});

test('a full libuv pool never holds a command', async () => {
  const d = dir();
  const files = createFanFiles();
  try {
    await files.list(join(d.root, 'fan'));
    // Every thread of the pool busy for over a second, as when the antivirus held them.
    const size = Number(process.env.UV_THREADPOOL_SIZE) || 4;
    const t = Date.now();
    await new Promise((res) => pbkdf2('x', 'y', 200000, 32, 'sha256', res));
    const iterations = Math.ceil(200000 * 1200 / Math.max(5, Date.now() - t));
    const busy = Array.from({ length: size * 2 }, () => new Promise((res) => pbkdf2('x', 'y', iterations, 32, 'sha256', res)));
    const pooled = (async () => { const s = Date.now(); await fsp.stat(d.root); return Date.now() - s; })();
    const s = Date.now();
    await files.create(join(d.root, 'fan', 'fan-1-3'));
    const command = Date.now() - s;
    const control = await pooled;
    await Promise.all(busy);
    assert.ok(control > 600, `the pool was full (a stat on it took ${control} ms)`);
    assert.ok(command < control / 2, `the command took ${command} ms, the pool ${control} ms`);
  } finally { await files.close(); d.done(); }
});

test('fan.json is read on the pool, never on the commands\' thread, so a held read holds no command', async () => {
  const d = dir();
  let made = 0;
  const files = createFanFiles({ make: () => { made += 1; return fakeThread(0)(); } });
  try {
    const file = join(d.root, 'fan.json');
    writeFileSync(file, '{"at":1}');
    assert.deepEqual(await files.readJson(file), { at: 1 });
    assert.equal(made, 0, 'no thread for a read');
  } finally { await files.close(); d.done(); }
});

test('the thread ends once nothing is asked for a while; the next call starts another', async () => {
  const made = [];
  const files = createFanFiles({ idleMs: 60, make: () => { const w = fakeThread(0)(); made.push(w); return w; } });
  try {
    await files.list('x');
    await sleep(20);
    await files.list('x');
    await sleep(20);
    assert.ok(made[0].threadId > 0, 'calls closer than the wait keep it');
    await sleep(250);
    assert.equal(made[0].threadId, -1, 'ended once idle');
    assert.deepEqual(await files.list('x'), []);
    assert.equal(made.length, 2);
  } finally { await files.close(); }
});

test('a thread busy with a call is never ended as idle', async () => {
  const made = [];
  const files = createFanFiles({ idleMs: 30, make: () => { const w = fakeThread(200)(); made.push(w); return w; } });
  try {
    await files.list('x');
    const slow = files.list('x');
    await sleep(100);
    assert.deepEqual(await Promise.race([slow, sleep(1500).then(() => 'never answered')]), []);
    assert.equal(made.length, 1);
  } finally { await files.close(); }
});

test('a thread that stops fails what it was asked, and the next call starts another', async () => {
  let made = 0;
  const make = () => (++made === 1 ? new Worker('process.exit(0)', { eval: true }) : fakeThread(0)());
  const files = createFanFiles({ make });
  try {
    await assert.rejects(files.list('x'), /stopped/);
    assert.deepEqual(await files.list('x'), []);
    assert.equal(made, 2);
  } finally { await files.close(); }
});

test('close fails what is waiting and stops the thread; a later call starts again', async () => {
  const made = [];
  const files = createFanFiles({ make: () => { const w = fakeThread(300)(); made.push(w); return w; } });
  const waiting = assert.rejects(files.list('x'), /closed/);
  await files.close();
  await waiting;
  assert.ok(made.length === 1 && made.every((w) => w.threadId === -1), 'the thread stopped');
  assert.deepEqual(await files.list('x'), []);
  await files.close();
});
