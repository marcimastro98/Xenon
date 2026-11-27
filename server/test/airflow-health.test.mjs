// Airflow's health (server/airflow/health.js): a fan slower than its check, dust
// read off the learned models day by day, and what a cleaning bought.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const H = require('../airflow/health.js');

const CURVE = [[20, 400], [100, 1600]];
const day = (i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
// A model whose rise over ambient at the reference is `rise` degrees.
const model = (rise, confidence = 0.9) => ({
  ids: ['a', 'b'],
  confidence: () => confidence,
  steady: (_mix, P, Ta) => Ta + rise * (P / H.REF.power.cpu),
});

function runFan(health, { id = 'a', duty = 60, rpm, seconds, from = 0 }) {
  for (let s = 0; s <= seconds; s += 1) health.observeFan({ id, duty, rpm, curve: CURVE, now: from + s * 1000 });
}

test('wear: a fan turning as checked is fine', () => {
  const h = H.createHealth();
  runFan(h, { rpm: 1000, seconds: 3600 });
  assert.deepEqual(h.report().slow, []);
});

test('wear: a fan well under its checked speed is reported, once there is enough of it', () => {
  const h = H.createHealth();
  runFan(h, { rpm: 750, seconds: 200 });
  assert.deepEqual(h.report().slow, [], 'a few minutes are not enough');
  runFan(h, { rpm: 750, seconds: 3600, from: 201000 });
  const [slow] = h.report().slow;
  assert.equal(slow.id, 'a');
  assert.ok(Math.abs(slow.ratio - 0.75) < 0.01, String(slow.ratio));
});

test('wear: only settled readings count; a moving duty or a stopped fan never does', () => {
  const h = H.createHealth();
  for (let s = 0; s < 4000; s += 1) h.observeFan({ id: 'a', duty: 40 + (s % 20), rpm: 300, curve: CURVE, now: s * 1000 });
  runFan(h, { id: 'b', rpm: 0, seconds: 4000 });
  assert.deepEqual(h.save().wear, {});
  runFan(h, { id: 'c', rpm: 750, seconds: (H.STEADY_MS / 1000) - 1 });
  assert.deepEqual(h.save().wear, {});
});

test('wear: a checked-again fan starts over', () => {
  const h = H.createHealth();
  runFan(h, { rpm: 700, seconds: 4000 });
  h.forgetFan('a');
  assert.deepEqual(h.report().slow, []);
});

test('dust: warmer than its best weeks on each recent day', () => {
  const h = H.createHealth();
  const days = H.BASELINE_DAYS + 30;
  for (let i = 0; i < days; i += 1) h.daily({ day: day(i), models: { cpu: model(i < days - 5 ? 20 : 24) } });
  const { dust } = h.report();
  assert.equal(dust.cpu.dusty, true);
  assert.ok(Math.abs(dust.cpu.warmer - 0.2) < 1e-9);
  assert.equal(dust.gpu, null);
});

test('dust: one warm day is not dust, and too little history says nothing', () => {
  const h = H.createHealth();
  for (let i = 0; i < H.BASELINE_DAYS + 10; i += 1) h.daily({ day: day(i), models: { cpu: model(i === H.BASELINE_DAYS + 8 ? 30 : 20) } });
  assert.equal(h.report().dust.cpu.dusty, false);
  const fresh = H.createHealth();
  for (let i = 0; i < H.BASELINE_DAYS; i += 1) fresh.daily({ day: day(i), models: { cpu: model(20) } });
  assert.equal(fresh.report().dust.cpu, null);
});

test('dust: an unsure model, a repeated day or a bad date is not recorded', () => {
  const h = H.createHealth();
  h.daily({ day: day(0), models: { cpu: model(20, 0.2) } });
  h.daily({ day: 'yesterday', models: { cpu: model(20) } });
  h.daily({ day: day(1), models: { cpu: model(20) } });
  h.daily({ day: day(1), models: { cpu: model(40) } });
  assert.deepEqual(h.save().history, [{ day: day(1), cpu: 20, gpu: null }]);
});

test('cleaning: says what it bought, and dust counts again from that day', () => {
  const h = H.createHealth();
  for (let i = 0; i < 40; i += 1) h.daily({ day: day(i), models: { cpu: model(i < 30 ? 20 + i * 0.2 : 19) } });
  h.cleanedOn(day(38));
  assert.equal(h.report().gain.cpu, null, 'not enough days after yet');
  for (let i = 40; i < 44; i += 1) h.daily({ day: day(i), models: { cpu: model(19) } });
  const r = h.report();
  assert.equal(r.cleaned, day(38));
  assert.equal(r.gain.cpu, 0, 'nothing changed across this cleaning');
  assert.equal(r.dust.cpu, null, 'too few days since the cleaning');
  h.cleanedOn('not a day');
  assert.equal(h.report().cleaned, day(38));
});

test('cleaning: the gain is the drop at the reference', () => {
  const h = H.createHealth();
  for (let i = 0; i < 10; i += 1) h.daily({ day: day(i), models: { cpu: model(26) } });
  h.cleanedOn(day(9));
  for (let i = 10; i < 13; i += 1) h.daily({ day: day(i), models: { cpu: model(21) } });
  assert.equal(h.report().gain.cpu, 5);
});

test('saved health comes back; broken parts are dropped', () => {
  const h = H.createHealth();
  runFan(h, { rpm: 750, seconds: 1000 });
  h.daily({ day: day(0), models: { cpu: model(20) } });
  h.cleanedOn(day(0));
  h.newPart('gpu', day(0));
  const copy = H.createHealth({ saved: JSON.parse(JSON.stringify(h.save())) });
  assert.deepEqual(copy.save(), h.save());
  const broken = H.createHealth({ saved: { wear: { a: { ratio: -1, n: 3 }, b: { ratio: 1, n: 1.5 }, c: { ratio: 0.9, n: 9 } }, history: [{ day: 'x' }, { day: day(0), cpu: 'hot' }, { day: day(1), cpu: 20 }], cleaned: 5, parts: { cpu: 'today', gpu: 3, fan: day(0) } } });
  const none = { cpu: null, gpu: null };
  assert.deepEqual(broken.save(), { wear: { c: { ratio: 0.9, n: 9 } }, history: [{ day: day(1), cpu: 20 }], cleaned: null, parts: none });
  assert.deepEqual(H.createHealth({ saved: null }).save(), { wear: {}, history: [], cleaned: null, parts: none });
});

test('swap: a fan far from its check, reading after reading, is another fan; wear and a day off are not', () => {
  const h = H.createHealth();
  // A third faster than checked: past SWAP_OFF, once the duty has settled.
  runFan(h, { id: 'a', rpm: 1400, seconds: 30 + H.SWAP_READINGS - 2 });
  assert.deepEqual(h.swapped(), [], 'not yet enough readings');
  runFan(h, { id: 'a', rpm: 1400, seconds: 5, from: (31 + H.SWAP_READINGS) * 1000 });
  assert.deepEqual(h.swapped(), ['a']);
  h.forgetFan('a');
  assert.deepEqual(h.swapped(), [], 'checked again: forgotten');
  // A fan a fifth slow (wear) never reads as another fan, however long.
  const worn = H.createHealth();
  runFan(worn, { id: 'b', rpm: 800, seconds: 3600 });
  assert.deepEqual(worn.swapped(), []);
  // One reading in line in between starts the count again.
  const mixed = H.createHealth();
  runFan(mixed, { id: 'c', rpm: 600, seconds: 30 + H.SWAP_READINGS - 5 });
  mixed.observeFan({ id: 'c', duty: 60, rpm: 1000, curve: CURVE, now: (31 + H.SWAP_READINGS) * 1000 });
  runFan(mixed, { id: 'c', rpm: 600, seconds: H.SWAP_READINGS - 5, from: (32 + H.SWAP_READINGS) * 1000 });
  assert.deepEqual(mixed.swapped(), []);
});

test('a new part: only its dust history starts again, and the day is told', () => {
  const h = H.createHealth();
  for (let i = 0; i < 20; i += 1) h.daily({ day: day(i), models: { cpu: model(20), gpu: model(30) } });
  h.newPart('gpu', day(20));
  h.newPart('fan', day(20));
  h.newPart('cpu', 'today');
  const r = h.report();
  assert.deepEqual(r.parts, { cpu: null, gpu: day(20) });
  const saved = h.save();
  assert.ok(saved.history.every((d) => d.gpu === null), 'the old card says nothing about the new one');
  assert.equal(saved.history.filter((d) => d.cpu === 20).length, 20, 'the processor keeps its history');
  assert.ok(!('fan' in saved.parts));
});
