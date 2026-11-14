// What the disk space module remembers between calls: the summary of the last scan (read from
// disk once), the number of the cleanup, the last overview of each drive and its history (written
// on stop, shown by the next start), and the word of a running game that stops duplicates from
// being read. Every wait here is for a file or a call, never for a length of time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDiskSpace } = require('../diskspace.js');
const DiskHistory = require('../disk-history.js');

const TEMP_DIR = process.platform === 'win32' ? await fs.realpath(os.tmpdir()) : os.tmpdir();
const SUMMARY = { v: 1, at: 1700000000000, root: 'X', bytes: 1234, files: 3, dirs: 2, byCategory: { temp: { bytes: 10, count: 1 } }, dupesWasted: 0 };

async function folder(t) {
  const dir = await fs.mkdtemp(path.join(TEMP_DIR, 'xenon-disk-memory-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const dataDir = path.join(dir, 'data');
  await fs.mkdir(dataDir);
  return { dir, dataDir };
}

// Waits until the folder lists the files, then reads them. The folder is asked, not the files: on Windows a file
// that is open cannot be replaced, and a test that kept reading a store would make the write it waits for fail.
async function written(dataDir, ...names) {
  for (;;) {
    const listed = await fs.readdir(dataDir);
    if (names.every((name) => listed.includes(name))) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return Promise.all(names.map(async (name) => JSON.parse(await fs.readFile(path.join(dataDir, name), 'utf8'))));
}
// Calls collected as they come, and a wait for the n-th of them.
function collected() {
  const calls = [];
  let wake = () => {};
  const take = (value) => { calls.push(value); wake(); };
  const until = async (check) => { while (!check(calls)) await new Promise((resolve) => { wake = resolve; }); };
  return { calls, take, until };
}

function indexed(dir, dataDir, more = {}, groups = []) {
  const livingIndex = {
    available: () => true,
    stats: async () => ({ on: true, ready: true, files: 2 }),
    overview: async () => ({ total: 48, files: 2, dirs: [], topFiles: [], groups, detailFiles: [], capped: false, detailCapped: false, building: false }),
  };
  return createDiskSpace({ dataDir, helperExe: path.join(dir, 'no-helper'), appRoot: path.join(dir, 'app'), livingIndex,
    getIndexRoots: async () => [path.parse(dir).root], getSettings: async () => ({}), ...more });
}

test('the summary of the last scan is read from disk once and answers while there is no index', async (t) => {
  const { dir, dataDir } = await folder(t);
  const file = path.join(dataDir, 'disk-summary.json');
  await fs.writeFile(file, JSON.stringify(SUMMARY));
  const disk = createDiskSpace({ dataDir, helperExe: path.join(dir, 'no-helper'), appRoot: path.join(dir, 'app') });
  assert.deepEqual((await disk.status()).last, SUMMARY);
  await fs.rm(file);
  assert.deepEqual((await disk.status()).last, SUMMARY, 'the file is not read a second time');
  const told = await disk.insights();
  assert.deepEqual([told.lastScanAt, told.totalBytes, told.categories], [SUMMARY.at, 1234, SUMMARY.byCategory]);
  assert.match(told.note, /summary of the previous scan/);

  // A summary of another version is no summary.
  await fs.writeFile(file, JSON.stringify({ ...SUMMARY, v: 2 }));
  const other = createDiskSpace({ dataDir, helperExe: path.join(dir, 'no-helper'), appRoot: path.join(dir, 'app') });
  assert.equal((await other.status()).last, null);
  const none = await other.insights();
  assert.equal(none.lastScanAt, null);
  assert.match(none.note, /no scan has been run yet/);
});

test('the last overview of a drive is written on stop and shown by the next start, and a new day adds a point to its history', async (t) => {
  const { dir, dataDir } = await folder(t);
  const disk = indexed(dir, dataDir);
  assert.deepEqual(await disk.snapshot(5), { ok: false, error: 'bad_root' });
  assert.deepEqual(await disk.snapshot(0), { ok: false, error: 'no_snapshot' });
  const first = await disk.overview(0);
  assert.equal(first.ok, true);
  assert.equal(first.insights.historyDays, 1);
  const told = await disk.insights(0);
  assert.deepEqual([told.rootIndex, told.root, told.totalBytes, told.lastScanAt], [0, first.root, 48, null]);

  disk.stop(); // writes at once what it would have written five seconds later
  const [saved, history] = await written(dataDir, 'disk-snapshot.json', 'disk-history.json', 'disk-hashes.json');
  assert.deepEqual(Object.values(saved.roots).map((root) => [root.root, root.total]), [[first.root, 48]]);
  const [key] = Object.keys(history.roots);
  assert.equal(history.roots[key].length, 1);

  // The point that was saved becomes one of two days ago, and the app starts again.
  const [point] = history.roots[key];
  const before = point.at - 2 * DiskHistory.DAY_MS;
  const file = path.join(dataDir, 'disk-history.json');
  await fs.writeFile(file, JSON.stringify({ v: 1, roots: { [key]: [{ ...point, at: before, d: DiskHistory.dayKey(before) }] } }));
  const next = indexed(dir, dataDir);
  const shown = await next.snapshot(0);
  assert.deepEqual([shown.ok, shown.stale, shown.root, shown.total], [true, true, first.root, 48]);
  assert.equal((await next.overview(0)).insights.historyDays, 2);
  await fs.rm(file); // so that the folder shows when it has been written again
  next.stop();
  const [kept] = await written(dataDir, 'disk-history.json');
  assert.deepEqual(kept.roots[key].map((day) => day.d), [DiskHistory.dayKey(before), point.d]);
});

test('each cleanup gets the next number', async (t) => {
  const { dir, dataDir } = await folder(t);
  const progress = collected();
  const disk = indexed(dir, dataDir, { shellDelete: async () => ({ ok: true }), onCleanProgress: progress.take });
  const done = (id) => progress.until((calls) => calls.some((snap) => snap && snap.id === id && snap.phase === 'done'));
  assert.deepEqual(await disk.clean({ category: 'recycleBin' }), { ok: true, started: true, id: 1 });
  await done(1);
  assert.deepEqual(await disk.clean({ category: 'recycleBin' }), { ok: true, started: true, id: 2 });
  await done(2);
  assert.deepEqual(progress.calls.at(-1).report, { ok: true, emptied: true });
  assert.deepEqual([...new Set(progress.calls.map((snap) => snap.id))], [1, 2]);
});

test('while a game holds the disk no duplicate is read, and the pass goes on when it lets go', async (t) => {
  const { dir, dataDir } = await folder(t);
  const twins = [path.join(dir, 'one.bin'), path.join(dir, 'two.bin')];
  for (const file of twins) await fs.writeFile(file, Buffer.alloc(64, 7));
  const updates = collected();
  const disk = indexed(dir, dataDir, { onDiskUpdate: updates.take }, [{ s: 64, paths: twins }]);
  const told = (times) => updates.until((calls) => calls.length >= times);

  disk.hold(true);
  const held = await disk.overview(0);
  assert.deepEqual([held.dupes, held.dupesPending], [[], true]);
  await told(1); // the background pass ended without reading anything
  const still = await disk.overview(0);
  assert.deepEqual([still.dupes, still.dupesPending], [[], true]);

  disk.hold(false);
  await disk.overview(0, true);
  await told(2);
  const shown = await disk.overview(0);
  assert.equal(shown.dupesPending, false);
  assert.deepEqual(shown.dupes.map((group) => [group.s, group.wasted, group.paths.map((file) => file.p).sort()]), [[64, 64, [...twins].sort()]]);
  assert.deepEqual(updates.calls.at(-1), { root: shown.root, what: 'dupes' });

  disk.stop();
  await written(dataDir, 'disk-hashes.json');
});
