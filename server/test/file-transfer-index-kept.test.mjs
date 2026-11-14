// What the transfer store does when its list of files cannot be written. On Windows the atomic
// write gives up when another program holds the file open for more than about a second
// (atomic-write.js). The store used to drop that failure without a word; the file just received
// was then on disk with no line in the list, and the next start deletes every file the list
// does not hold. Here a folder stands where the list should be, which refuses the write on
// every system; once it is gone the list must reach the disk at the next sweep, with nothing
// new received.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import { basename, join } from 'node:path';

const require = createRequire(import.meta.url);
const FT = require('../file-transfer.js');

const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'xenon-xfer-kept-'));

function seqRand() {
  let n = 0;
  return () => (n++).toString(16).padStart(16, '0');
}

// Every line the code under test logs, kept instead of printed.
function listen(t) {
  const lines = [];
  t.mock.method(console, 'warn', (...parts) => { lines.push(parts.join(' ')); });
  return lines;
}

async function land(store, name, bytes) {
  const began = store.begin({ name, declaredLength: bytes.length });
  assert.ok(!began.error, `begin refused: ${began.error}`);
  fs.writeFileSync(began.target, bytes);
  return store.commit(began.id, bytes.length);
}

// A second store on the same folder: what a restart finds.
async function afterRestart(dir) {
  const store = FT.createFileTransfer({ dir, rand: seqRand() });
  await store.init();
  return store;
}

test('a list the disk refused is written at the next sweep, and the file is still there after a restart', async (t) => {
  const lines = listen(t);
  const dir = tmp();
  const indexFile = join(dir, 'index.json');
  const store = FT.createFileTransfer({ dir, rand: seqRand() });
  await store.init();

  fs.mkdirSync(indexFile);
  const rec = await land(store, 'photo.jpg', Buffer.from('picture'));
  assert.ok(rec, 'the file is taken even when the list cannot be written');
  assert.equal(store.list().length, 1);
  assert.equal(lines.length, 1, 'told once');
  assert.match(lines[0], /^\[transfer\] the list of files could not be saved \(E[A-Z]+\)/);
  assert.ok(!lines[0].includes(dir) && !lines[0].includes(basename(dir)), `a path in the log: ${lines[0]}`);

  await store.sweepInflight();
  assert.equal(lines.length, 1, 'still failing: not told again');

  fs.rmdirSync(indexFile);
  await store.sweepInflight();
  assert.equal(JSON.parse(fs.readFileSync(indexFile, 'utf8')).records.length, 1, 'the sweep wrote the list nothing else was going to write');

  const next = await afterRestart(dir);
  const names = next.list().map((r) => r.name);
  assert.deepEqual(names, ['photo.jpg']);
  assert.equal(fs.readFileSync(next.absOf(rec), 'utf8'), 'picture', 'the file itself is still on disk');
});

test('a sweep with nothing unsaved writes nothing', async () => {
  const dir = tmp();
  const store = FT.createFileTransfer({ dir, rand: seqRand() });
  await store.init();
  await store.sweepInflight();
  assert.equal(fs.existsSync(join(dir, 'index.json')), false);
});
