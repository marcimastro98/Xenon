// Anonymous feature counts (server/usage-stats.js → the hub's POST /usage).
// What is counted, that nothing happens while the setting is off, the once-a-day
// send, what survives a failed send, the file on disk, and that every id is one
// the hub accepts (the hub drops every other id without a word).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { readFileSync } from './browser-source.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const usage = require('../usage-stats.js');
const { HUB_BASE } = require('../supporter-redeem.js');
const { createRegistry } = require('../actions/registry.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '..', rel), 'utf8');
const HUB = process.env.HUB_REPO || path.resolve(here, '..', '..', '..', 'xenon-supporter-hub');
const HUB_FEATURES = path.join(HUB, 'src', 'usage-features.js');
const HUB_USAGE = path.join(HUB, 'src', 'feature-usage.js');

let calls;
let responder;
let on;
let dir;
beforeEach(() => {
  usage._reset();
  calls = [];
  responder = () => ({ ok: true });
  usage._setTransport(async (url, body) => { calls.push({ url, body }); return responder(url, body); });
  on = true;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-usage-'));
  usage.configure({ dataDir: dir, enabled: () => on });
});

const file = () => path.join(dir, usage.STATE_BASENAME);

test('off: nothing is counted, nothing written, nothing sent', async () => {
  on = false;
  assert.equal(usage.record('cap.screenshot'), false);
  await usage.flush();
  assert.equal(fs.existsSync(file()), false);
  assert.deepEqual(await usage.maybeSend({ enabled: false, supporter: false }), { ok: false, skipped: 'disabled' });
  assert.equal(calls.length, 0);
});

test('only known id shapes are counted, never anything else', () => {
  for (const bad of ['screenshot', 'cap.', 'cap.a/b', 'cap.' + 'x'.repeat(41), 'layer.place.moon', 'C:\\Users\\me', '']) {
    assert.equal(usage.record(bad), false, bad);
  }
  assert.deepEqual(usage._snapshot(), {});
});

test('the registry counts each capability run by type, failures included, without changing the result', async () => {
  const results = [{ ok: true }, { ok: false, error: 'no_game' }, null];
  const reg = createRegistry({
    runCapability: async () => results.shift(),
    countCapability: (a, r) => usage.recordCapability(a, r),
  });
  assert.deepEqual(await reg.run({ type: 'perfStats' }), { ok: true });
  assert.deepEqual(await reg.run({ type: 'perfStats' }), { ok: false, error: 'no_game' });
  assert.deepEqual(await reg.run({ type: 'perfStats' }), { ok: false, error: 'capability_failed' });
  assert.deepEqual(usage._snapshot(), { 'cap.perfStats': { n: 3, err: 2 } });

  const throwing = createRegistry({ runCapability: async () => ({ ok: true }), countCapability: () => { throw new Error('x'); } });
  assert.deepEqual(await throwing.run({ type: 'perfStats' }), { ok: true }, 'a broken counter never fails the action');
});

test('a placed layer widget also counts by where it went', () => {
  usage.recordCapability({ type: 'layerPlace', widget: 'My private notes' }, { ok: true, placed: { surface: 'overlay', widget: 'notes' } });
  usage.recordCapability({ type: 'layerPlace' }, { ok: true, placed: { surface: 'desktop' } });
  usage.recordCapability({ type: 'layerPlace' }, { ok: false, error: 'unknown_widget' });
  // Attached to an app: neither surface the hub counts, so only the run itself.
  usage.recordCapability({ type: 'layerPlace' }, { ok: true, placed: { surface: 'anchor' } });
  assert.deepEqual(usage._snapshot(), {
    'cap.layerPlace': { n: 4, err: 1 },
    'layer.place.overlay': { n: 1, err: 0 },
    'layer.place.desktop': { n: 1, err: 0 },
  });
});

test('counts are kept on disk as one small aggregate and read back after a restart', async () => {
  usage.record('cap.screenshot');
  usage.record('cap.screenshot', true);
  await usage.flush();
  const saved = JSON.parse(readFileSync(file(), 'utf8'));
  assert.deepEqual(saved, { v: 1, sent: '', counts: { 'cap.screenshot': { n: 2, err: 1 } } });

  usage._reset();
  usage.configure({ dataDir: dir, enabled: () => true });
  usage.record('cap.screenshot');
  await usage.maybeSend({ enabled: true, supporter: false, day: '2026-10-30' });
  assert.deepEqual(calls[0].body.events, [{ f: 'cap.screenshot', n: 3, err: 1, person: true }]);
});

test('a broken or foreign state file costs only the bad entries', () => {
  const st = usage.parseState({ sent: 'yesterday', counts: { 'cap.ok': { n: 2, err: 9 }, 'evil/../x': { n: 1 }, 'cap.neg': { n: -4 }, 'cap.big': { n: 1e9 } } });
  assert.equal(st.sent, '');
  assert.deepEqual([...st.counts], [['cap.ok', { n: 2, err: 2 }], ['cap.big', { n: usage.MAX_COUNT, err: 0 }]]);
  assert.equal(usage.parseState(null).counts.size, 0);
  assert.equal(usage.parseState([1, 2]).counts.size, 0);
});

test('once per UTC day: one report to the hub, then nothing until tomorrow', async () => {
  usage.record('cap.screenshot');
  usage.record('cap.record', true);
  const out = await usage.maybeSend({ enabled: true, supporter: true, day: '2026-10-30' });
  assert.deepEqual(out, { ok: true, sent: 2 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, HUB_BASE + '/usage');
  assert.deepEqual(calls[0].body, {
    surface: 'app',
    tier: 'supporter',
    events: [{ f: 'cap.screenshot', n: 1, person: true }, { f: 'cap.record', n: 1, err: 1, person: true }],
  });
  assert.deepEqual(usage._snapshot(), {}, 'what the hub took is gone');

  usage.record('cap.screenshot');
  assert.deepEqual(await usage.maybeSend({ enabled: true, supporter: true, day: '2026-10-30' }), { ok: false, skipped: 'already_sent' });
  await usage.maybeSend({ enabled: true, supporter: false, day: '2026-10-31' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.tier, 'free');
});

test('a failed send keeps the counts, and the day is spent before the request', async () => {
  responder = () => ({ ok: false });
  usage.record('cap.gallery');
  assert.deepEqual(await usage.maybeSend({ enabled: true, supporter: false, day: '2026-10-30' }), { ok: false, error: 'network' });
  assert.deepEqual(usage._snapshot(), { 'cap.gallery': { n: 1, err: 0 } });
  assert.equal(JSON.parse(readFileSync(file(), 'utf8')).sent, '2026-10-30');
  assert.deepEqual(await usage.maybeSend({ enabled: true, supporter: false, day: '2026-10-30' }), { ok: false, skipped: 'already_sent' });
  assert.equal(calls.length, 1, 'no retry storm');
});

test('what the hub took is off the disk at once, so a restart never sends it twice', async () => {
  usage.record('cap.screenshot');
  await usage.maybeSend({ enabled: true, supporter: false, day: '2026-10-30' });
  // No flush: an update restart right after the check.
  assert.deepEqual(JSON.parse(readFileSync(file(), 'utf8')), { v: 1, sent: '2026-10-30', counts: {} });
  usage._reset();
  usage.configure({ dataDir: dir, enabled: () => true });
  await usage.maybeSend({ enabled: true, supporter: false, day: '2026-10-31' });
  assert.equal(calls.length, 1, 'nothing left to send the next day');
});

test('switched off while sending: the rest stays unsent and no file comes back', async () => {
  // Ids are letters only: 'cap.ta', 'cap.tb', ... one more than a batch holds.
  const letters = (i) => String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26));
  for (let i = 0; i <= usage.MAX_EVENTS; i++) assert.equal(usage.record('cap.t' + letters(i)), true);
  responder = () => { on = false; return { ok: true }; };
  const sending = usage.maybeSend({ enabled: true, supporter: false, day: '2026-10-30' });
  await sending;
  await usage.clear();
  assert.equal(calls.length, 1, 'stopped after the batch in flight');
  assert.equal(fs.existsSync(file()), false);
});

test('a big day goes out in batches the hub takes', () => {
  const counts = new Map(CAPABILITIES.map((c) => ['cap.' + c.type, { n: 1000, err: 0 }]));
  counts.set('layer.place.desktop', { n: 1, err: 0 });
  counts.set('layer.place.overlay', { n: 1, err: 0 });
  const batches = usage.buildBatches(counts, 'free');
  assert.ok(batches.every((b) => b.events.length <= usage.MAX_EVENTS));
  assert.equal(batches.reduce((n, b) => n + b.events.length, 0), counts.size);
});

test('switching it off deletes what was waiting', async () => {
  usage.record('cap.screenshot');
  await usage.flush();
  assert.equal(fs.existsSync(file()), true);
  await usage.clear();
  assert.equal(fs.existsSync(file()), false);
  assert.deepEqual(usage._snapshot(), {});
});

test('the server and client wire the setting the strict way, local to the PC', () => {
  const SERVER = engineSource();
  const CLIENT = read('js/settings.js');
  const INDEX = read('index.html');
  // On for a fresh install, an existing one stays off until its owner chooses.
  assert.match(SERVER, /^\s*usageStats: true,/m);
  assert.match(SERVER, /usageStats: source\.usageStats === true/);
  assert.match(CLIENT, /^\s*usageStats: true,/m);
  assert.match(CLIENT, /usageStats: value\.usageStats === true/);
  // A paired device's save keeps the stored value.
  assert.match(SERVER, /if \(isRemote\) incoming\.usageStats = !!\(prev && prev\.usageStats === true\);/);
  // So does a backup it posts: /backup/import is open to a paired device.
  assert.match(SERVER, /applyBackup\(JSON\.parse\(raw \|\| '\{\}'\), \{ remote: isRemote \}\)/);
  assert.match(SERVER, /if \(remote\) incoming\.usageStats = !!\(prev && prev\.usageStats === true\);/);
  // Rides the update check; the tier is a boolean, never the code.
  assert.match(SERVER, /usageStats\.maybeSend\(\{ enabled: true, supporter: !!\(st && st\.saved\) \}\)/);
  assert.match(SERVER, /countCapability: \(action, result\) => usageStats\.recordCapability\(action, result\)/);
  assert.match(SERVER, /usageStats\.clear\(\)/);
  assert.match(INDEX, /id="settings-usage-stats"[^>]*onchange="updateUsageStats\(this\.checked\)"/);
  assert.match(INDEX, /privacy\.html#usage-counts/);
  assert.match(CLIENT, /'settings-usage-stats-row', 'settings-usage-stats-link'/);
});

test('every app id is one the hub accepts', { skip: !fs.existsSync(HUB_FEATURES) && 'hub checkout not found' }, async () => {
  const hub = await import(pathToFileURL(HUB_FEATURES).href);
  const mine = [...CAPABILITIES.map((c) => 'cap.' + c.type), 'layer.place.desktop', 'layer.place.overlay'].sort();
  assert.deepEqual(mine, [...hub.USAGE_FEATURES.app].sort());

  const { normalizeBatch } = await import(pathToFileURL(HUB_USAGE).href);
  const counts = new Map(mine.map((f) => [f, { n: 3, err: 1 }]));
  for (const b of usage.buildBatches(counts, 'supporter')) {
    const n = normalizeBatch(JSON.parse(JSON.stringify(b)));
    assert.equal(n.error, undefined);
    assert.equal(n.rows.length, b.events.length, 'the hub keeps every event');
  }
});
