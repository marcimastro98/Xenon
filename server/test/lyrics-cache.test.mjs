// Lyrics cache: bounded LRU, expiry, what reaches disk, re-validation on load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createLyricsCache, MAX_ENTRIES, MISS_TTL_MS, TRANSIENT_TTL_MS } = require('../lyrics-cache.js');

const SYNCED = { state: 'synced', lines: [{ t: 0, text: 'made-up line' }], matchId: 3 };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-lyrics-'));
}

test('stores and returns an entry', async () => {
  const c = createLyricsCache({});
  await c.set('a|b|200', SYNCED);
  const got = await c.get('a|b|200');
  assert.equal(got.state, 'synced');
  assert.deepEqual(got.lines, SYNCED.lines);
});

test('evicts the least recently used past the cap', async () => {
  const c = createLyricsCache({});
  for (let i = 0; i < MAX_ENTRIES; i++) await c.set('k' + i, { state: 'none' });
  await c.get('k0');                       // touch: k1 is now the oldest
  await c.set('extra', { state: 'none' });
  assert.ok(await c.get('k0'));
  assert.equal(await c.get('k1'), null);
});

test('misses expire after a week, transients after minutes, lyrics never', async () => {
  let t = 1_000_000;
  const c = createLyricsCache({ now: () => t });
  await c.set('miss', { state: 'none' });
  await c.set('err', { state: 'error' });
  await c.set('hit', SYNCED);
  t += TRANSIENT_TTL_MS;
  assert.equal(await c.get('err'), null);
  assert.ok(await c.get('miss'));
  t += MISS_TTL_MS;
  assert.equal(await c.get('miss'), null);
  assert.ok(await c.get('hit'));
});

test('a busy entry honours its own until', async () => {
  let t = 1_000;
  const c = createLyricsCache({ now: () => t });
  await c.set('busy', { state: 'busy' }, { until: t + 30_000 });
  t += 29_000;
  assert.ok(await c.get('busy'));
  t += 2_000;
  assert.equal(await c.get('busy'), null);
});

test('only durable states are written, and the file reloads', async () => {
  const dir = tmpDir();
  const c = createLyricsCache({ dataDir: dir, debounceMs: 60_000 });
  await c.set('hit', SYNCED);
  await c.set('err', { state: 'error' });
  await c.flush();
  c.stop();
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'lyrics-cache.json'), 'utf8'));
  assert.deepEqual(disk.entries.map(e => e[0]), ['hit']);
  const again = createLyricsCache({ dataDir: dir });
  assert.equal((await again.get('hit')).state, 'synced');
});

test('a dirty file is re-validated entry by entry', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'lyrics-cache.json'), JSON.stringify({ entries: [
    ['ok', { state: 'plain', plain: ['a', 3, 'b'], at: Date.now(), extra: 'dropped' }],
    ['bad-state', { state: 'weird', at: Date.now() }],
    ['no-lines', { state: 'synced', lines: [], at: Date.now() }],
    ['bad-line', { state: 'synced', lines: [{ t: -1, text: 'x' }, { t: 5, text: 'y' }], at: Date.now() }],
    ['transient', { state: 'error', at: Date.now() }],
    [42, { state: 'none', at: Date.now() }],
  ] }));
  const c = createLyricsCache({ dataDir: dir });
  const ok = await c.get('ok');
  assert.deepEqual(ok.plain, ['a', 'b']);
  assert.equal('extra' in ok, false);
  assert.equal(await c.get('bad-state'), null);
  assert.equal(await c.get('no-lines'), null);
  assert.deepEqual((await c.get('bad-line')).lines, [{ t: 5, text: 'y' }]);
  assert.equal(await c.get('transient'), null);
});

test('a corrupt file starts empty', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'lyrics-cache.json'), '{not json');
  const c = createLyricsCache({ dataDir: dir });
  assert.equal(await c.get('anything'), null);
});
