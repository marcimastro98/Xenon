// How fast the fans climb when the CPU wants more air (server/airflow/brain.js). On a
// liquid the fans reach the die only through the liquid, which warms over minutes: they
// climb at the calm rate, about a minute from slow to full. A test run on every core took
// an X3D's radiator from quiet to full in forty seconds and it read as a jump (24 Nov 2026).
// On an air cooler the heatsink answers in seconds: the usual rate. Heat close on the die
// is urgent and climbs fast either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBrain } = require('../airflow/brain.js');
const L = require('../airflow/limits.js');

const X3D = 'AMD Ryzen 7 7800X3D 8-Core Processor';
const fan = (id, place, maxRpm, minFrac, extra = {}) => ({ id, kind: 'fan', place, maxRpm, minFrac, hasTach: true, controllable: true, curve: [[minFrac * 100, minFrac * maxRpm], [100, maxRpm]], ...extra });
const AIO = [
  { id: 'pump', kind: 'pump', place: null, maxRpm: 2780, minFrac: 0.68, hasTach: true, controllable: true, curve: [[50, 1880], [100, 2780]] },
  fan('rad1', 'radiator', 2120, 0.14), fan('rad2', 'radiator', 2120, 0.14), fan('rad3', 'radiator', 2120, 0.14),
  fan('case1', 'case', 2090, 0.25),
];
const AIO_CARD = [...AIO, fan('gpu1', 'gpu', 3300, 0.3)];
const AIR_COOLER = [fan('cpu1', 'cpu', 1800, 0.25), fan('case1', 'case', 2090, 0.25), fan('case2', 'case', 2090, 0.25)];
const AIR = 25;
const R = 0.39;

/**
 * Ten minutes of light work, then a load: on every core (watts) or on the card (gpuWatts).
 * The CPU's slow node (the liquid, or the heatsink) settles at AIR + P / (2 + G x sum r^0.8)
 * over the fans that cool it, with its own time constant; the die sits R x P over it. The
 * card's die settles at AIR + P / (1 + 3 x r^0.8) over its own fan in twenty seconds.
 * @returns {{ t: number, out: any, frac: Record<string, number>, die: number, gpu: number }[]} every second of the load
 */
function run(channels, { cooling, tau, G = 2.2, watts = 45, gpuWatts = 30, seconds = 400 }) {
  const brain = createBrain({ channels, cpuName: X3D });
  const frac = Object.fromEntries(channels.map((c) => [c.id, c.kind === 'pump' ? 0.7 : 0.25]));
  const pull = () => 2 + G * cooling.reduce((s, id) => s + frac[id] ** 0.8, 0);
  const card = () => 1 + 3 * (frac.gpu1 ?? 0) ** 0.8;
  let slow = AIR + 45 / pull();
  let gpu = AIR + 30 / card();
  const rows = [];
  for (let t = 1; t <= 600 + seconds; t += 1) {
    const P = t > 600 ? watts + ((t * 7) % 9) - 4 : 45 + ((t * 5) % 5);
    const gP = t > 600 ? gpuWatts + ((t * 3) % 7) - 3 : 30;
    slow += (AIR + P / pull() - slow) / tau;
    gpu += (AIR + gP / card() - gpu) / 20;
    const at = t * 1000;
    const die = slow + R * P;
    const temps = { cpu: { value: Math.round(die * 8) / 8, at }, gpu: { value: Math.round(gpu * 8) / 8, at } };
    if (channels.some((c) => c.kind === 'pump')) temps.liquid = { value: Math.round(slow * 10) / 10, at };
    const out = brain.tick({
      at, temps, power: { cpu: P, gpu: gP }, duty: {},
      rpm: Object.fromEntries(channels.map((c) => [c.id, Math.round(frac[c.id] * c.maxRpm)])),
    }, { mode: 'auto', slider: 50, hour: 15, driving: true });
    for (const c of channels) if (Number.isFinite(out.fractions[c.id])) frac[c.id] = out.fractions[c.id];
    if (t > 600) rows.push({ t: t - 600, out, frac: { ...frac }, die, gpu });
  }
  return rows;
}

/** The biggest climb of one fan in one second, over seconds that were not urgent. */
const steepest = (rows, id) => Math.max(0, ...rows.slice(1).map((r, i) => (r.out.urgent.length ? 0 : r.frac[id] - rows[i].frac[id])));

test('a CPU on a liquid that wants more air: the radiator climbs at the calm rate, about a minute from slow to full', () => {
  const rows = run(AIO, { cooling: ['rad1', 'rad2', 'rad3'], tau: 120, watts: 85 });
  const top = Math.max(...rows.map((r) => r.frac.rad1));
  assert.ok(top >= 0.5, `the radiator only reached ${top.toFixed(2)} under the load`);
  assert.ok(rows.some((r) => r.out.binding.includes('cpu')), 'the CPU never asked for air');
  const step = steepest(rows, 'rad1');
  assert.ok(step <= L.RATE.up / 2 + 1e-9, `the radiator climbed ${step.toFixed(3)} in a second`);
  // The case fan, bought for the same CPU, climbs as gently.
  assert.ok(steepest(rows, 'case1') <= L.RATE.up / 2 + 1e-9);
});

test('a CPU on an air cooler climbs at the usual rate: its heatsink answers in seconds', () => {
  const rows = run(AIR_COOLER, { cooling: ['cpu1'], tau: 40, watts: 95 });
  assert.ok(Math.max(...rows.map((r) => r.frac.cpu1)) >= 0.5);
  assert.ok(rows.some((r) => r.out.binding.includes('cpu')), 'the CPU never asked for air');
  const step = steepest(rows, 'cpu1');
  assert.ok(step > L.RATE.up / 2 + 1e-6, `the cooler's fan climbed at most ${step.toFixed(3)} in a second`);
  assert.ok(step <= L.RATE.up + 1e-9);
});

test('a card wanting air on a PC with a liquid cooler climbs at the usual rate', () => {
  const rows = run(AIO_CARD, { cooling: ['rad1', 'rad2', 'rad3'], tau: 120, gpuWatts: 260 });
  assert.ok(rows.some((r) => r.out.binding.includes('gpu')), 'the card never asked for air');
  assert.ok(Math.max(...rows.map((r) => r.frac.gpu1)) >= 0.5);
  const step = steepest(rows, 'gpu1');
  assert.ok(step > L.RATE.up / 2 + 1e-6, `the card's fan climbed at most ${step.toFixed(3)} in a second`);
});

test('fans working for the CPU and the card name the one closer to its limit first', () => {
  // The reason leads with the first of the binding (reasons.js): in a fixed order a card at
  // 33 C was named for fans bought for a busy CPU (25 Nov 2026).
  const rows = run(AIO_CARD, { cooling: ['rad1', 'rad2', 'rad3'], tau: 120, watts: 95, gpuWatts: 160, seconds: 600 });
  // The order is made on the dies smoothed over ten seconds (brain.js), so they are read alike
  // here: read raw, a card climbing a degree a second looked ten degrees closer to its limit the
  // second it first asked for air. A few degrees of slack for the rounding and the light work before.
  const smooth = { cpu: null, gpu: null };
  const ease = (prev, x) => (prev == null ? x : prev + (x - prev) * (1 - Math.exp(-1 / 10)));
  for (const r of rows) { smooth.cpu = ease(smooth.cpu, r.die); smooth.gpu = ease(smooth.gpu, r.gpu); r.smooth = { ...smooth }; }
  const both = rows.filter((r) => r.out.binding.length === 2);
  assert.ok(both.length > 100, 'the CPU and the card never asked for air together');
  for (const r of both) {
    const over = { cpu: r.smooth.cpu - r.out.targets.cpu, gpu: r.smooth.gpu - r.out.targets.gpu };
    const [first, second] = r.out.binding;
    assert.ok(over[second] - over[first] < 5, `at ${r.t} s ${first} came first, ${second} ${(over[second] - over[first]).toFixed(1)} K closer to its limit`);
  }
});
