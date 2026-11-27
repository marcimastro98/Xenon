// The home log (server/smart-home/home-events.js): kind, place and time only, one line a minute per
// kind and place, 100 entries and 48 hours at most, read back after a restart, emptied by its
// switch, and Home Assistant doors and windows counted only when they open. Each test writes in a
// folder of its own under the system's temp folder: never the app's data folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const log = createRequire(import.meta.url)('../smart-home/home-events.js');

const NOW = Date.parse('2026-11-26T18:30:00');
const MIN = 60 * 1000;
const folder = () => mkdtempSync(join(tmpdir(), 'xenon-home-log-'));

test('a line holds the kind, the place and the time, and comes back after a restart', async () => {
  const dir = folder();
  const a = log.createHomeEvents({ dataDir: dir });
  assert.equal(await a.add({ kind: 'ring', place: 'Ingresso', pic: '/api/x' }, NOW - 5 * MIN), true);
  assert.equal(await a.add({ kind: 'person', place: 'Giardino' }, NOW - 4 * MIN), true);
  const disk = JSON.parse(readFileSync(join(dir, 'home-events.json'), 'utf8'));
  assert.deepEqual(disk.events[0], { kind: 'ring', place: 'Ingresso', at: NOW - 5 * MIN }, 'no picture path on disk');
  const b = log.createHomeEvents({ dataDir: dir });
  assert.deepEqual((await b.recent(NOW)).map((e) => e.kind), ['ring', 'person']);
});

test('one line a minute per kind and place; unknown kinds and a switched-off log keep nothing', async () => {
  const a = log.createHomeEvents({ dataDir: folder() });
  assert.equal(await a.add({ kind: 'person', place: 'Giardino' }, NOW), true);
  assert.equal(await a.add({ kind: 'person', place: 'Giardino' }, NOW + 20 * 1000), false);
  assert.equal(await a.add({ kind: 'person', place: 'Ingresso' }, NOW + 20 * 1000), true);
  assert.equal(await a.add({ kind: 'person', place: 'Giardino' }, NOW + 2 * MIN), true);
  assert.equal(await a.add({ kind: 'motion', place: 'Giardino' }, NOW + 3 * MIN), false);
  const twice = await Promise.all([a.add({ kind: 'package', place: 'Ingresso' }, NOW + 4 * MIN), a.add({ kind: 'package', place: 'Ingresso' }, NOW + 4 * MIN)]);
  assert.deepEqual(twice.sort(), [false, true], 'two detections at once make one line');
  const off = log.createHomeEvents({ dataDir: folder(), enabled: async () => false });
  assert.equal(await off.add({ kind: 'ring', place: 'Ingresso' }, NOW), false);
});

test('at most 100 lines and 48 hours; a broken file starts empty and says so', async () => {
  const dir = folder();
  const a = log.createHomeEvents({ dataDir: dir });
  for (let i = 0; i < 130; i += 1) await a.add({ kind: 'person', place: 'P' + i }, NOW - (130 - i) * MIN);
  const kept = await a.recent(NOW);
  assert.equal(kept.length, log.MAX);
  assert.equal(kept[0].place, 'P30', 'the oldest go first');
  assert.equal((await a.recent(NOW - 100 * MIN + log.KEEP_MS + 30 * 1000)).length, 99, 'past 48 hours a line is gone');
  writeFileSync(join(dir, 'home-events.json'), '{nope');
  const warned = [];
  const b = log.createHomeEvents({ dataDir: dir, warn: (m) => warned.push(m) });
  assert.deepEqual(await b.recent(NOW), []);
  assert.equal(warned.length, 1);
});

test('clean drops what is not a line of the log', () => {
  const list = [
    { kind: 'ring', place: 'x'.repeat(200), at: NOW - MIN },
    { kind: 'unlock', place: 'Porta', at: NOW },
    { kind: 'person', place: 'Giardino', at: 'yesterday' },
    { kind: 'person', place: 'Futuro', at: NOW + 10 * MIN },
    null,
  ];
  const out = log.clean(list, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].place.length, 80);
  assert.deepEqual(log.clean('nope', NOW), []);
});

test('switching the log off empties it', async () => {
  const dir = folder();
  const a = log.createHomeEvents({ dataDir: dir });
  await a.add({ kind: 'ring', place: 'Ingresso' }, NOW);
  await a.clear();
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'home-events.json'), 'utf8')).events, []);
  const empty = folder();
  await log.createHomeEvents({ dataDir: empty }).clear();
  assert.equal(existsSync(join(empty, 'home-events.json')), false, 'nothing to empty, nothing written');
});

const change = (cls, from, to, id = 'binary_sensor.back_door') => ({
  entity_id: id,
  old_state: { state: from, attributes: { device_class: cls } },
  new_state: { state: to, attributes: { device_class: cls, friendly_name: 'Back door' } },
});

test('Home Assistant: a door or window counts when it opens, nothing else', () => {
  assert.deepEqual(log.haOpened(change('door', 'off', 'on')), { place: 'Back door' });
  assert.deepEqual(log.haOpened(change('window', 'off', 'on')), { place: 'Back door' });
  assert.equal(log.haOpened(change('door', 'on', 'off')), null, 'closing is not news');
  assert.equal(log.haOpened(change('door', 'unavailable', 'on')), null, 'coming back online is not opening');
  assert.equal(log.haOpened(change('motion', 'off', 'on')), null);
  assert.equal(log.haOpened(change('door', 'off', 'on', 'light.back_door')), null);
  assert.equal(log.haOpened(null), null);
});

test('Bit reads the newest first, with the day and the local time', () => {
  const today = new Date(NOW);
  today.setHours(9, 5, 0, 0);
  const yesterday = new Date(today.getTime() - 24 * 60 * MIN);
  yesterday.setHours(22, 40);
  const out = log.forBit([{ kind: 'opened', place: 'Back door', at: yesterday.getTime() }, { kind: 'ring', place: 'Ingresso', at: today.getTime() }], NOW);
  assert.deepEqual(out, [
    { kind: 'ring', place: 'Ingresso', day: 'today', time: '09:05' },
    { kind: 'opened', place: 'Back door', day: 'yesterday', time: '22:40' },
  ]);
});
