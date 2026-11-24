// Airflow's list of fans (server/airflow/inventory.js): what the drivers found,
// joined with the person's choices and the fan check, as the channels the brain and
// the safety layer share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildInventory, fanId, depsFor, rpmAt } = require('../airflow/inventory.js');

const calib = (extra = {}) => ({ at: 1, maxRpm: 1500, minDuty: 20, startDuty: 30, curve: [[20, 450], [60, 1000], [100, 1500]], ...extra });
const found = (id, extra = {}) => ({ id, name: 'Fan #1', labelKey: 'mb|Fan #1', source: 'mb', controllable: true, rpm: 800, duty: 40, ...extra });

test('ids: built from a driver\'s own names, lower case and safe', () => {
  assert.equal(fanId('LHM', 'ITE IT8689E', 'Fan #2'), 'lhm:ite-it8689e:fan-2');
  assert.equal(fanId('nvidia', 0, 'fan1'), 'nvidia:0:fan1');
  assert.equal(fanId('lhm', '../..', 'x'), null, 'no dots: ids end up in file names');
  assert.equal(fanId('lhm', 'a.b', 'x'), 'lhm:a-b:x');
  assert.equal(fanId('lhm', '', 'x'), null);
  assert.equal(fanId('', 'chip', 'x'), null);
});

test('deps: what each place cools', () => {
  assert.deepEqual(depsFor('radiator'), ['cpu', 'liquid']);
  assert.deepEqual(depsFor('front', 'pump'), ['cpu', 'liquid']);
  assert.deepEqual(depsFor('gpu'), ['gpu', 'gpuMem']);
  assert.deepEqual(depsFor('front'), ['cpu', 'gpu']);
});

test('rpmAt: linear between measured points, flat past the ends', () => {
  const c = calib().curve;
  assert.equal(rpmAt(c, 10), 450);
  assert.equal(rpmAt(c, 40), 725);
  assert.equal(rpmAt(c, 100), 1500);
  assert.equal(rpmAt([], 50), null);
});

test('a checked fan is driven with what the check measured', () => {
  const model = { fans: { 'lhm:chip:fan1': { place: 'front', calib: calib({ zeroOk: true, avoid: [[850, 950]] }) } } };
  const [ch] = buildInventory({ found: [found('lhm:chip:fan1')], model, labels: { 'mb|Fan #1': 'Front intake' } });
  assert.equal(ch.controllable, true);
  assert.equal(ch.why, null);
  assert.equal(ch.name, 'Front intake');
  assert.equal(ch.named, true);
  assert.equal(buildInventory({ found: [found('lhm:chip:fan1')], model, labels: {} })[0].named, false);
  assert.equal(ch.place, 'front');
  assert.equal(ch.kind, 'fan');
  assert.equal(ch.maxRpm, 1500);
  assert.equal(ch.minFrac, 450 / 1500);
  assert.deepEqual(ch.avoid, [[850, 950]]);
  assert.equal(ch.zeroOk, true);
  assert.deepEqual(ch.deps, ['cpu', 'gpu']);
  assert.equal(ch.rpm, 800);
});

test('every reason a seen fan is left to the PC', () => {
  const cases = [
    [found('lhm:chip:a', { controllable: false }), { calib: calib() }, 'readonly'],
    [found('lhm:chip:b'), { leave: true, calib: calib() }, 'leave'],
    [found('lhm:chip:c'), {}, 'unchecked'],
    [found('lhm:chip:d'), { calib: calib({ threePin: true }) }, 'three-pin'],
    [found('lhm:chip:e'), { calib: calib({ hasTach: false }) }, 'blind'],
    [found('lhm:chip:f', { beta: true }), { calib: calib() }, 'unproven'],
  ];
  const model = { fans: Object.fromEntries(cases.map(([f, prefs]) => [f.id, prefs])) };
  const list = buildInventory({ found: cases.map(([f]) => f), model });
  assert.deepEqual(list.map((c) => [c.controllable, c.why]), cases.map(([, , why]) => [false, why]));
});

test('a card fan may stop although its check never saw it stop: the card stops it', () => {
  const model = { fans: { 'lhm:gpu:g1': { place: 'gpu', calib: calib({ zeroOk: false }) }, 'lhm:chip:f1': { calib: calib({ zeroOk: false }) } } };
  const list = buildInventory({ found: [found('lhm:gpu:g1', { zeroByDefault: true }), found('lhm:chip:f1')], model });
  assert.deepEqual(list.map((c) => c.zeroOk), [true, false]);
});

test('pumps: by the driver, by name or by the person; never stopped', () => {
  const model = { fans: { 'lhm:chip:p3': { pump: true, calib: calib({ zeroOk: true }) } } };
  const list = buildInventory({
    found: [
      found('hub:link:p1', { kind: 'pump', source: 'hub' }),
      found('lhm:chip:p2', { name: 'AIO_PUMP' }),
      found('lhm:chip:p3', { zeroByDefault: true }),
    ],
    model,
  });
  assert.deepEqual(list.map((c) => c.kind), ['pump', 'pump', 'pump']);
  assert.deepEqual(list.map((c) => c.zeroOk || c.zeroByDefault), [false, false, false]);
  assert.deepEqual(list[2].deps, ['cpu', 'liquid']);
});

test('a header the person named a pump in the Fans widget is a pump, never stopped', () => {
  const list = buildInventory({
    found: [found('lhm:chip:c1', { name: 'Fan Control #1', labelKey: 'k1' }), found('lhm:chip:c2', { name: 'Fan Control #2', labelKey: 'k2' })],
    model: { fans: {} }, labels: { k1: 'AIO pump', k2: 'Front' },
  });
  assert.deepEqual(list.map((c) => [c.name, c.kind]), [['AIO pump', 'pump'], ['Front', 'fan']]);
  assert.equal(list[0].zeroOk, false);
});

test('why a pump is one: the device, its name, or only the person, who alone can take it back', () => {
  const list = buildInventory({
    found: [
      found('hub:link:p1', { kind: 'pump', source: 'hub' }),
      found('lhm:chip:p2', { name: 'AIO_PUMP' }),
      found('lhm:chip:p3', { name: 'Fan #2', labelKey: 'k3' }),
      found('lhm:chip:p4', { name: 'Fan #3', labelKey: 'k4' }),
      found('lhm:chip:f5'),
    ],
    // A header called pump stays one even when its mark was taken off.
    model: { fans: { 'lhm:chip:p3': { pump: false }, 'lhm:chip:p4': { pump: true } } },
    labels: { k3: 'pump', k4: 'Radiator' },
  });
  assert.deepEqual(list.map((c) => [c.kind, c.pumpBy]), [['pump', 'device'], ['pump', 'device'], ['pump', 'name'], ['pump', 'person'], ['fan', null]]);
});

test('a fan nobody placed yet: the card\'s own, a CPU header, or the case', () => {
  const list = buildInventory({
    found: [found('nvidia:0:fan1', { source: 'gpu', name: 'GPU Fan 1', zeroByDefault: true }), found('lhm:chip:cpu', { name: 'CPU Fan' }), found('lhm:chip:f3', { name: 'Fan #3' })],
    model: {},
  });
  assert.deepEqual(list.map((c) => c.place), ['gpu', 'cpu', 'case']);
  assert.equal(list[0].zeroByDefault, true);
  assert.deepEqual(list[0].deps, ['gpu', 'gpuMem']);
  assert.equal(list[0].hasTach, true, 'a speed reading counts before any check');
});

test("a driver's own place guess wins over the name, an unknown one is ignored, the person's choice over both", () => {
  const list = buildInventory({
    found: [found('link:hub:ch-13', { source: 'hub', name: 'RX RGB fan', place: 'radiator' }), found('link:hub:ch-14', { source: 'hub', name: 'CPU fan', place: 'attic' }), found('link:hub:ch-15', { source: 'hub', name: 'RX RGB fan', place: 'radiator' })],
    model: { fans: { 'link:hub:ch-15': { place: 'top' } } },
  });
  assert.deepEqual(list.map((c) => c.place), ['radiator', 'cpu', 'top']);
  assert.deepEqual(list[0].deps, ['cpu', 'liquid'], 'a radiator fan follows the liquid');
});

test('broken or repeated driver entries are dropped, the order kept', () => {
  const list = buildInventory({
    found: [found('lhm:chip:b'), null, { ...found('BAD ID') }, found('lhm:chip:a'), found('lhm:chip:b'), { ...found('lhm:chip:c'), name: 5 }],
    model: { fans: 'nope' },
  });
  assert.deepEqual(list.map((c) => c.id), ['lhm:chip:b', 'lhm:chip:a']);
  assert.deepEqual(buildInventory({ found: 'x', model: null }), []);
});

test('a curve without points still gives a floor from the minimum duty', () => {
  const model = { fans: { 'lhm:chip:a': { calib: calib({ curve: [] }) } } };
  const [ch] = buildInventory({ found: [found('lhm:chip:a')], model });
  assert.equal(ch.minFrac, 0.2);
});

test('speed: the slowest reading the check paired, the same-header guess before a check', () => {
  const tachs = { 'lhm:chip:fan-1': 900, 'lhm:chip:fan-3': 0, 'lhm:chip:fan-4': 1200 };
  const model = { fans: {
    'lhm:chip:a': { calib: calib({ tachs: ['lhm:chip:fan-4', 'lhm:chip:fan-1'] }) },
    'lhm:chip:b': { calib: calib({ tachs: ['lhm:chip:fan-1', 'lhm:chip:fan-3'] }) },
    'lhm:chip:c': { calib: calib({ tachs: ['lhm:chip:fan-1', 'lhm:chip:fan-9'] }) },
    'lhm:chip:e': { calib: calib({ tachs: ['lhm:chip:fan-8', 'lhm:chip:fan-9'] }) },
  } };
  const list = buildInventory({ found: ['a', 'b', 'c', 'd', 'e'].map((x) => found(`lhm:chip:${x}`)), model, tachs });
  assert.deepEqual(list.map((c) => c.rpm), [900, 0, 900, 800, null], 'one stopped fan behind a hub reads as stopped; a lost reading leaves the others; none left is unknown');
});

test('a control Xenon never tried is driven only once the check saw it go back to the PC', () => {
  const model = { fans: { 'lhm:chip:a': { calib: calib({ handBack: true }) }, 'lhm:chip:b': { calib: calib({ handBack: true }) } } };
  const [proven, plain] = buildInventory({ found: [found('lhm:chip:a', { beta: true }), found('lhm:chip:b')], model });
  assert.deepEqual([proven.controllable, proven.why, proven.beta], [true, null, true]);
  assert.equal(plain.beta, false);
});

test('a fan without a speed reading is saved by the check, and never driven', () => {
  const blind = { at: 3, hasTach: false, maxRpm: 1500, tachs: ['lhm:chip:fan-1'], minDuty: 20 };
  const model = { fans: { 'lhm:chip:a': { calib: blind } } };
  const [ch] = buildInventory({ found: [found('lhm:chip:a')], model });
  assert.equal(ch.why, 'blind');
  assert.equal(ch.maxRpm, null);
  assert.equal(ch.minFrac, null);
});
