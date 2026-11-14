// The queue every change to the settings file goes through, loaded on its own:
// server/settings/write-lock.js and what it requires, never server.js. The queue used to get
// its first value from a line of server.js, so the lock threw for whoever used it before
// that file had run.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { settingsStore } = require('../settings/store-state.js');
const { withHubSettingsLock } = require('../settings/write-lock.js');

const turn = () => new Promise((resolve) => setImmediate(resolve));

test('the lock is loaded without server.js', () => {
  const engine = path.join('server', 'server.js');
  assert.deepEqual(Object.keys(require.cache).filter((file) => file.endsWith(engine)), []);
});

test('the queue has its first value where it is declared', async () => {
  assert.equal(typeof settingsStore.writeChain?.then, 'function');
  assert.equal(await settingsStore.writeChain, undefined);
});

test('one change finishes before the next begins, in the order they were asked', async () => {
  const seen = [];
  const slow = withHubSettingsLock(async () => {
    seen.push('first begins');
    await turn();
    await turn();
    seen.push('first ends');
    return 'first';
  });
  const quick = withHubSettingsLock(() => { seen.push('second'); return 'second'; });
  assert.deepEqual(await Promise.all([slow, quick]), ['first', 'second']);
  assert.deepEqual(seen, ['first begins', 'first ends', 'second']);
});

test('a change that fails is told to who asked for it and does not hold up the one after it', async () => {
  const failed = withHubSettingsLock(() => { throw new Error('the disk is full'); });
  const next = withHubSettingsLock(() => 'written');
  await assert.rejects(failed, /the disk is full/);
  assert.equal(await next, 'written');
  // What the queue itself holds never rejects, so no later change is refused for an old failure.
  assert.equal(await settingsStore.writeChain, undefined);
});
