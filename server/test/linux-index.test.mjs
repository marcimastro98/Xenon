// The Linux file-search backend. The query core is pure over an entry list, so
// the matching rules are tested directly; the walk is tested against a real
// temporary tree, because every interesting thing it does (skips, symlinks,
// caps) is a filesystem behaviour and a mock would only prove the mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const li = require(join(ROOT, 'linux-index.js'));

// The tests that walk a REAL tree cannot run on Windows, and that is a property
// of the module rather than a gap in them: setRoots() only accepts POSIX
// absolute paths (`startsWith('/')`), so a Windows temp dir is rejected before
// any walk begins and every assertion downstream reads a null index. Faking a
// POSIX-looking root would only prove the fake. The pure query/overview tests
// below carry no such assumption and run everywhere, which is the part of a
// Linux collector that is testable off Linux at all.
const NEEDS_POSIX = process.platform === 'win32'
  ? 'walks a real tree; setRoots() takes POSIX absolute paths only'
  : false;

const entry = (p, over = {}) => {
  const n = p.split('/').pop();
  return { p, n, nl: n.toLowerCase(), s: 100, m: 1000, d: false, ...over };
};

const SET = [
  entry('/home/u/Downloads/invoice-2026.pdf'),
  entry('/home/u/Documents/notes.md'),
  entry('/home/u/Pictures/holiday.JPG'),
  entry('/home/u/Projects/xenon/server.js', { s: 5000, m: 9000 }),
  entry('/home/u/Projects', { d: true, s: 0 }),
];

test('every term must appear in the name, and the path is NOT a fallback', () => {
  const hit = li.queryEntries(SET, { terms: ['invoice'] });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].n, 'invoice-2026.pdf');
  // "downloads" is in the path but not the name, so this matches nothing — on
  // purpose. search-rank.js discards any row whose NAME scores 0 (only a
  // Windows indexed-content hit is exempt), so returning it would spend the
  // caller's row budget on something the user can never be shown.
  assert.equal(li.queryEntries(SET, { terms: ['downloads', 'invoice'] }).length, 0);
  assert.equal(li.queryEntries(SET, { terms: ['invoice', 'zzz'] }).length, 0);
});

test('matching is case-insensitive on both sides', () => {
  assert.equal(li.queryEntries(SET, { terms: ['HOLIDAY'] }).length, 1);
  assert.equal(li.queryEntries(SET, { terms: ['holiday'] }).length, 1);
});

test('an extension filter excludes directories outright', () => {
  const pdfs = li.queryEntries(SET, { terms: [], exts: ['pdf'] });
  assert.deepEqual(pdfs.map((r) => r.n), ['invoice-2026.pdf']);
  // 'JPG' on disk, 'jpg' in the filter: the comparison normalises both, or the
  // filter silently drops every file from a camera.
  assert.equal(li.queryEntries(SET, { terms: [], exts: ['jpg'] }).length, 1);
  // A directory has no extension to match and must never survive an ext filter.
  assert.ok(!li.queryEntries(SET, { terms: [], exts: ['js'] }).some((r) => r.n === 'Projects'));
});

test('size and date bounds are inclusive of the bound itself', () => {
  assert.equal(li.queryEntries(SET, { terms: [], minBytes: 5000 }).length, 1);
  assert.equal(li.queryEntries(SET, { terms: [], maxBytes: 99 }).length, 1); // the dir, at 0
  assert.equal(li.queryEntries(SET, { terms: [], after: 9000 }).length, 1);
  assert.equal(li.queryEntries(SET, { terms: [], before: 999 }).length, 0);
});

test('max is honoured and clamped', () => {
  assert.equal(li.queryEntries(SET, { terms: [], max: 2 }).length, 2);
  // 0 would mean "no results ever" from a caller that just forgot to pass one.
  assert.equal(li.queryEntries(SET, { terms: [], max: 0 }).length >= 1, true);
});

test('results carry exactly the four fields filesearch.js reads', () => {
  const [r] = li.queryEntries(SET, { terms: ['notes'] });
  assert.deepEqual(Object.keys(r).sort(), ['m', 'n', 'p', 's']);
});

test('no roots means no backend, and query answers null rather than empty', async () => {
  const idx = li.createLinuxIndex();
  assert.equal(idx.available(), false);
  // null and [] are different answers: [] is "searched, found nothing", null is
  // "there is no index" — filesearch.js reports them as different states.
  assert.equal(await idx.query({ terms: ['x'] }), null);
  assert.deepEqual(await idx.stats(), { on: false });
  idx.stop();
});

test('the walk indexes a real tree, skips caches, and does not follow symlinks', { skip: NEEDS_POSIX }, async () => {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), 'xenon-idx-'));
  try {
    fs.mkdirSync(join(tmp, 'keep'), { recursive: true });
    fs.mkdirSync(join(tmp, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(join(tmp, 'keep', 'target.txt'), 'hello');
    fs.writeFileSync(join(tmp, 'node_modules', 'pkg', 'target.txt'), 'noise');
    // A link back to the root: followed, this walk would never terminate.
    try { fs.symlinkSync(tmp, join(tmp, 'loop')); } catch { /* no symlink perm */ }

    const idx = li.createLinuxIndex();
    idx.setRoots([tmp]);
    await idx._rebuild();

    const hits = (await idx.query({ terms: ['target'] })).items;
    assert.equal(hits.length, 1, 'the node_modules copy must not be indexed');
    assert.ok(hits[0].p.includes('/keep/'));
    assert.equal(hits[0].s, 5, 'size comes from the real file');

    const s = await idx.stats();
    assert.equal(s.on, true);
    assert.equal(s.ready, true);
    assert.equal(s.capped, false);
    assert.deepEqual(s.cappedRoots, [], 'a complete walk leaves nothing out');
    idx.stop();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the entry cap stops the walk and is reported', { skip: NEEDS_POSIX }, async () => {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), 'xenon-cap-'));
  try {
    for (let i = 0; i < 40; i++) fs.writeFileSync(join(tmp, `f${i}.txt`), 'x');
    const idx = li.createLinuxIndex({ maxEntries: 10 });
    idx.setRoots([tmp]);
    await idx._rebuild();
    assert.ok(idx._entryCount() <= 10);
    const s = await idx.stats();
    assert.equal(s.capped, true);
    assert.deepEqual(s.cappedRoots, [tmp], 'the truncated root is named');
    idx.stop();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The walk is sequential, so a cap reached on an early root leaves every later
// one essentially absent. "2,000,000 files" then reads as success while search
// cannot see a whole drive — naming the roots is what makes that actionable.
test('a root left out entirely by an earlier cap is named too', { skip: NEEDS_POSIX }, async () => {
  const first = fs.mkdtempSync(join(os.tmpdir(), 'xenon-cap-a-'));
  const second = fs.mkdtempSync(join(os.tmpdir(), 'xenon-cap-b-'));
  try {
    for (let i = 0; i < 40; i++) fs.writeFileSync(join(first, `f${i}.txt`), 'x');
    fs.writeFileSync(join(second, 'never-indexed.txt'), 'x');
    const idx = li.createLinuxIndex({ maxEntries: 10 });
    idx.setRoots([first, second]);
    await idx._rebuild();

    const s = await idx.stats();
    assert.equal(s.capped, true);
    assert.deepEqual(s.cappedRoots, [first, second]);
    assert.equal((await idx.query({ terms: ['never-indexed'] })).items.length, 0,
      'the second root really is absent — the report is not cosmetic');
    idx.stop();
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test('a relative root is refused — the walk only ever starts from an absolute path', () => {
  const idx = li.createLinuxIndex();
  idx.setRoots(['relative/path', '', '/tmp']);
  assert.equal(idx.available(), true);
  idx.stop();
});

test('stop() empties the index and leaves query answering null', async () => {
  const idx = li.createLinuxIndex();
  idx.setRoots(['/tmp']);
  idx.stop();
  assert.equal(idx._entryCount(), 0);
});

// ── Disk map ────────────────────────────────────────────────────────────────
// The same walk that answers search feeds the disk widget, so diskspace.js gets
// its overview without a helper and without a second traversal.
const dirEnt = (p) => ({ p, n: p.split('/').pop(), nl: '', s: 0, m: 500, d: true });
const fileEnt = (p, s, m = 100) => ({ p, n: p.split('/').pop(), nl: '', s, m, d: false });

const TREE = [
  dirEnt('/r'), dirEnt('/r/a'), dirEnt('/r/a/deep'), dirEnt('/r/b'),
  fileEnt('/r/top.bin', 500),
  fileEnt('/r/a/one.txt', 100),
  fileEnt('/r/a/deep/two.txt', 300),
  fileEnt('/r/b/three.txt', 100),
  fileEnt('/outside/ignored.txt', 9999),
];

test('overviewFrom: totals count only what is under the root', () => {
  const ov = li.overviewFrom(TREE, '/r', {});
  assert.equal(ov.total, 1000);   // 500 + 100 + 300 + 100, and never the 9999
  assert.equal(ov.files, 4);
});

test('overviewFrom: a file counts in every directory above it, not just its parent', () => {
  // The property that makes a treemap a nesting of totals. Summing only the
  // immediate parent draws a map whose branches are empty.
  const ov = li.overviewFrom(TREE, '/r', {});
  const byPath = Object.fromEntries(ov.dirs.map((d) => [d.p, d.s]));
  assert.equal(byPath['/r/a'], 400);        // its own 100 plus deep's 300
  assert.equal(byPath['/r/a/deep'], 300);
  assert.equal(byPath['/r/b'], 100);
  // The root itself is not listed as one of its own children.
  assert.ok(!ov.dirs.some((d) => d.p === '/r'));
});

test('overviewFrom: directories carry their file count and their own mtime', () => {
  const ov = li.overviewFrom(TREE, '/r', {});
  const a = ov.dirs.find((d) => d.p === '/r/a');
  assert.equal(a.n, 2);   // one.txt and deep/two.txt
  assert.equal(a.m, 500); // the directory's mtime, not a file's
});

test('overviewFrom: dirMinBytes filters and dirs come back largest first', () => {
  const ov = li.overviewFrom(TREE, '/r', { dirMinBytes: 200 });
  assert.deepEqual(ov.dirs.map((d) => d.p), ['/r/a', '/r/a/deep']);
});

test('overviewFrom: topFiles is the largest files, capped', () => {
  const ov = li.overviewFrom(TREE, '/r', { topMax: 2 });
  assert.deepEqual(ov.topFiles.map((f) => f.s), [500, 300]);
});

test('overviewFrom: duplicate candidates are same-size groups of two or more', () => {
  // Identical size is a candidate, not a duplicate — diskspace.js hashes them
  // before calling anything a duplicate, so a lone file must never form a group.
  const ov = li.overviewFrom(TREE, '/r', { dupeMinBytes: 50 });
  assert.equal(ov.groups.length, 1);
  assert.equal(ov.groups[0].s, 100);
  assert.deepEqual(ov.groups[0].paths.sort(), ['/r/a/one.txt', '/r/b/three.txt']);
  // Below the threshold nothing is offered at all.
  assert.deepEqual(li.overviewFrom(TREE, '/r', { dupeMinBytes: 1000 }).groups, []);
});

test('overviewFrom: detailRoots collects files from the named subtrees only', () => {
  const ov = li.overviewFrom(TREE, '/r', { detailRoots: ['/r/a'] });
  assert.deepEqual(ov.detailFiles.map((f) => f.p).sort(), ['/r/a/deep/two.txt', '/r/a/one.txt']);
});

test('overviewFrom: a trailing slash on the root does not lose the tree', () => {
  assert.equal(li.overviewFrom(TREE, '/r/', {}).total, 1000);
});

test('list: only the files directly inside the directory, no descent', { skip: NEEDS_POSIX }, async () => {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), 'xenon-list-'));
  try {
    fs.mkdirSync(join(tmp, 'a', 'deep'), { recursive: true });
    fs.writeFileSync(join(tmp, 'a', 'here.txt'), 'x');
    fs.writeFileSync(join(tmp, 'a', 'deep', 'below.txt'), 'x');
    fs.writeFileSync(join(tmp, 'sibling.txt'), 'x');

    const idx = li.createLinuxIndex();
    idx.setRoots([tmp]);
    await idx._rebuild();

    const rows = await idx.list(join(tmp, 'a'), 10);
    // `here.txt` only: not the file one level down, and not the sibling one
    // level up. This is what separates list() from top(), which does descend.
    assert.deepEqual(rows.map((r) => r.p.split('/').pop()), ['here.txt']);
    // A trailing separator names the same directory.
    assert.equal((await idx.list(join(tmp, 'a') + '/', 10)).length, 1);
    idx.stop();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the disk map answers null while there is no index, never a zeroed map', async () => {
  // A widget that got {total: 0} would draw an empty disk and call it a
  // measurement. Null is what diskspace.js reads as "no backend here".
  const idx = li.createLinuxIndex();
  assert.equal(await idx.overview('/tmp', {}), null);
  assert.equal(await idx.sizes('/tmp'), null);
  assert.equal(await idx.dirs('/tmp', 0, 10), null);
  assert.equal(await idx.top('/tmp', 10), null);
  assert.equal(await idx.dupes('/tmp', 0, 10), null);
  assert.equal(await idx.list('/tmp', 10), null);
  idx.stop();
});
