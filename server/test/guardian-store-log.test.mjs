// What the sensor history says when it cannot be written. It used to log the error's message
// at every try, and that message holds the path of the file, which is under the user's folder.
// Here a folder stands where the file should be, which refuses the write on every system.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import { basename, join } from 'node:path';

const require = createRequire(import.meta.url);
const { makeStore } = require('../sensor-history/guardian-store.js');

test('a history the disk refused is told once, by name and error code, with no path; persist still answers false', async (t) => {
  const lines = [];
  for (const level of ['warn', 'error', 'log']) {
    t.mock.method(console, level, (...parts) => { lines.push(parts.join(' ')); });
  }
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'xenon-history-log-'));
  const FILE = join(dir, 'guardian.json');
  const state = { store: null, usageDirty: false };
  const store = makeStore({ FILE, state });
  await store.load();

  fs.mkdirSync(FILE);
  assert.equal(await store.persist(), false);
  assert.equal(await store.persist(), false, 'the caller tries again later by this answer');
  assert.equal(lines.length, 1, 'told once while it keeps failing');
  assert.match(lines[0], /^\[history\] the sensor history could not be saved \(E[A-Z]+\)/);
  assert.ok(!lines[0].includes(dir) && !lines[0].includes(basename(dir)), `a path in the log: ${lines[0]}`);

  fs.rmdirSync(FILE);
  assert.equal(await store.persist(), true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(FILE, 'utf8'))).sort(), ['apps', 'days', 'hours', 'recent']);
});
