// Airflow's saved choices (server/js/airflow/airflow-model.js) and its two files on
// disk (server/airflow/store.js): anything read or sent becomes a valid model, a
// broken file never stops Airflow from starting (switched off), and what the brain
// learned is kept apart from the person's choices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Model = require('../js/airflow/airflow-model.js');
const L = require('../airflow/limits.js');
const { createAirflowStore, FILE, LEARNED_FILE, LEARNED_MAX_BYTES, LAST_FILE, LAST_MAX_BYTES } = require('../airflow/store.js');
const { createSaves, LAST_EVERY_MS, SAVE_EVERY_MS } = require('../airflow/loop-save.js');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-airflow-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('model: a fresh install is switched off, automatic, halfway, calls quiet', () => {
  const m = Model.normalize(undefined);
  assert.deepEqual(m, {
    v: 1, drive: 'off', mode: 'auto', slider: 50,
    options: { night: { on: false, from: 23, to: 7 }, callQuiet: true, allowZero: false, linkHub: false, riseAlert: true },
    fans: {}, check: null,
  });
  assert.deepEqual(Model.normalize([]), m);
  assert.deepEqual(Model.normalize('on'), m);
});

test('model: the modes are the brain\'s modes', () => {
  assert.deepEqual([...Model.MODES], [...L.MODE_NAMES]);
});

test('model: values out of range fall back, never clamp into something unasked', () => {
  const m = Model.normalize({ drive: 'full', mode: 'turbo', slider: 140, options: { night: { on: 'yes', from: 24, to: -1 }, callQuiet: 0, allowZero: 'true', riseAlert: 'off' } });
  assert.equal(m.drive, 'off');
  assert.equal(m.mode, 'auto');
  assert.equal(m.slider, 50);
  assert.deepEqual(m.options, { night: { on: false, from: 23, to: 7 }, callQuiet: true, allowZero: false, linkHub: false, riseAlert: true });
  assert.equal(Model.normalize({ slider: '' }).slider, 50);
  assert.equal(Model.normalize({ slider: null }).slider, 50);
  assert.equal(Model.normalize({ slider: '30' }).slider, 30);
  assert.equal(Model.normalize({ slider: 0 }).slider, 0);
  assert.equal(Model.normalize({ options: { riseAlert: false } }).options.riseAlert, false, 'the notice switched off stays off');
});

test('model: fans keep only well-formed ids, known places and a usable check', () => {
  const m = Model.normalize({
    fans: {
      'lhm:it8689e:fan2': { place: 'top', leave: true, calib: { at: 5, maxRpm: 1500, minDuty: 20, startDuty: 10, curve: [[20, 400], [10, 300], [60, 1000], [60, 1100], ['x', 1], [100, 1500]], avoid: [[900, 800], [850, 950]] } },
      'nvidia:0:fan1': { place: 'roof', pump: true, calib: { maxRpm: 3000 } },
      'LHM:IT:FAN': {}, '../x': {}, 'a:b': {}, ['x'.repeat(13) + ':a:b']: {},
    },
  });
  assert.deepEqual(Object.keys(m.fans), ['lhm:it8689e:fan2', 'nvidia:0:fan1']);
  const top = m.fans['lhm:it8689e:fan2'];
  assert.equal(top.place, 'top');
  assert.equal(top.leave, true);
  assert.equal(top.calib.startDuty, 20, 'a fan never starts below its minimum');
  assert.deepEqual(top.calib.curve, [[20, 400], [60, 1000], [100, 1500]]);
  assert.deepEqual(top.calib.avoid, [[850, 950]]);
  const card = m.fans['nvidia:0:fan1'];
  assert.equal(card.place, 'case');
  assert.equal(card.pump, true);
  assert.equal(card.calib, null, 'a check with no date is not trusted');
  assert.equal(Model.normalizeCalib({ at: 5, minDuty: 20 }), null, 'nor one that never measured the top speed');
  assert.equal(Model.normalizeCalib({ at: 5, maxRpm: 0 }), null);
  assert.equal(Model.normalizeCalib({ at: 5, maxRpm: 900, handBack: true }).handBack, true, 'seen back with the PC');
  assert.equal(Model.normalizeCalib({ at: 5, maxRpm: 900, handBack: 'yes' }).handBack, false, 'only a real yes is proof');
});

test('model: at most MAX_FANS fans are kept', () => {
  const fans = Object.fromEntries(Array.from({ length: Model.MAX_FANS + 5 }, (_, i) => [`lhm:chip:fan${i}`, {}]));
  assert.equal(Object.keys(Model.normalize({ fans }).fans).length, Model.MAX_FANS);
});

test('store: no file reads as switched off, and a change is written', async (t) => {
  const dir = tempDir(t);
  const store = createAirflowStore({ dataDir: dir });
  assert.equal((await store.ready()).drive, 'off');
  const next = await store.update((m) => ({ ...m, drive: 'shadow', slider: 20 }));
  assert.equal(next.drive, 'shadow');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
  assert.deepEqual(onDisk, next);
  const again = createAirflowStore({ dataDir: dir });
  assert.deepEqual(await again.ready(), next);
});

test('store: a broken file starts switched off and says so once', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, FILE), '{"drive":"on",');
  const warnings = [];
  const store = createAirflowStore({ dataDir: dir, warn: (w) => warnings.push(w) });
  assert.equal((await store.ready()).drive, 'off');
  assert.equal(warnings.length, 1);
});

test('store: what is written is always normalized, and null changes nothing', async (t) => {
  const dir = tempDir(t);
  const store = createAirflowStore({ dataDir: dir });
  const m = await store.update(() => ({ drive: 'on', mode: 'nope', fans: { 'bad id': {} } }));
  assert.equal(m.drive, 'on');
  assert.equal(m.mode, 'auto');
  assert.deepEqual(m.fans, {});
  const same = await store.update(() => null);
  assert.equal(same, m);
});

test('store: two changes at once both land', async (t) => {
  const dir = tempDir(t);
  const store = createAirflowStore({ dataDir: dir });
  await Promise.all([
    store.update((m) => ({ ...m, slider: 10 })),
    store.update((m) => ({ ...m, options: { ...m.options, allowZero: true } })),
  ]);
  const back = await createAirflowStore({ dataDir: dir }).ready();
  assert.equal(back.slider, 10);
  assert.equal(back.options.allowZero, true);
});

test('store: a failed write keeps the old model in memory', async (t) => {
  const dir = tempDir(t);
  const store = createAirflowStore({ dataDir: path.join(dir, 'missing', 'deeper') });
  const before = await store.ready();
  await assert.rejects(store.update((m) => ({ ...m, drive: 'on' })));
  assert.equal(store.peek(), before);
});

test('store: learning is kept apart, bounded, and can be forgotten', async (t) => {
  const dir = tempDir(t);
  const warnings = [];
  const store = createAirflowStore({ dataDir: dir, warn: (w) => warnings.push(w) });
  assert.deepEqual(await store.readLearned(), {});
  await store.saveLearned({ models: { cpu: { R: 0.3 } } });
  assert.deepEqual(await store.readLearned(), { models: { cpu: { R: 0.3 } } });
  assert.equal(fs.existsSync(path.join(dir, FILE)), false, 'learning never writes the choices');
  await assert.rejects(store.saveLearned([]), TypeError);
  await assert.rejects(store.saveLearned({ big: 'x'.repeat(LEARNED_MAX_BYTES) }), RangeError);
  fs.writeFileSync(path.join(dir, LEARNED_FILE), '[1,2]');
  assert.deepEqual(await store.readLearned(), {});
  fs.writeFileSync(path.join(dir, LEARNED_FILE), JSON.stringify({ big: 'x'.repeat(LEARNED_MAX_BYTES) }));
  assert.deepEqual(await store.readLearned(), {});
  assert.equal(warnings.length, 2);
  await store.forgetLearned();
  await store.forgetLearned();
  assert.equal(fs.existsSync(path.join(dir, LEARNED_FILE)), false);
});

test('store: the last speeds have a small file of their own; a broken one is no resume', async (t) => {
  const dir = tempDir(t);
  const warnings = [];
  const store = createAirflowStore({ dataDir: dir, warn: (w) => warnings.push(w) });
  assert.equal(await store.readLast(), null);
  assert.equal(warnings.length, 0, 'none yet is no problem');
  const last = { at: 1000, out: { 'lhm:board:control-1': 0.2 }, tookAt: { 'lhm:board:control-1': 0.6 } };
  await store.saveLast(last);
  assert.deepEqual(await store.readLast(), last);
  assert.deepEqual(await store.readLearned(), {}, 'the learning is not touched');
  await assert.rejects(store.saveLast(null), TypeError);
  await assert.rejects(store.saveLast({ big: 'x'.repeat(LAST_MAX_BYTES) }), RangeError);
  for (const text of ['{', '[1]', JSON.stringify({ big: 'x'.repeat(LAST_MAX_BYTES) })]) {
    fs.writeFileSync(path.join(dir, LAST_FILE), text);
    assert.equal(await store.readLast(), null, text.slice(0, 20));
  }
  assert.equal(warnings.length, 2, 'a file that does not parse or is too big is said; an array is just not ours');
});

test('saves: the speeds go every few seconds while driving, the learning every few minutes', async () => {
  const wrote = { last: [], learned: 0 };
  const warnings = [];
  let fail = false;
  const store = {
    async saveLast(v) { if (fail) throw Object.assign(new Error('x'), { code: 'EBUSY' }); wrote.last.push(v); },
    async saveLearned() { wrote.learned += 1; },
  };
  const saves = createSaves({ store, warn: (w) => warnings.push(w) });
  let speeds = { at: 1, out: {}, tookAt: {} };
  const st = { learned: {}, brain: { last: () => speeds, save: () => ({}), memory: () => ({}) }, health: { save: () => ({}) }, shadow: { save: () => ({}) } };
  for (let now = 0; now < SAVE_EVERY_MS; now += 1000) await saves.due(st, now);
  assert.equal(wrote.last.length, SAVE_EVERY_MS / LAST_EVERY_MS);
  assert.equal(wrote.learned, 0);
  await saves.due(st, SAVE_EVERY_MS);
  assert.equal(wrote.learned, 1);
  // Watching: nothing to resume from, nothing written.
  speeds = null;
  await saves.all(st, SAVE_EVERY_MS + 1);
  assert.equal(wrote.last.length, SAVE_EVERY_MS / LAST_EVERY_MS + 1);
  // A disk that refuses is said once, not every few seconds.
  speeds = { at: 2, out: {}, tookAt: {} };
  fail = true;
  for (let now = 0; now < 4 * LAST_EVERY_MS; now += LAST_EVERY_MS) await saves.due(st, 2 * SAVE_EVERY_MS + now);
  assert.equal(warnings.length, 1);
  fail = false;
  await saves.all(st, 3 * SAVE_EVERY_MS);
  assert.deepEqual(wrote.last.at(-1), speeds);
});

test('model: the check keeps the readings each control moves, valid ids only, no repeats', () => {
  const tachs = ['lhm:chip:fan-2', 'lhm:chip:fan-2', '../x', 5, ...Array.from({ length: 10 }, (_, i) => `lhm:chip:fan-${i + 3}`)];
  const c = Model.normalizeCalib({ at: 1, maxRpm: 1000, tachs });
  assert.equal(c.tachs.length, Model.MAX_TACHS);
  assert.deepEqual(c.tachs.slice(0, 2), ['lhm:chip:fan-2', 'lhm:chip:fan-3']);
  assert.deepEqual(Model.normalizeCalib({ at: 1, maxRpm: 1000, tachs: 'x' }).tachs, []);
  assert.equal(Model.normalizeCalib({ at: 1, hasTach: false }).maxRpm, null, 'no reading, no top speed needed');
  assert.equal(Model.normalizeCalib({ at: 1 }), null);
});

test('model: the last fan check keeps only known problems on valid fans', () => {
  const at = 1_700_000_000_000;
  const check = Model.normalize({ check: { at, problems: { 'lhm:board:control-1': 'no-start', 'lhm:board:control-2': 'boom', '../x': 'no-speed', 'lhm:board:control-3': 'pump-stopped', 'lhm:board:control-4': 'no-handback' } } }).check;
  assert.deepEqual(check, { at, problems: { 'lhm:board:control-1': 'no-start', 'lhm:board:control-3': 'pump-stopped', 'lhm:board:control-4': 'no-handback' } });
  assert.equal(Model.normalize({ check: { problems: {} } }).check, null, 'no time, no check');
  assert.deepEqual(Model.normalize({ check: { at, problems: 'x' } }).check, { at, problems: {} });
});
