// Airflow's brain, the parts that learn and measure: the limits table
// (server/airflow/limits.js), the online estimator (brain-rls.js), the two-node
// thermal model (brain-model.js) and the sound model (brain-noise.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../airflow/limits.js');
const { createEstimator } = require('../airflow/brain-rls.js');
const { createNodeModel } = require('../airflow/brain-model.js');
const N = require('../airflow/brain-noise.js');

// Deterministic noise for the learning tests.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('limits: the CPU full temperature follows the chip family', () => {
  const cases = [
    ['AMD Ryzen 7 9700X', 95], ['AMD Ryzen 7 7800X3D', 89], ['AMD Ryzen 7 5800X3D', 90], ['AMD Ryzen 9 9950X3D', 95],
    ['AMD Ryzen 5 5600X', 90], ['Intel Core Ultra 9 285K', 105], ['Intel Core i9-14900K', 100], ['Something else', 90], ['', 90],
  ];
  for (const [name, tj] of cases) {
    assert.equal(L.tjMax(name), tj, name);
    assert.equal(L.fullAt('cpu', name), tj - 5, name);
  }
  assert.equal(L.fullAt('gpu'), L.COMPONENTS.gpu.full);
  assert.equal(L.fullAt('nothing'), null);
});

test('limits: a target never comes closer than its margin to full', () => {
  for (const name of Object.keys(L.COMPONENTS)) {
    for (const bias of [0, 0.5, 1]) {
      const t = L.targetFor(name, bias, 'Intel Core i5');
      assert.ok(t <= L.fullAt(name, 'Intel Core i5') - L.COMPONENTS[name].margin, `${name} ${bias}`);
    }
  }
  // Quiet aims warmer than cool.
  assert.ok(L.targetFor('cpu', 0, 'AMD Ryzen 7 9700X') > L.targetFor('cpu', 1, 'AMD Ryzen 7 9700X'));
  assert.equal(L.targetFor('nothing', 0.5), null);
});

test('limits: modes and the slider become one comfort bias', () => {
  assert.equal(L.biasFor('quiet'), L.MODES.quiet);
  assert.equal(L.biasFor('cool'), L.MODES.cool);
  assert.equal(L.biasFor('auto', 30), 0.3);
  assert.equal(L.biasFor(null, 250), 1);
  assert.equal(L.biasFor(null, -5), 0);
  assert.equal(L.biasFor('toString', 'x'), 0);
});

test('estimator: learns a linear law from noisy samples and grows confident', () => {
  const rng = seeded(3);
  const est = createEstimator({ theta: [1, 1], variance: [4, 4], noise: 0.01, drift: [1e-8, 1e-8] });
  assert.equal(est.confidence(), 0);
  for (let i = 0; i < 400; i += 1) {
    const phi = [rng() * 2, rng() * 2];
    est.update(phi, 2 * phi[0] + 3 * phi[1] + (rng() - 0.5) * 0.1);
  }
  const [a, b] = est.theta();
  assert.ok(Math.abs(a - 2) < 0.05 && Math.abs(b - 3) < 0.05, `${a} ${b}`);
  assert.ok(est.confidence() > 0.8);
  assert.equal(est.updates(), 400);
});

test('estimator: keeps parameters above their floor and ignores broken samples', () => {
  const est = createEstimator({ theta: [1], variance: [1], noise: 0.01, drift: [0], floor: [0.5] });
  for (let i = 0; i < 50; i += 1) est.update([1], -10);
  assert.equal(est.theta()[0], 0.5);
  assert.equal(est.update([Number.NaN], 1), null);
  assert.equal(est.update([1, 2], 1), null);
  assert.equal(est.update([1], Infinity), null);
});

test('estimator: a saved state comes back whole, a foreign one is refused', () => {
  const est = createEstimator({ theta: [1, 2], variance: [1, 1], noise: 0.1, drift: [0, 0] });
  est.update([1, 0.5], 4);
  const saved = est.save();
  const copy = createEstimator({ theta: [0, 0], variance: [1, 1], noise: 0.1, drift: [0, 0] });
  assert.equal(copy.load(saved), true);
  assert.deepEqual(copy.theta(), est.theta());
  assert.equal(copy.confidence(), est.confidence());
  assert.equal(copy.load({ theta: [1], P: [[1]] }), false);
  assert.equal(copy.load({ theta: [1, Number.NaN], P: saved.P }), false);
  assert.equal(copy.load(null), false);
});

// A model fed by a simple slow node: S relaxes toward Ta + P / G with fans fixed.
function feed(model, { seconds, power, Ta = 30, R = 0.3, G = 4, S0 = 40, fractions = { a: 0.5 }, liquid = false, rng = seeded(1) }) {
  let S = S0;
  for (let t = 0; t < seconds; t += 1) {
    const P = power(t);
    S += (P - G * (S - Ta)) / 1500;
    const die = Math.round((S + R * P + (rng() - 0.5) * 0.2) / 0.125) * 0.125;
    model.observe({ at: (t + 1) * 1000, die, power: P, ambient: Ta, fractions, liquid: liquid ? S : null });
  }
  return S;
}

test('model: R is learned from power steps', () => {
  const m = createNodeModel({ node: 'cpu', channels: [{ id: 'a', place: 'radiator' }] });
  feed(m, { seconds: 1200, power: (t) => (Math.floor(t / 30) % 2 ? 120 : 40) });
  assert.ok(Math.abs(m.coefficients().R - 0.3) < 0.04, String(m.coefficients().R));
});

test('model: a burst moves the die, not the slow node', () => {
  const m = createNodeModel({ node: 'cpu', channels: [{ id: 'a', place: 'radiator' }] });
  feed(m, { seconds: 600, power: (t) => (Math.floor(t / 30) % 2 ? 120 : 40) });
  feed(m, { seconds: 120, power: () => 40, S0: 45 });
  const before = m.state().S;
  let S = 45;
  for (let t = 0; t < 3; t += 1) {
    S += (130 - 4 * (S - 30)) / 1500;
    m.observe({ at: 800000 + t * 1000, die: S + 0.3 * 130, power: 130, ambient: 30, fractions: { a: 0.5 } });
  }
  assert.ok(Math.abs(m.state().S - before) < 1.5, `${before} -> ${m.state().S}`);
});

test('model: the planner takes a new R as S does, over its smoothing time, never at once', () => {
  const m = createNodeModel({ node: 'cpu', channels: [{ id: 'a', place: 'radiator' }] });
  feed(m, { seconds: 300, power: () => 80 });
  const saved = JSON.parse(JSON.stringify(m.save()));
  const copy = createNodeModel({ node: 'cpu', channels: [{ id: 'a', place: 'radiator' }] });
  // R has just been learned anew while S still carries the old one.
  assert.equal(copy.load({ ...saved, R: 0.6, Rs: 0.2 }), true);
  assert.equal(copy.coefficients().R, 0.2);
  // No power reading: R itself is not learned again here, only carried.
  const tick = (at) => copy.observe({ at, die: 50, power: null, ambient: 30, fractions: { a: 0.5 } });
  tick(1000);
  const one = copy.coefficients().R;
  assert.ok(one > 0.2 && one < 0.25, `one second in: ${one}`);
  for (let t = 2; t <= 60; t += 1) tick(t * 1000);
  assert.ok(copy.coefficients().R > 0.57, `a minute in: ${copy.coefficients().R}`);
});

test('model: a real liquid sensor is the slow node', () => {
  const m = createNodeModel({ node: 'cpu', channels: [{ id: 'a', place: 'radiator' }] });
  const S = feed(m, { seconds: 300, power: () => 100, liquid: true });
  assert.ok(Math.abs(m.state().S - S) < 1e-9);
  assert.ok(Math.abs(m.coefficients().R - 0.3) < 0.05);
});

test('model: power average and swing follow the load', () => {
  const m = createNodeModel({ node: 'cpu', channels: [{ id: 'a', place: 'radiator' }] });
  feed(m, { seconds: 600, power: (t) => (t % 2 ? 80 : 100) });
  const { Peff, Pdev } = m.state();
  assert.ok(Math.abs(Peff - 90) < 3, String(Peff));
  assert.ok(Pdev > 5 && Pdev < 15, String(Pdev));
});

test('model: more air settles the slow node cooler, and predict converges to steady', () => {
  const m = createNodeModel({ node: 'cpu', channels: [{ id: 'a', place: 'radiator' }, { id: 'b', place: 'front' }] });
  feed(m, { seconds: 60, power: () => 80, fractions: { a: 0.5, b: 0.5 } });
  const slow = m.steady({ a: 0.2, b: 0.2 }, 100, 30);
  const fast = m.steady({ a: 1, b: 1 }, 100, 30);
  assert.ok(fast < slow);
  assert.ok(m.alpha({ a: 1, b: 0 }) > m.alpha({ a: 0, b: 1 }), 'a radiator fan cools a CPU more than a front fan');
  assert.ok(Math.abs(m.predict({ a: 0.5, b: 0.5 }, 100, 30, 1e7) - m.steady({ a: 0.5, b: 0.5 }, 100, 30)) < 1e-6);
});

test('model: a saved model comes back with what it learned', () => {
  const m = createNodeModel({ node: 'gpu', channels: [{ id: 'g', place: 'gpu' }] });
  feed(m, { seconds: 900, power: (t) => (Math.floor(t / 40) % 2 ? 300 : 120), R: 0.05 });
  const copy = createNodeModel({ node: 'gpu', channels: [{ id: 'g', place: 'gpu' }] });
  assert.equal(copy.load(JSON.parse(JSON.stringify(m.save()))), true);
  assert.deepEqual(copy.coefficients(), m.coefficients());
  assert.equal(copy.load({ est: { theta: [1] } }), false);
  assert.equal(copy.load(null), false);
});

test('noise: twice the speed is 15 dB louder, two equal fans 3 dB louder than one', () => {
  const fan = { maxRpm: 1500 };
  assert.ok(Math.abs(N.fanDb(fan, 2000) - N.fanDb(fan, 1000) - 15.05) < 0.01);
  const one = N.fanDb(fan, 1000);
  assert.ok(Math.abs(N.totalDb([one, one]) - one - 3.01) < 0.01);
  assert.equal(N.fanDb(fan, 0), -Infinity);
  assert.equal(N.totalDb([]), -Infinity);
  assert.equal(N.totalDb([-Infinity, one]), one);
});

test('noise: reference level by kind and top speed, a measurement wins', () => {
  assert.equal(N.refLevel({ maxRpm: 1200 }), 21);
  assert.equal(N.refLevel({ maxRpm: 2000 }), 23);
  assert.equal(N.refLevel({ maxRpm: 3000 }), 25);
  assert.equal(N.refLevel({ maxRpm: 5000 }), 28);
  assert.equal(N.refLevel({ place: 'gpu', maxRpm: 3000 }), 24);
  assert.equal(N.refLevel({ kind: 'pump' }), 20);
  assert.equal(N.refLevel({ maxRpm: 1200, noiseRef: 30 }), 30);
});

test('noise: similar fans turn as one group; pumps and blind fans stand alone', () => {
  const groups = N.beatGroups([
    { id: 'f1', hasTach: true, maxRpm: 1500 }, { id: 'f2', hasTach: true, maxRpm: 1560 },
    { id: 'r1', hasTach: true, maxRpm: 2000 }, { id: 'f3', hasTach: true, maxRpm: 1700 },
    { id: 'p', kind: 'pump', hasTach: true, maxRpm: 1520 }, { id: 'blind', hasTach: false, maxRpm: 1500 },
  ]);
  assert.deepEqual(groups, [['f1', 'f2'], ['f3'], ['r1'], ['p'], ['blind']]);
});

test('noise: close speeds are pulled up together, far or equal ones left alone', () => {
  assert.deepEqual(N.unbeat({ a: 1000, b: 970, c: 600, d: 0 }), { a: 1000, b: 1000, c: 600, d: 0 });
  assert.deepEqual(N.unbeat({ a: 1000, b: 999 }), { a: 1000, b: 999 });
  const out = N.unbeat({ a: 800, b: 820, c: 790 });
  assert.ok(Object.values(out).every((v) => v === 820));
});

test('noise: a resonance zone is skipped up when rising, down when falling', () => {
  assert.equal(N.avoidZones(900, [[850, 950]], true), 950);
  assert.equal(N.avoidZones(900, [[850, 950]], false), 850);
  assert.equal(N.avoidZones(800, [[850, 950]], true), 800);
  assert.equal(N.avoidZones(900, [null, [1]], true), 900);
});
