// Background duplicate verification with a hash cache (disk-dupes.js). Real
// files in a temp dir: what matters here is what gets READ, and a mock fs
// would only prove the mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { createDupeVerifier, EDGE_BYTES } = require(join(ROOT, 'disk-dupes.js'));

const SIZE = EDGE_BYTES * 4;

function fixture() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'xenon-dupes-'));
  const base = Buffer.alloc(SIZE, 7);
  const write = (name, buf) => { const p = join(dir, name); fs.writeFileSync(p, buf); return p; };
  const a = write('a.bin', base);
  const b = write('b.bin', base);
  const mid = Buffer.from(base); mid[SIZE / 2] = 9;          // same edges, different middle
  const c = write('c.bin', mid);
  const head = Buffer.from(base); head[0] = 1;               // differs in the first bytes
  const d = write('d.bin', head);
  return { dir, a, b, c, d };
}

// Counts bytes actually read through the two read paths the module uses.
function countingFs() {
  const stats = { streamed: 0, ranged: 0 };
  const proxy = {
    ...fs,
    createReadStream(p, o) {
      const s = fs.createReadStream(p, o);
      s.on('data', (ch) => { stats.streamed += ch.length; });
      return s;
    },
    promises: {
      ...fs.promises,
      stat: fs.promises.stat,
      readFile: fs.promises.readFile,
      async open(p, flags) {
        const fh = await fs.promises.open(p, flags);
        const read = fh.read.bind(fh);
        fh.read = async (...args) => { const r = await read(...args); stats.ranged += r.bytesRead; return r; };
        return fh;
      },
    },
  };
  return { fs: proxy, stats };
}

test('cachedOnly reads nothing and reports the groups still to verify', async () => {
  const f = fixture();
  try {
    const { fs: cfs, stats } = countingFs();
    const v = createDupeVerifier({ fs: cfs, dataDir: f.dir });
    const out = await v.cachedOnly([{ s: SIZE, paths: [f.a, f.b, f.c, f.d] }]);
    assert.deepEqual(out.groups, []);
    assert.equal(out.pending, 1);
    assert.equal(stats.streamed + stats.ranged, 0);
    await v.stop();
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('only content-identical files are duplicates, and differing edges are never read whole', async () => {
  const f = fixture();
  try {
    const { fs: cfs, stats } = countingFs();
    const v = createDupeVerifier({ fs: cfs, dataDir: f.dir });
    const out = await v.verify([{ s: SIZE, paths: [f.a, f.b, f.c, f.d] }]);
    assert.equal(out.groups.length, 1);
    assert.deepEqual(out.groups[0].paths.sort(), [f.a, f.b].sort());
    assert.equal(out.groups[0].wasted, SIZE);
    assert.equal(out.pending, 0);
    // d's first bytes differ, so it costs its edges only; a, b and c share
    // edges and are read whole to tell c apart.
    assert.equal(stats.ranged, 4 * EDGE_BYTES * 2);
    assert.equal(stats.streamed, 3 * SIZE);
    await v.stop();
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('a second verifier answers from the saved cache without reading, until a file changes', async () => {
  const f = fixture();
  try {
    const first = createDupeVerifier({ dataDir: f.dir });
    await first.verify([{ s: SIZE, paths: [f.a, f.b] }]);
    await first.stop();
    assert.ok(fs.existsSync(join(f.dir, 'disk-hashes.json')));

    const { fs: cfs, stats } = countingFs();
    const second = createDupeVerifier({ fs: cfs, dataDir: f.dir });
    const cached = await second.cachedOnly([{ s: SIZE, paths: [f.a, f.b] }]);
    assert.equal(cached.groups.length, 1, 'proved from the cache alone');
    assert.equal(stats.streamed + stats.ranged, 0);

    // Touch b: its record no longer applies, so the cache cannot vouch for it.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(f.b, later, later);
    const after = await second.cachedOnly([{ s: SIZE, paths: [f.a, f.b] }]);
    assert.equal(after.groups.length, 0);
    assert.equal(after.pending, 1);
    await second.stop();
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('the read budget bounds a pass and leaves the rest pending', async () => {
  const f = fixture();
  try {
    const v = createDupeVerifier({ dataDir: f.dir, passBudget: EDGE_BYTES * 2 * 2 + 1 });
    const out = await v.verify([{ s: SIZE, paths: [f.a, f.b] }]);
    assert.equal(out.groups.length, 0, 'edges fit the budget, the whole files did not');
    assert.equal(out.pending, 1);
    await v.stop();
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('a vanished or resized candidate is dropped, never guessed', async () => {
  const f = fixture();
  try {
    const v = createDupeVerifier({ dataDir: f.dir });
    fs.rmSync(f.b);
    const out = await v.verify([{ s: SIZE, paths: [f.a, f.b, join(f.dir, 'missing.bin')] }]);
    assert.deepEqual(out.groups, []);
    await v.stop();
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('a corrupt cache file is ignored', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(join(f.dir, 'disk-hashes.json'), '{nope');
    const v = createDupeVerifier({ dataDir: f.dir });
    const out = await v.verify([{ s: SIZE, paths: [f.a, f.b] }]);
    assert.equal(out.groups.length, 1);
    await v.stop();
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
