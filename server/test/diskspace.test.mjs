import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDiskSpace } = require('../diskspace.js');

async function fixture(shellDelete, makeDirs) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xenon-disk-test-'));
  const dataDir = path.join(dir, 'data');
  const itemDir = path.join(dir, 'items');
  await fs.mkdir(dataDir);
  await fs.mkdir(itemDir);
  const good = path.join(itemDir, 'good.tmp');
  const locked = path.join(itemDir, 'locked.tmp');
  await fs.writeFile(good, Buffer.alloc(32));
  await fs.writeFile(locked, Buffer.alloc(16));
  let combinedCalls = 0;
  const livingIndex = {
    available: () => true,
    stats: async () => ({ on: true, ready: true, files: 2 }),
    overview: async () => {
      combinedCalls++;
      return {
        total: 48,
        files: 2,
        dirs: makeDirs ? makeDirs(dir) : [],
        topFiles: [],
        groups: [],
        detailFiles: [
          { p: good, n: path.basename(good), s: 32, m: Date.now() },
          { p: locked, n: path.basename(locked), s: 16, m: Date.now() },
        ],
        capped: false,
        detailCapped: true,
        building: false,
      };
    },
    browse: async () => ({
      total: 48,
      files: 2,
      directBytes: 48,
      children: [],
      directFiles: [
        { p: good, n: path.basename(good), s: 32, m: Date.now() },
        { p: locked, n: path.basename(locked), s: 16, m: Date.now() },
      ],
    }),
  };
  const drive = path.parse(dir).root.slice(0, 2).toUpperCase();
  // Cleanup is a background job now; capture progress and resolve on 'done' so
  // tests can await a full run without reaching into internals.
  const progress = [];
  let doneResolve = null;
  const done = new Promise((r) => { doneResolve = r; });
  const disk = createDiskSpace({
    dataDir,
    helperExe: process.execPath,
    livingIndex,
    getIndexRoots: async () => [path.parse(dir).root],
    getDriveDetails: async () => ({
      [drive]: {
        label: 'Xenon Test',
        model: 'Test NVMe',
        fileSystem: 'NTFS',
        driveType: 'Fixed',
      },
    }),
    getSettings: async () => ({}),
    appRoot: path.join(dir, 'app'),
    shellDelete,
    onCleanProgress: (snap) => {
      progress.push(snap);
      if (snap && snap.phase === 'done') doneResolve(snap);
    },
  });
  // Await the final report of a category cleanup (the job runs off the caller).
  async function cleanAndWait(body) {
    const started = await disk.clean(body);
    if (!started || !started.started) return started;   // rejected before the job
    const snap = await done;
    return snap.report;
  }
  return { dir, good, locked, disk, progress, cleanAndWait, combinedCalls: () => combinedCalls };
}

test('disk overview uses one combined living-index snapshot and reports volume metadata', async (t) => {
  const f = await fixture();
  t.after(async () => fs.rm(f.dir, { recursive: true, force: true }));

  const out = await f.disk.overview(0);
  assert.equal(out.ok, true);
  assert.equal(f.combinedCalls(), 1);
  assert.equal(out.total, 48);
  assert.equal(out.categories.temp.count, 2);
  assert.equal(out.categories.temp.listedBytes, 48);
  assert.equal(Number.isFinite(out.volume.capacity), true);
  assert.equal(out.index.capped, false);
  assert.equal(out.index.detailCapped, true);
});

test('a classified child dir never double-counts against its classified parent', async (t) => {
  // Neither the scan stream nor the Living Index returns dirs in path order,
  // and the "skip a dir whose classified ancestor is already an item" rule only
  // works if the parent is seen first. Emitted child-first, both became items:
  // the category counted the same bytes twice and offered two overlapping rows
  // for one folder. The cache/Cache_Data pair is the real-world shape (both
  // match the browser-cache segment).
  const now = Date.now();
  const f = await fixture(undefined, (dir) => {
    const parent = path.join(dir, 'cache');
    return [
      { p: path.join(parent, 'Cache_Data'), s: 10, m: now },   // child FIRST
      { p: parent, s: 30, m: now },
    ];
  });
  t.after(async () => fs.rm(f.dir, { recursive: true, force: true }));

  const out = await f.disk.overview(0);
  // The parent dir plus the two detail files — not the child as well.
  assert.equal(out.categories.temp.count, 3);
  assert.equal(out.categories.temp.listedBytes, 78);
  const dirItems = out.categories.temp.items.filter((it) => it.kind === 'dir');
  assert.equal(dirItems.length, 1);
  assert.equal(dirItems[0].p, path.join(f.dir, 'cache'));
});

test('the %TEMP% folder itself is never an item — its children are', async (t) => {
  // Offering the temp ROOT as one item could never work and would have been
  // wrong if it had: a single file held open by any running app makes
  // SHFileOperation refuse the whole folder (the category reported the same
  // size after every attempt, with nothing moved), and Windows plus every
  // running app resolve %TEMP% from the environment, so recycling the folder
  // is a real breakage. The children are the items, so a locked one refuses
  // alone.
  const now = Date.now();
  const f = await fixture(undefined, (dir) => [
    { p: os.tmpdir(), s: 9_000_000, m: now },              // the container
    { p: path.join(dir, 'session-cache'), s: 40, m: now }, // a child of it
  ]);
  t.after(async () => fs.rm(f.dir, { recursive: true, force: true }));

  const out = await f.disk.overview(0);
  const items = out.categories.temp.items;
  assert.equal(items.some((it) => it.p.toLowerCase() === os.tmpdir().toLowerCase()), false,
    'the container must not be offered for deletion');
  assert.equal(items.some((it) => it.p === path.join(f.dir, 'session-cache')), true,
    'a child of the container must still be offered');
  // The two detail files under the fixture dir plus the child directory.
  assert.equal(out.categories.temp.count, 3);
});

test('disk status exposes bounded display metadata and browse accepts opaque ids only', async (t) => {
  const f = await fixture();
  t.after(async () => fs.rm(f.dir, { recursive: true, force: true }));

  const status = await f.disk.status();
  assert.equal(status.roots[0].label, 'Xenon Test');
  assert.equal(status.roots[0].model, 'Test NVMe');
  assert.equal(status.roots[0].fileSystem, 'NTFS');

  const overview = await f.disk.overview(0);
  assert.match(overview.rootId, /^n[a-z0-9]+$/);
  const drill = await f.disk.browse(0, overview.rootId);
  assert.equal(drill.ok, true);
  assert.equal(drill.directFiles.length, 2);
  assert.equal(drill.directBytes, 48);
  assert.equal((await f.disk.browse(0, f.dir)).error, 'bad_node');
});

test('cleanup isolates a locked item and reports honest partial success', async (t) => {
  let lockedPath = '';
  const f = await fixture(async ({ paths }) => {
    if (paths.includes(lockedPath)) return { ok: false };
    for (const item of paths) await fs.unlink(item).catch(() => {});
    return { ok: true };
  });
  lockedPath = f.locked;
  t.after(async () => fs.rm(f.dir, { recursive: true, force: true }));

  const overview = await f.disk.overview(0);
  const ids = overview.categories.temp.items.map((item) => item.i);
  const out = await f.cleanAndWait({ root: 0, category: 'temp', ids });

  assert.equal(out.ok, true);
  assert.equal(out.partial, true);
  assert.equal(out.deleted, 1);
  assert.equal(out.freedBytes, 32);
  assert.equal(out.refused.length, 1);
  assert.equal(out.refused[0].path, f.locked);
  await assert.rejects(fs.stat(f.good));
  assert.equal((await fs.stat(f.locked)).isFile(), true);
  // The job streamed progress and a running snapshot was observable.
  assert.equal(f.progress.some((s) => s && s.running && s.phase === 'processing'), true);
  assert.equal(f.progress[f.progress.length - 1].phase, 'done');
});

test('an in-use container is opened up: children recycle, the locked one stays', async (t) => {
  // One open file inside a folder refuses the whole folder (recycling a dir is
  // a single rename), which was the "2 GB cache never moves" bug. The job must
  // descend: recycle the children individually, keep only the locked one, and
  // report the freed bytes as a partial SUCCESS, not delete_failed.
  const now = Date.now();
  let container = '';
  let lockedChild = '';
  const f = await fixture(async ({ paths }) => {
    if (!paths) return { ok: false };
    // The container itself and the locked child refuse with an in-use rc;
    // everything else really unlinks (recursively, like the shell would).
    if (paths.some((p) => p.toLowerCase() === container.toLowerCase())) return { ok: false, rc: 120 };
    if (paths.some((p) => p.toLowerCase() === lockedChild.toLowerCase())) return { ok: false, rc: 32 };
    for (const item of paths) await fs.rm(item, { recursive: true, force: true }).catch(() => {});
    return { ok: true };
  }, (dir) => [{ p: path.join(dir, 'pkg-cache'), s: 300, m: now }]);
  container = path.join(f.dir, 'pkg-cache');
  lockedChild = path.join(container, 'locked.log');
  await fs.mkdir(container, { recursive: true });
  await fs.mkdir(path.join(container, 'sub'), { recursive: true });
  await fs.writeFile(path.join(container, 'sub', 'data.bin'), Buffer.alloc(200));
  await fs.writeFile(path.join(container, 'movable.tmp'), Buffer.alloc(80));
  await fs.writeFile(lockedChild, Buffer.alloc(20));
  t.after(async () => fs.rm(f.dir, { recursive: true, force: true }));

  const overview = await f.disk.overview(0);
  const item = overview.categories.temp.items.find((it) => it.p === container);
  assert.ok(item, 'the container classifies as an item');
  const out = await f.cleanAndWait({ root: 0, category: 'temp', ids: [item.i] });

  assert.equal(out.ok, true, 'partial clear is a success');
  assert.equal(out.partial, true);
  // 300 declared minus the 20 still locked on disk = 280 freed.
  assert.equal(out.freedBytes, 280);
  assert.equal(out.refused.some((r) => r.reason === 'partly_in_use'), true);
  assert.equal(out.refused.some((r) => r.reason === 'in_use' && r.path === lockedChild), true);
  // The locked child is still there; the movable content is gone.
  assert.equal((await fs.stat(lockedChild)).isFile(), true);
  await assert.rejects(fs.stat(path.join(container, 'movable.tmp')));
  await assert.rejects(fs.stat(path.join(container, 'sub')));
});

test('emptying the recycle bin runs as a background job too', async (t) => {
  const calls = [];
  const f = await fixture(async (payload) => { calls.push(payload); return { ok: true }; });
  t.after(async () => fs.rm(f.dir, { recursive: true, force: true }));

  const out = await f.cleanAndWait({ category: 'recycleBin' });
  assert.equal(out.ok, true);
  assert.equal(out.emptied, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].emptyRecycleBin, true);
  // The job announced itself as permanent so the widget can show the red card.
  assert.equal(f.progress.some((s) => s && s.permanent === true), true);
});

test('a second cleanup while one runs is refused as busy', async (t) => {
  // Never two shell-delete storms at once. The first job holds until we release
  // it; the second must come back { error: 'busy' } without touching anything.
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const f = await fixture(async ({ paths }) => {
    await gate;
    for (const item of paths) await fs.unlink(item).catch(() => {});
    return { ok: true };
  });
  t.after(async () => { release(); await fs.rm(f.dir, { recursive: true, force: true }); });

  const overview = await f.disk.overview(0);
  const ids = overview.categories.temp.items.map((item) => item.i);
  const first = await f.disk.clean({ root: 0, category: 'temp', ids });
  assert.equal(first.started, true);
  const second = await f.disk.clean({ root: 0, category: 'temp', ids });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'busy');
  release();
});

test('cancelling before the job finishes reports the rest as cancelled', async (t) => {
  let release = null;
  const gate = new Promise((r) => { release = r; });
  let firstBatch = true;
  const f = await fixture(async ({ paths }) => {
    if (firstBatch) { firstBatch = false; await gate; }
    for (const item of paths) await fs.unlink(item).catch(() => {});
    return { ok: true };
  });
  t.after(async () => fs.rm(f.dir, { recursive: true, force: true }));

  const overview = await f.disk.overview(0);
  const ids = overview.categories.temp.items.map((item) => item.i);
  const started = await f.disk.clean({ root: 0, category: 'temp', ids });
  assert.equal(started.started, true);
  const c = f.disk.cancelClean();
  assert.equal(c.ok, true);
  release();
  // Poll for the terminal snapshot rather than guessing a delay.
  let last = null;
  for (let i = 0; i < 100 && (!last || last.phase !== 'done'); i++) {
    await new Promise((r) => setTimeout(r, 10));
    last = f.progress[f.progress.length - 1];
  }
  assert.equal(last.phase, 'done');
  assert.equal(last.cancelled, true);
});
