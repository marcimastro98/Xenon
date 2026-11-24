// Airflow on light, bursty work in a warm case (24 Nov 2026): an X3D on a 360 AIO whose
// radiator and a case fan climbed to 80-90 % on a CPU 13 degrees under its target. How far
// over the air each source is held and how a swing in power counts on a liquid and on a
// heatsink (server/airflow/brain-needs.js), the correction that no longer counts a burst and
// the pump that no longer climbs for warmth kept on purpose (server/airflow/brain-correct.js,
// brain.js), and
// the moment the model is held to (server/airflow/brain-anchor.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../airflow/limits.js');
const { constraints, PDEV_K } = require('../airflow/brain-needs.js');
const { createNodeModel } = require('../airflow/brain-model.js');
const { createAnchor } = require('../airflow/brain-anchor.js');
const { createBrain } = require('../airflow/brain.js');

const CPU = 'AMD Ryzen 7 9800X3D 8-Core Processor';
const targets = (bias) => Object.fromEntries(Object.keys(L.COMPONENTS).map((n) => [n, L.targetFor(n, bias, CPU)]));
const ceilings = () => Object.fromEntries(Object.keys(L.COMPONENTS).map((n) => [n, L.fullAt(n, CPU) - L.COMPONENTS[n].margin]));

// What each source needs, on untrained models, a CPU on liquid.
function needs({ cpu = 60, gpu = 40, ambient = 30, bias = 0.5, dev = {} } = {}) {
  const places = [{ id: 'rad', place: 'radiator' }, { id: 'front', place: 'front' }, { id: 'gpu', place: 'gpu' }];
  const models = { cpu: createNodeModel({ node: 'cpu', channels: places }), gpu: createNodeModel({ node: 'gpu', channels: places }) };
  const reading = (P, d) => ({ Peff: P, Pdev: d || 0, hasPower: true });
  const readings = { ambient, liquidTarget: true, cpu: reading(cpu, dev.cpu), gpu: reading(gpu, dev.gpu) };
  const out = constraints({ models, readings, targets: targets(bias), ceilings: ceilings(), bias });
  return Object.fromEntries(out.map((c) => [c.node, { ...c, k: models[c.node].coefficients().theta1 }]));
}
// How far over the air comfort asks the source's slow node to settle.
const room = (c) => c.heat / c.want;

test('the liquid is held as far over the air as the slider allows, never past its ceiling, never under its target', () => {
  const ceiling = ceilings().liquid;
  for (const [ambient, bias, rise] of [[34, 0, 12], [34, 0.5, 9], [34, 1, 6], [36, 0, 12], [22, 0.5, 9]]) {
    // At 40 W the die, R x 40 over its liquid, leaves the liquid as the limit.
    const { cpu } = needs({ cpu: 40, ambient, bias });
    const liquid = Math.min(Math.max(targets(bias).liquid, ambient + rise), ceiling);
    assert.ok(Math.abs(room(cpu) - (liquid - ambient)) < 1e-9, `${ambient} C, bias ${bias}: ${room(cpu)} over the air, not ${liquid - ambient}`);
  }
});

test('a swing counts on a heatsink, not on a liquid that never sees it; the die over a liquid is planned at its peak', () => {
  const steady = needs({ cpu: 60, gpu: 200 });
  const swing = needs({ cpu: 60, gpu: 200, dev: { cpu: 15, gpu: 30 } });
  // A liquid moves over minutes: it is planned at the average.
  assert.ok(Math.abs(swing.cpu.heat - steady.cpu.heat) < 1e-12);
  // A card's heatsink follows within seconds: at the average plus the swing.
  assert.ok(Math.abs(swing.gpu.heat - swing.gpu.k * (200 + PDEV_K * 30)) < 1e-12);
  assert.ok(swing.gpu.want > steady.gpu.want);
  // The die rides R x P over its liquid within a second: planned at the swing's peak, as a
  // steady load there would be. At 150-170 W the die, not the liquid, is the limit.
  const peaks = needs({ cpu: 150, ambient: 25, dev: { cpu: 10 } });
  const there = needs({ cpu: 170, ambient: 25 });
  assert.ok(room(there.cpu) < ceilings().liquid - 25 && room(there.cpu) < targets(0.5).liquid - 25, 'the die is the limit here, or this proves nothing');
  assert.ok(Math.abs(room(peaks.cpu) - room(there.cpu)) < 1e-9, `${room(peaks.cpu)} vs ${room(there.cpu)}`);
});

// A warm case: the radiator breathes air at `air`, the liquid settles at air + P / (G0 + G x
// sum r^0.8) over five minutes, the die R x P over it. `load` gives the CPU's power each second.
const fan = (id, place, maxRpm, minFrac, extra = {}) => ({ id, kind: 'fan', place, maxRpm, minFrac, hasTach: true, controllable: true, curve: [[minFrac * 100, minFrac * maxRpm], [100, maxRpm]], ...extra });
const CHANNELS = [
  { id: 'pump', kind: 'pump', place: null, maxRpm: 2780, minFrac: 0.68, hasTach: true, controllable: true, curve: [[50, 1880], [100, 2780]] },
  fan('rad1', 'radiator', 2120, 0.14), fan('rad2', 'radiator', 2120, 0.14), fan('rad3', 'radiator', 2120, 0.14),
  fan('case1', 'case', 2090, 0.25, { zeroOk: true }),
  fan('gpu1', 'gpu', 3980, 0.3, { zeroOk: true, zeroByDefault: true }),
];
const RADS = ['rad1', 'rad2', 'rad3'];
function warmCase({ seconds, seed, air, G0, G, R, load, start }) {
  let a = seed;
  const rng = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
  const brain = createBrain({ channels: CHANNELS, cpuName: CPU });
  const frac = { pump: 0.7, rad1: start, rad2: start, rad3: start, case1: start, gpu1: 0 };
  let liquid = air + 3;
  const st = { burst: 0, level: 0 };
  const outs = [];
  for (let t = 1; t <= seconds; t += 1) {
    const P = load(rng, st);
    liquid += (air + P / (G0 + G * RADS.reduce((s, id) => s + frac[id] ** 0.8, 0)) - liquid) / 300;
    const at = t * 1000;
    const out = brain.tick({
      at, power: { cpu: P, gpu: 22 + rng() * 20 }, duty: {},
      temps: { cpu: { value: Math.round((liquid + R * P) * 8) / 8, at }, gpu: { value: 42, at }, liquid: { value: Math.round(liquid * 10) / 10, at } },
      rpm: Object.fromEntries(CHANNELS.map((c) => [c.id, Math.round(frac[c.id] * c.maxRpm)])),
    }, { mode: 'auto', slider: 50, hour: 18 });
    for (const c of CHANNELS) if (Number.isFinite(out.fractions[c.id])) frac[c.id] = out.fractions[c.id];
    outs.push({ ...out, rad: RADS.reduce((s, id) => s + out.fractions[id], 0) / 3, corr: brain.correction().cpu, die: liquid + R * P });
  }
  return outs;
}
// A browser and a code editor: 42-50 W, now and then 5-30 s at 65-85 W.
const lightWork = (rng, st) => {
  if (st.burst <= 0 && rng() < 0.06) { st.burst = 5 + Math.floor(rng() * 25); st.level = 65 + rng() * 20; }
  return st.burst-- > 0 ? st.level + rng() * 5 : 42 + rng() * 8;
};

test('brain: the bursts of light work are not counted as heat the model misses', () => {
  // Air at 34 C and a die 0.42 K/W over its liquid: each burst lifts the smoothed die a few
  // degrees past its target within seconds, whatever the fans do.
  for (const seed of [3, 7, 19]) {
    const outs = warmCase({ seconds: 1800, seed, air: 34, G0: 2.5, G: 3.5, R: 0.42, load: lightWork, start: 0.25 });
    assert.ok(outs.filter((o) => o.die > o.targets.cpu + 2).length > 60, 'no burst past the target, or this proves nothing');
    const corr = Math.max(...outs.map((o) => o.corr));
    assert.ok(corr < 1.01, `seed ${seed}: the correction up to ${corr.toFixed(3)} for heat the fans could not take`);
    const rad = Math.max(...outs.slice(600).map((o) => o.rad));
    assert.ok(rad <= 0.45, `seed ${seed}: the radiator up to ${rad.toFixed(2)} for light work`);
  }
});

test('brain: the pump stays at its low while the liquid sits where the slider lets it', () => {
  // A warm case's idle with Ryzen bursts: the radiator at its floor holds the liquid a degree
  // or two over where faster fans had it, the warmth the slider allows over the air.
  const idle = (rng, st) => {
    if (st.burst <= 0 && rng() < 0.02) st.burst = 2 + Math.floor(rng() * 4);
    return st.burst-- > 0 ? 80 + rng() * 30 : 44 + rng() * 6;
  };
  for (const seed of [3, 7, 19]) {
    const outs = warmCase({ seconds: 1800, seed, air: 34.5, G0: 4, G: 5.8, R: 0.33, load: idle, start: 0.65 });
    const pump = Math.max(...outs.slice(600).map((o) => o.fractions.pump));
    assert.ok(pump <= 0.62, `seed ${seed}: the pump up to ${pump.toFixed(2)} on an idle PC`);
  }
});

test('brain: a liquid past the warmth the slider allows still speeds the pump up', () => {
  const outs = warmCase({ seconds: 900, seed: 5, air: 30, G0: 0.6, G: 0.4, R: 0.3, load: () => 95, start: 0.25 });
  assert.ok(Math.max(...outs.map((o) => o.fractions.pump)) > 0.7, 'a liquid nearing its ceiling with the pump at its low');
});

// The moment, in the estimator's units (brain-model.js): theta = [1/C x 1e5, G0/C x 1e4,
// b_i/C x 1e4]. A liquid of 1500 J/K, 7 W/K with no fan, 6 W/K more from a radiator fan at
// full, almost nothing from a case fan: 100 W with the fans at half settle it 10 K over the air.
const THETA = [100 / 1.5, 70 / 1.5, 60 / 1.5, 0.2];
const ready = (R, real = false) => ({ R, real, ready: true });
function hold(anchor, { from, to, S, F, now, P = 100, Ta = 30 }) {
  for (let t = from; t < to; t += 1) {
    anchor.smooth(typeof S === 'function' ? S(t) : S, P, 1000);
    if (t % 5 === 4) anchor.see((t + 1) * 1000, Ta, F, now);
  }
}

test('anchor: a real liquid is read as it is; a slow node read through die - R x P follows R', () => {
  const real = createAnchor({ theta: () => THETA, windowMs: 5000 });
  hold(real, { from: 0, to: 200, S: 40, F: [0.5, 0.5], now: ready(0.1, true) });
  assert.equal(real.kept(), true);
  assert.equal(real.cal(ready(0.15, true)), real.cal(ready(0.1, true)));
  const read = createAnchor({ theta: () => THETA, windowMs: 5000 });
  hold(read, { from: 0, to: 200, S: 40, F: [0.5, 0.5], now: ready(0.1) });
  // R 0.05 higher puts S, and the rise the moment showed, 5 K lower at 100 W: half of it.
  assert.ok(Math.abs(read.cal(ready(0.15)) / read.cal(ready(0.1)) - 0.5) < 1e-9);
});

test('anchor: the settle clock restarts for a fan that moves this node\'s air, not for one that barely reaches it', () => {
  const now = ready(0.1);
  const rad = createAnchor({ theta: () => THETA, windowMs: 5000 });
  hold(rad, { from: 0, to: 20, S: 40, F: [0.5, 0.5], now });
  hold(rad, { from: 20, to: 200, S: 40, F: [0.6, 0.5], now });
  assert.equal(rad.kept(), false, 'the radiator moved three minutes ago');
  hold(rad, { from: 200, to: 340, S: 40, F: [0.6, 0.5], now });
  assert.equal(rad.kept(), true);
  const other = createAnchor({ theta: () => THETA, windowMs: 5000 });
  hold(other, { from: 0, to: 20, S: 40, F: [0.5, 0.5], now });
  hold(other, { from: 20, to: 200, S: 40, F: [0.5, 1], now });
  assert.equal(other.kept(), true, 'a case fan that barely reaches the liquid held the moment back');
});

test('anchor: a moment still creeping by more than a quarter of its heat is not kept', () => {
  // A slow liquid (15 kJ/K): 100 W warms it by 6.7 mK/s, so a creep of 2.5 mK/s is over a
  // third of its heat, though it moves only 0.2 K in the 90 s the stillness test looks at.
  // Read from the first second: the smoothing's lag must not pass it for still.
  const slow = [THETA[0] / 10, THETA[1] / 10, THETA[2] / 10, THETA[3] / 10];
  const creeping = createAnchor({ theta: () => slow, windowMs: 5000 });
  hold(creeping, { from: 0, to: 400, S: (t) => 40 + 0.0025 * t, F: [0.5, 0.5], now: ready(0.1) });
  assert.equal(creeping.kept(), false);
  const settling = createAnchor({ theta: () => slow, windowMs: 5000 });
  hold(settling, { from: 0, to: 400, S: (t) => 40 + 0.001 * t, F: [0.5, 0.5], now: ready(0.1) });
  assert.equal(settling.kept(), true);
});
