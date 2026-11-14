// What the file search does when its record of what was opened cannot be written. Stopping
// used to mark the record as saved before it wrote it and to drop a failure without a word, so
// what the disk refused was never written again. Here a folder stands where the file should
// be, which refuses the write on every system; once it is gone a second stop must write it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import { basename, join } from 'node:path';

const require = createRequire(import.meta.url);
const { createFileSearch } = require('../filesearch.js');

const NOW = Date.parse('2026-07-01T12:00:00Z');
const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'xenon-search-kept-'));

test('what was opened stays marked as not saved when stopping could not write it, and is told once', async (t) => {
  const lines = [];
  t.mock.method(console, 'warn', (...parts) => { lines.push(parts.join(' ')); });
  const dataDir = tmp();
  const usageFile = join(dataDir, 'search-usage.json');
  const real = join(dataDir, 'nota.txt');
  fs.writeFileSync(real, 'x');
  const fsr = createFileSearch({ dataDir, openExternal: async () => {} });
  fsr._setHostRunner(async () => [{ p: real, n: 'nota.txt', s: 1, m: NOW }]);
  const out = await fsr.search('nota', { now: NOW });
  assert.deepEqual(await fsr.open(out.results[0].id), { ok: true });

  fs.mkdirSync(usageFile);
  await fsr.stop();
  await fsr.stop();
  assert.equal(lines.length, 1, 'told once while it keeps failing');
  assert.match(lines[0], /^\[search\] what was opened from the search could not be saved \(E[A-Z]+\)/);
  assert.ok(!lines[0].includes(dataDir) && !lines[0].includes(basename(dataDir)), `a path in the log: ${lines[0]}`);

  fs.rmdirSync(usageFile);
  await fsr.stop();
  const usage = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
  assert.deepEqual(Object.values(usage.opens).map((o) => o.n), [1], 'the open the disk refused is written by the next stop');
});
