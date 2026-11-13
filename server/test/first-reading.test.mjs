import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';
const require = createRequire(import.meta.url);
const { createFirstReading, createFactReader } = require('../first-reading.js');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const later = (value, ms) => new Promise((resolve) => { setTimeout(resolve, ms, value); });
const gate = () => { let open; const shut = new Promise((resolve) => { open = resolve; }); return { shut, open }; };

test('a page gets what is known at once while the read is out', async () => {
  const first = createFirstReading({ waitMs: 1 });
  const slow = gate();
  const answer = await first(slow.shut, async () => 'known');
  assert.deepEqual(answer, { value: 'known', partial: true });
  slow.open('full');
});

test('a read that lands in time is the answer, whole', async () => {
  const first = createFirstReading({ waitMs: 50 });
  let asked = 0;
  assert.deepEqual(await first(Promise.resolve('full'), async () => { asked++; return 'known'; }), { value: 'full', partial: false });
  await later(null, 60);
  assert.equal(asked, 1, 'the timer may still run, its answer is simply not used');
});

test('who cannot use a partial answer waits for the read', async () => {
  const first = createFirstReading({ waitMs: 1 });
  assert.deepEqual(await first(later('full', 15), null), { value: 'full', partial: false });
});

test('once a full read has landed nobody gets a partial answer again', async () => {
  const first = createFirstReading({ waitMs: 1 });
  await first(Promise.resolve('one'), null);
  assert.deepEqual(await first(later('two', 15), async () => 'known'), { value: 'two', partial: false });
});

test('a read that only lands after the early answer still closes the window', async () => {
  const first = createFirstReading({ waitMs: 1 });
  const slow = gate();
  assert.equal((await first(slow.shut, async () => 'known')).partial, true);
  slow.open('full');
  await later(null, 2);
  assert.deepEqual(await first(later('next', 15), async () => 'known'), { value: 'next', partial: false });
});

test('a failed read fails the waiter, and leaves the window open for a page', async () => {
  const first = createFirstReading({ waitMs: 1 });
  await assert.rejects(first(Promise.reject(new Error('no')), null), /no/);
  assert.equal((await first(new Promise(() => {}), async () => 'known')).partial, true);
});

test('a read that fails after the early answer rejects nothing else', async () => {
  const first = createFirstReading({ waitMs: 1 });
  const slow = new Promise((_, reject) => { setTimeout(reject, 5, new Error('late')); });
  assert.equal((await first(slow, async () => 'known')).partial, true);
  await later(null, 10);
});

test('a fact is read once and shared by whoever asks during the read', async () => {
  let reads = 0;
  const slow = gate();
  const fact = createFactReader(() => { reads++; return slow.shut; }, { retryMs: 1000 });
  const asked = [fact.get(), fact.get(), fact.get()];
  assert.equal(fact.known(), null);
  slow.open({ name: 'DDR5' });
  assert.deepEqual(await Promise.all(asked), [{ name: 'DDR5' }, { name: 'DDR5' }, { name: 'DDR5' }]);
  assert.deepEqual(await fact.get(), { name: 'DDR5' });
  assert.deepEqual(fact.known(), { name: 'DDR5' });
  assert.equal(reads, 1);
});

test('a failed read is not repeated on every call, and comes back after the pause', async () => {
  let reads = 0;
  const fact = createFactReader(async () => { reads++; if (reads === 1) throw new Error('no WMI'); return 'found'; }, { retryMs: 20 });
  assert.equal(await fact.get(), null);
  assert.equal(await fact.get(), null);
  assert.equal(await fact.get(), null);
  assert.equal(reads, 1);
  await later(null, 25);
  assert.equal(await fact.get(), 'found');
  assert.equal(reads, 2);
});

test('a read that finds nothing counts as failed', async () => {
  let reads = 0;
  const fact = createFactReader(() => { reads++; return null; }, { retryMs: 1000 });
  assert.equal(await fact.get(), null);
  assert.equal(await fact.get(), null);
  assert.equal(reads, 1);
});

test('the server: only the page route may take a partial answer, and it is marked', () => {
  const server = engineSource();
  assert.match(server, /reqPath === '\/system' && req\.method === 'GET'\) \{\n\s+try\s+\{ json\(await getSystemInfo\(\{ partialOk: true \}\)\); \}/);
  assert.equal(server.split('partialOk: true').length - 1, 1, 'everyone else reads sensors that really answered');
  assert.match(server, /if \(partial\) info\.partial = true;/);
  assert.match(server, /\{ event: 'system', read: getSystemInfo \}/, 'the feed waits, and brings the rest to the page');
});

test('the server: a partial answer asks no sensor and calls an unread choice unknown', () => {
  const server = engineSource();
  assert.match(server, /const unread = partial \? null : \[\];\n\s+const readings = !partial && Object\.keys\(sources\)\.length \? await readChosenSensors\(sources\) : unread;/);
  assert.match(server, /function knownSystemSources\(\) \{[\s\S]{0,200}getAllDisksInfo\(\{ waitForDetails: false \}\)/);
  assert.match(server, /const details = waitForDetails\n\s+\? await getDiskDetails\(\)\n\s+: joinDiskDetails\(volumeDetailsProbe\.data \|\| \{\}, diskModelsProbe\.data \|\| \{\}\);/);
});

test('the page: a detail not read yet is not called unavailable, and full beats partial', () => {
  const page = read('../js/system.js');
  assert.match(page, /\(systemAnswerPartial \? '--' : t\('disk_detail_unavailable'\)\)/);
  assert.match(page, /\(systemAnswerPartial \? '--' : t\('ram_detail_unavailable'\)\)/);
  assert.match(page, /function applySystem\(data\) \{[\s\S]{0,160}if \(data\.partial && lastSystemData && !lastSystemData\.partial\) return;\n\s+systemAnswerPartial = !!data\.partial;/);
});
