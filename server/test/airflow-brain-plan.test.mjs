// Airflow's planner (server/airflow/brain-plan.js): the quietest mix of fan speeds
// that holds every component under its ceiling, and at its target while the last
// degrees are worth their noise. Untrained models (the priors), so the numbers
// here are what a brand-new install plans.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../airflow/limits.js');
const { plan, RAMP, PDEV_K } = require('../airflow/brain-plan.js');
const { createNodeModel } = require('../airflow/brain-model.js');

const CPU = 'AMD Ryzen 7 9700X';
const fan = (id, place, maxRpm, minFrac, extra = {}) => ({ id, kind: 'fan', place, maxRpm, minFrac, hasTach: true, controllable: true, ...extra });
const CHANNELS = Object.freeze([
  fan('rad1', 'radiator', 2000, 0.25), fan('rad2', 'radiator', 2000, 0.25), fan('rad3', 'radiator', 2000, 0.25),
  fan('front1', 'front', 1500, 0.25, { zeroOk: true }), fan('front2', 'front', 1500, 0.25, { zeroOk: true }),
  fan('front3', 'front', 1500, 0.25, { zeroOk: true }), fan('rear', 'rear', 1500, 0.25, { zeroOk: true }),
  fan('gpu1', 'gpu', 3000, 0.3, { zeroOk: true, zeroByDefault: true }), fan('gpu2', 'gpu', 3000, 0.3, { zeroOk: true, zeroByDefault: true }),
]);

function models(channels = CHANNELS) {
  const places = channels.filter((c) => c.kind !== 'pump').map((c) => ({ id: c.id, place: c.place }));
  return { cpu: createNodeModel({ node: 'cpu', channels: places }), gpu: createNodeModel({ node: 'gpu', channels: places }) };
}

const targets = (bias = 0.5) => Object.fromEntries(Object.keys(L.COMPONENTS).map((n) => [n, L.targetFor(n, bias, CPU)]));
const ceilings = () => Object.fromEntries(Object.keys(L.COMPONENTS).map((n) => [n, L.fullAt(n, CPU) - L.COMPONENTS[n].margin]));

function input({ cpu = 25, gpu = 20, die = {}, ambient = 30, hasPower = true, channels = CHANNELS, ...rest } = {}) {
  const reading = (P, d) => ({ die: d, power: P, Peff: P, Pdev: 0, dieSmooth: d, hasPower });
  return {
    channels,
    models: models(channels),
    readings: { ambient, liquidTarget: true, cpu: reading(cpu, die.cpu ?? 50), gpu: reading(gpu, die.gpu ?? 40) },
    targets: targets(rest.bias),
    ceilings: ceilings(),
    bias: 0.5,
    ...rest,
  };
}

// Die temperature the model expects once things settle, at this plan.
function settledDie(inp, node, fractions) {
  const m = inp.models[node];
  const P = inp.readings[node].Peff;
  return m.steady(fractions, P, inp.readings.ambient) + m.coefficients().R * P;
}

const at = (p, ids) => ids.map((id) => p.fractions[id]);

test('idle: every fan at its floor, the card\'s fans stopped as the card would', () => {
  const p = plan(input());
  assert.deepEqual(at(p, ['rad1', 'rad2', 'rad3']), [0.25, 0.25, 0.25]);
  assert.deepEqual(at(p, ['front1', 'front2', 'front3', 'rear']), [0.25, 0.25, 0.25, 0.25]);
  assert.deepEqual(at(p, ['gpu1', 'gpu2']), [0, 0]);
  assert.deepEqual(p.impossible, []);
  assert.deepEqual(p.urgent, []);
});

test('idle with stopping allowed: every fan that may stop does, the radiator keeps turning', () => {
  const p = plan(input({ allowZero: true }));
  assert.deepEqual(at(p, ['front1', 'front2', 'front3', 'rear', 'gpu1', 'gpu2']), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(at(p, ['rad1', 'rad2', 'rad3']), [0.25, 0.25, 0.25]);
});

test('gaming: every component is planned to settle at or under its target', () => {
  const inp = input({ cpu: 60, gpu: 280 });
  const p = plan(inp);
  const t = targets();
  assert.deepEqual(p.impossible, []);
  assert.ok(settledDie(inp, 'cpu', p.fractions) <= t.cpu + 0.01, String(settledDie(inp, 'cpu', p.fractions)));
  assert.ok(settledDie(inp, 'gpu', p.fractions) <= t.gpu + 0.01, String(settledDie(inp, 'gpu', p.fractions)));
  assert.ok(p.fractions.gpu1 > 0, 'a busy card does not keep its fans stopped');
  assert.ok(p.binding.includes('gpu'));
});

test('more heat never plans a quieter mix, and every mix stays at its target', () => {
  // One fan may ease off when another's extra speed already covers it; the
  // whole never gets quieter as heat grows. The last tenths of a degree are
  // not always worth a step.
  let prev = -Infinity;
  const t = targets();
  for (const gpu of [60, 150, 220, 280, 330]) {
    const inp = input({ cpu: 60, gpu });
    const p = plan(inp);
    assert.ok(p.noiseDb >= prev - 1e-9, `${gpu} W: ${p.noiseDb} after ${prev}`);
    assert.ok(settledDie(inp, 'gpu', p.fractions) <= t.gpu + 0.5, `${gpu} W`);
    prev = p.noiseDb;
  }
});

test('a load just past reach never drops the fans: the answer grows with the heat', () => {
  for (const bias of [0.15, 0.5]) {
    let prev = -Infinity;
    for (let cpu = 80; cpu <= 200; cpu += 10) {
      const p = plan(input({ cpu, gpu: 30, bias }));
      assert.ok(p.noiseDb >= prev - 1e-9, `bias ${bias}, ${cpu} W: ${p.noiseDb} after ${prev}`);
      prev = p.noiseDb;
    }
  }
});

test('a ceiling nothing can hold sends every fan that helps to full', () => {
  const p = plan(input({ cpu: 400, gpu: 30 }));
  for (const id of ['rad1', 'rad2', 'rad3', 'front1']) assert.ok(p.fractions[id] >= 0.98, `${id} ${p.fractions[id]}`);
  assert.ok(p.fractions.gpu1 < 0.5, 'fans on the card barely touch a CPU');
});

test('the comfort slider alone trades degrees for silence', () => {
  const quiet = plan(input({ cpu: 100, gpu: 30, bias: 0.15, targets: targets() }));
  const cool = plan(input({ cpu: 100, gpu: 30, bias: 0.85, targets: targets() }));
  assert.ok(quiet.noiseDb < cool.noiseDb - 5, `${quiet.noiseDb} vs ${cool.noiseDb}`);
});

test('a load that swings is planned above its average, a known game before it loads', () => {
  const steady = plan(input({ cpu: 60, gpu: 280 }));
  const swing = input({ cpu: 60, gpu: 280 });
  swing.readings.gpu.Pdev = 30;
  const swinging = plan(swing);
  assert.ok(swinging.noiseDb > steady.noiseDb, `${swinging.noiseDb} vs ${steady.noiseDb}`);
  const ahead = plan(input({ cpu: 60, gpu: 30, anticipate: { gpu: 280 + PDEV_K * 30 } }));
  assert.ok(Math.abs(ahead.noiseDb - swinging.noiseDb) < 1e-9);
});

test('fans in one beat group turn at one speed', () => {
  const p = plan(input({ cpu: 90, gpu: 280 }));
  assert.equal(new Set(at(p, ['rad1', 'rad2', 'rad3'])).size, 1);
  assert.equal(new Set(at(p, ['gpu1', 'gpu2'])).size, 1);
});

test('a quieter comfort plans less air than a cooler one', () => {
  const quiet = plan(input({ cpu: 90, gpu: 280, bias: 0.15, targets: targets(0.15) }));
  const cool = plan(input({ cpu: 90, gpu: 280, bias: 0.85, targets: targets(0.85) }));
  assert.ok(quiet.noiseDb < cool.noiseDb, `${quiet.noiseDb} vs ${cool.noiseDb}`);
});

test('out of reach: the source is flagged and still gets more air than it needs at a normal load', () => {
  const normal = plan(input({ cpu: 90, gpu: 30 }));
  const render = plan(input({ cpu: 250, gpu: 30 }));
  assert.ok(render.impossible.includes('cpu'));
  assert.ok(render.fractions.rad1 > normal.fractions.rad1);
});

test('a fan Xenon does not drive counts at the speed it turns and is not planned', () => {
  const channels = CHANNELS.map((c) => (c.id === 'rear' ? { ...c, controllable: false } : c));
  const inp = input({ cpu: 60, gpu: 280, channels, measured: { rear: 1 } });
  const p = plan(inp);
  assert.equal('rear' in p.fractions, false);
  assert.ok(settledDie(inp, 'cpu', { ...p.fractions, rear: 1 }) <= targets().cpu + 0.01);
  const all = plan(input({ cpu: 60, gpu: 280 }));
  assert.ok(p.fractions.front1 <= all.fractions.front1 + 1e-9, 'a fan already turning fast spares the others');
});

test('no power readings: a plain curve on the die temperature', () => {
  const t = targets();
  const hot = plan(input({ hasPower: false, die: { cpu: t.cpu, gpu: 40 } }));
  assert.deepEqual(at(hot, ['rad1', 'rad2', 'rad3']), [1, 1, 1]);
  const cool = plan(input({ hasPower: false, die: { cpu: t.cpu - RAMP, gpu: 40 } }));
  assert.deepEqual(at(cool, ['rad1', 'rad2', 'rad3']), [0.25, 0.25, 0.25]);
  const half = plan(input({ hasPower: false, die: { cpu: t.cpu - RAMP / 2, gpu: 40 } }));
  assert.ok(Math.abs(half.fractions.rad1 - 0.5) < 1e-9);
});

test('the previous plan stays while it still holds every target and costs about the same', () => {
  const inp = input({ cpu: 90, gpu: 280 });
  const first = plan(inp);
  const nudged = Object.fromEntries(Object.entries(first.fractions).map(([id, f]) => [id, id.startsWith('front') || id === 'rear' ? Math.min(1, f + 0.02) : f]));
  const again = plan({ ...inp, previous: nudged });
  assert.equal(again.kept, true);
  assert.deepEqual(again.fractions, nudged);
});

test('the previous plan is dropped when it no longer holds a target', () => {
  const idle = plan(input());
  const busy = plan({ ...input({ cpu: 90, gpu: 280 }), previous: idle.fractions });
  assert.equal(busy.kept, false);
  assert.ok(busy.fractions.gpu1 > idle.fractions.gpu1);
});

test('the previous plan is dropped when it leaves a component clearly warmer, however close in noise', () => {
  const inp = input({ cpu: 60, gpu: 330 });
  const first = plan(inp);
  const short = { ...first.fractions, gpu1: first.fractions.gpu1 - 0.06 };
  const lost = settledDie(inp, 'gpu', short) - Math.max(settledDie(inp, 'gpu', first.fractions), inp.targets.gpu);
  assert.ok(lost > 0.7, `a degree of comfort lost: ${lost}`);
  const again = plan({ ...inp, previous: short });
  assert.equal(again.kept, false);
  assert.deepEqual(again.fractions, first.fractions);
});

test('the previous plan is dropped when it sits under a floor that now applies', () => {
  const first = plan(input());
  const again = plan({ ...input(), previous: { ...first.fractions, front1: 0 } });
  assert.equal(again.kept, false);
  assert.equal(again.fractions.front1, 0.25);
});

test('the previous plan is dropped when it no longer holds a ceiling, however close in noise', () => {
  const inp = input({ cpu: 60, gpu: 150, bias: 0.15, targets: targets(0.15) });
  const first = plan(inp);
  const t = ceilings();
  assert.ok(settledDie(inp, 'gpu', first.fractions) > t.gpu - 1, 'the ceiling binds here');
  const short = Object.fromEntries(Object.entries(first.fractions).map(([id, f]) => [id, id.startsWith('front') ? f - 0.02 : f]));
  const again = plan({ ...inp, previous: short });
  assert.equal(again.kept, false);
  assert.ok(settledDie(inp, 'gpu', again.fractions) <= t.gpu + 0.01);
});

test('the previous plan is dropped for a ceiling it crosses by a hair, though comfort and noise barely move', () => {
  // A card load that puts the plan a tenth of a degree under the ceiling: searched, since
  // where it falls moves with what the other sources ask of the same fans.
  const t = ceilings();
  let hair = null;
  for (let gpu = 120; gpu <= 220 && !hair; gpu += 1) {
    const inp = input({ cpu: 60, gpu, bias: 0.15, targets: targets(0.15) });
    const first = plan(inp);
    const short = { ...first.fractions, front1: first.fractions.front1 - 0.02 };
    const crossed = settledDie(inp, 'gpu', short);
    // Over the ceiling, by less than comfort alone would let it keep (KEEP_C).
    if (crossed > t.gpu && crossed - settledDie(inp, 'gpu', first.fractions) < 0.5) hair = { inp, short };
  }
  assert.ok(hair, 'no card load puts the plan a hair under its ceiling, or this proves nothing');
  assert.equal(plan({ ...hair.inp, previous: hair.short }).kept, false);
});

test('heat close at today\'s speeds is urgent', () => {
  const t = targets();
  const calm = plan(input({ cpu: 90, gpu: 280, die: { cpu: t.cpu - 5, gpu: t.gpu - 5 }, measured: { rad1: 1, rad2: 1, rad3: 1, gpu1: 1, gpu2: 1 } }));
  assert.deepEqual(calm.urgent, []);
  const hot = plan(input({ cpu: 90, gpu: 280, die: { cpu: t.cpu + 3, gpu: 40 } }));
  assert.ok(hot.urgent.includes('cpu'));
});

test('a burst on an idle chip is not urgent: the averages say whether heat is close', () => {
  // A Ryzen jumps to its target for a second when an app opens; each jump called urgent
  // ramped the fans past the learning hold (23 Nov 2026).
  const t = targets();
  const inp = input({ cpu: 110, die: { cpu: t.cpu + 6 } });
  inp.readings.cpu = { ...inp.readings.cpu, Peff: 48, dieSmooth: 55 };
  assert.deepEqual(plan(inp).urgent, []);
  // The same jump kept up: the smoothed die gets there and it is urgent.
  inp.readings.cpu = { ...inp.readings.cpu, Peff: 110, dieSmooth: t.cpu + 4 };
  assert.ok(plan(inp).urgent.includes('cpu'));
});

test('a swing the average fits is planned for, but not called out of reach', () => {
  // A radiator with no liquid sensor: the die alone is the limit.
  const cpuAt = (watts, swing) => {
    const inp = input({ cpu: watts, channels: CHANNELS.filter((c) => ['rad1', 'rad2', 'front1'].includes(c.id)) });
    inp.readings.liquidTarget = false;
    inp.readings.cpu.Pdev = swing;
    return plan(inp);
  };
  const p = cpuAt(110, 20);
  assert.deepEqual(at(p, ['rad1', 'rad2']), [1, 1], 'planned for the swing');
  assert.deepEqual(p.impossible, []);
  assert.deepEqual(cpuAt(110 + PDEV_K * 20, 0).impossible, ['cpu'], 'the same power held: out of reach');
});

test('a fan the model learned does nothing for a chip is not spun up for it, even past its ceiling', () => {
  // A case fan next to a CPU on a cooler of its own: learned to move a thousandth of its prior.
  const inp = input({ cpu: 400, channels: CHANNELS.filter((c) => ['rad1', 'front1'].includes(c.id)) });
  const real = inp.models.cpu;
  const c = real.coefficients();
  inp.models.cpu = { ...real, coefficients: () => ({ ...c, b: { ...c.b, front1: c.b.front1 * 0.001 } }) };
  const p = plan(inp);
  assert.equal(p.fractions.rad1, 1, 'the radiator climbs to full');
  assert.equal(p.fractions.front1, 0.25, 'the useless fan stays at its floor');
});
