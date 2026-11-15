// What the disk feature does when a store cannot be written. On Windows the atomic write gives
// up when another program holds the file open for more than about a second (atomic-write.js):
// the overviews and the history of the drives, the summary of the last scan and the cache of
// file hashes used to drop that failure without a word, and nothing tried again before the
// next change. Here a folder stands where the file should be, which refuses the write on every
// system; once it is gone the store must reach the disk without anything new happening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import { basename, join } from 'node:path';

const require = createRequire(import.meta.url);
const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'xenon-disk-unsaved-'));
const block = (file) => fs.mkdirSync(file);
const unblock = (file) => fs.rmdirSync(file);
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Every line the code under test logs, kept instead of printed.
function listen(t) {
  const lines = [];
  t.mock.method(console, 'warn', (...parts) => { lines.push(parts.join(' ')); });
  return lines;
}
// A log line names the store and the error's code, never where the file is: the path holds the
// name of the PC's user.
function assertNoPath(lines, dir) {
  for (const line of lines) {
    assert.ok(!line.includes(dir) && !line.includes(basename(dir)), `a path in the log: ${line}`);
  }
}

test('a write that fails is kept as not saved and told once; the next one that succeeds clears it', async () => {
  const { makeKeptWrite } = require('../files/kept-write.js');
  const lines = [];
  let fail = true;
  const wrote = [];
  const refused = Object.assign(new Error('EPERM: operation not permitted, rename C:/Users/someone/x.json'), { code: 'EPERM' });
  const kept = makeKeptWrite('disk', 'the test store', {
    write: async (file, text) => { if (fail) throw refused; wrote.push([file, text]); },
    log: (line) => lines.push(line),
  });
  assert.equal(kept.unsaved(), false);
  assert.equal(await kept.save('x.json', '1'), false);
  assert.equal(await kept.save('x.json', '2'), false);
  assert.equal(kept.unsaved(), true);
  assert.deepEqual(lines, ['[disk] the test store could not be saved (EPERM): kept, the next save tries again'], 'once, with the code and without the message');
  fail = false;
  assert.equal(await kept.save('x.json', '3'), true);
  assert.deepEqual([kept.unsaved(), wrote], [false, [['x.json', '3']]]);
  fail = true;
  await kept.save('x.json', '4');
  assert.equal(lines.length, 2, 'a new failure after a good save is told again');
});

test('the overviews and the history a save could not write are written at shutdown, with no timer waiting', async (t) => {
  const { makeSavedOverviews } = require('../disk-space/saved-overviews.js');
  const lines = listen(t);
  const dataDir = tmp();
  const [snapshotFile, historyFile] = [join(dataDir, 'snap.json'), join(dataDir, 'hist.json')];
  const saved = { snapshots: new Map([['d:', { root: 'D:' }]]), history: { v: 1, roots: {} }, persistTimer: null };
  const store = makeSavedOverviews({ dataDir, cmpKey: (s) => s, SNAPSHOT_FILE: 'snap.json', HISTORY_FILE: 'hist.json', saved, resolveRoot: async () => null });

  await store.flushPersist();
  assert.deepEqual(fs.readdirSync(dataDir), [], 'nothing changed and nothing failed: shutdown writes nothing');

  block(snapshotFile);
  await store.persistNow();
  await store.persistNow();
  assert.equal(lines.length, 1, 'told once while it keeps failing');
  assert.match(lines[0], /^\[disk\] the last overview of the drives could not be saved \(E[A-Z]+\)/);
  assertNoPath(lines, dataDir);
  assert.deepEqual(read(historyFile), saved.history, 'the other file is not held back by this one');

  unblock(snapshotFile);
  await store.flushPersist();
  assert.deepEqual(read(snapshotFile), { v: 1, roots: { 'd:': { root: 'D:' } } });
  fs.rmSync(snapshotFile);
  await store.flushPersist();
  assert.equal(fs.existsSync(snapshotFile), false, 'once written it is not written again for nothing');
});

test('shutdown still writes what waits for its timer', async () => {
  const { makeSavedOverviews } = require('../disk-space/saved-overviews.js');
  const dataDir = tmp();
  const saved = { snapshots: new Map(), history: { v: 1, roots: {} }, persistTimer: null };
  const store = makeSavedOverviews({ dataDir, cmpKey: (s) => s, SNAPSHOT_FILE: 'snap.json', HISTORY_FILE: 'hist.json', saved, resolveRoot: async () => null });
  store.schedulePersist();
  assert.ok(saved.persistTimer);
  await store.flushPersist();
  assert.equal(saved.persistTimer, null);
  assert.deepEqual(fs.readdirSync(dataDir).sort(), ['hist.json', 'snap.json']);
});

test('the summary of a scan a save could not write is written at shutdown as it was', async (t) => {
  const { makeScan } = require('../disk-space/scan.js');
  const lines = listen(t);
  const dataDir = tmp();
  const summaryFile = join(dataDir, 'summary.json');
  const scan = { root: 'D:', categories: { temp: { bytes: 7, count: 2, items: [] } }, progress: { bytes: 70, files: 5, dirs: 1 }, dupes: [{ wasted: 3 }] };
  const lastScan = { lastSummary: null, summaryLoaded: true };
  const made = makeScan({ summaryFile, scan, lastScan });

  await made.flushSummary();
  assert.equal(fs.existsSync(summaryFile), false, 'nothing failed: shutdown writes nothing');

  block(summaryFile);
  await made.persistSummary();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[disk\] the summary of the last scan could not be saved \(E[A-Z]+\)/);
  assertNoPath(lines, dataDir);
  const summary = lastScan.lastSummary;
  assert.deepEqual([summary.bytes, summary.byCategory, summary.dupesWasted], [70, { temp: { bytes: 7, count: 2 } }, 3], 'still shown from memory');

  unblock(summaryFile);
  scan.progress = { bytes: 0, files: 0, dirs: 0 };
  await made.flushSummary();
  assert.deepEqual(read(summaryFile), summary, 'the summary that was computed, not one made again from a scan that moved on');
});

test('the cache of file hashes says once that it could not be saved, and the next save writes it', async (t) => {
  const { createDupeVerifier } = require('../disk/disk-dupes.js');
  const lines = listen(t);
  const dataDir = tmp();
  const cacheFile = join(dataDir, 'disk-hashes.json');
  const verifier = createDupeVerifier({ dataDir });
  await verifier.cachedOnly([]);

  block(cacheFile);
  await verifier._save();
  await verifier._save();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[disk\] the cache of file hashes could not be saved \(E[A-Z]+\)/);
  assertNoPath(lines, dataDir);

  unblock(cacheFile);
  await verifier.stop();
  assert.deepEqual(read(cacheFile), { v: 1, files: {} });
});
