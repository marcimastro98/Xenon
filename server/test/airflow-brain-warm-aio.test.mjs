// A 360 AIO in a warm case (23 Nov 2026): its pump reports the liquid, the board gives
// no air temperature, and at idle the liquid sits at 37-38 C because the air the
// radiator breathes is already about 34. The air guess was capped at 30, so the liquid
// aim of 36 looked reachable and the brain bought fans for it: the radiator at 70-80 %,
// up to full on every Ryzen burst, the pump at 88 %, on a PC doing nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBrain } = require('../airflow/brain.js');

const AIR = 34.5;
const fan = (id, place, maxRpm, minFrac, extra = {}) => ({ id, kind: 'fan', place, maxRpm, minFrac, hasTach: true, controllable: true, curve: [[minFrac * 100, minFrac * maxRpm], [100, maxRpm]], ...extra });
const CHANNELS = [
  { id: 'pump', kind: 'pump', place: null, maxRpm: 2780, minFrac: 0.68, hasTach: true, controllable: true, curve: [[50, 1880], [100, 2780]] },
  fan('rad1', 'radiator', 2120, 0.14), fan('rad2', 'radiator', 2120, 0.14), fan('rad3', 'radiator', 2120, 0.14),
  fan('case1', 'case', 2090, 0.25, { zeroOk: true }),
  fan('gpu1', 'gpu', 3980, 0.3, { zeroOk: true, zeroByDefault: true }),
];

// The liquid settles at AIR + P / (G0 + G x sum r^0.8) over the radiator fans: about 3 K
// over the air at 50 W with the fans at two thirds, 4 K at 40 %, as measured. The die sits
// R x P over the liquid. `load` gives the CPU's power at each second.
const idleLoad = (rng, st) => {
  if (st.burst <= 0 && rng() < 0.02) st.burst = 2 + Math.floor(rng() * 4);
  return st.burst-- > 0 ? 80 + rng() * 30 : 44 + rng() * 6;
};
function warmCase(brain, seconds, seed, { load = idleLoad, R = 0.33 } = {}) {
  let a = seed;
  const rng = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
  const frac = { pump: 0.93, rad1: 0.65, rad2: 0.65, rad3: 0.65, case1: 0.64, gpu1: 0 };
  let liquid = 37.7;
  const st = { burst: 0 };
  const outs = [];
  for (let t = 1; t <= seconds; t += 1) {
    const P = load(rng, st);
    const air = 4 + 5.8 * ['rad1', 'rad2', 'rad3'].reduce((s, id) => s + frac[id] ** 0.8, 0);
    liquid += (AIR + P / air - liquid) / 300;
    const at = t * 1000;
    const out = brain.tick({
      at, power: { cpu: P, gpu: 40 + rng() * 5 }, duty: {},
      temps: { cpu: { value: Math.round((liquid + R * P) * 8) / 8, at }, gpu: { value: 43, at }, liquid: { value: Math.round(liquid * 10) / 10, at } },
      rpm: Object.fromEntries(CHANNELS.map((c) => [c.id, Math.round(frac[c.id] * c.maxRpm)])),
    }, { mode: 'auto', slider: 50, hour: 18 });
    for (const c of CHANNELS) if (Number.isFinite(out.fractions[c.id])) frac[c.id] = out.fractions[c.id];
    outs.push({ ...out, die: liquid + R * P, liquid });
  }
  return outs;
}

test('brain: a warm case\'s AIO idling at 37-38 C keeps its radiator and pump quiet', () => {
  for (const seed of [3, 7, 11, 19]) {
    const outs = warmCase(createBrain({ channels: CHANNELS, cpuName: 'AMD Ryzen 7 9800X3D 8-Core Processor' }), 1800, seed).slice(600);
    const rad = (o) => (o.fractions.rad1 + o.fractions.rad2 + o.fractions.rad3) / 3;
    const top = Math.max(...outs.map(rad));
    const mean = outs.reduce((s, o) => s + rad(o), 0) / outs.length;
    assert.ok(top <= 0.6, `seed ${seed}: the radiator up to ${top.toFixed(2)} on an idle PC`);
    assert.ok(mean <= 0.5, `seed ${seed}: the radiator at ${mean.toFixed(2)} on average on an idle PC`);
    const pump = Math.max(...outs.map((o) => o.fractions.pump));
    assert.ok(pump <= 0.75, `seed ${seed}: the pump up to ${pump.toFixed(2)} on an idle PC`);
    assert.ok(outs.every((o) => !o.urgent.length), `seed ${seed}: a burst called urgent on an idle PC`);
  }
});

// An all-core load (a test suite, a render) at 85-100 W on an X3D: its die sits 38 K over the
// liquid, so the comfort target is out of reach at any fan speed. Planned at average plus
// swing, the ceiling looked crossed too and every fan ran at full for two degrees of liquid
// (23 Nov 2026, a PC with nobody playing).
test('brain: an all-core load in a warm case does not run the radiator at full for two degrees', () => {
  const allCore = (rng) => 85 + rng() * 15;
  for (const seed of [3, 7, 11]) {
    const outs = warmCase(createBrain({ channels: CHANNELS, cpuName: 'AMD Ryzen 7 9800X3D 8-Core Processor' }), 1500, seed, { load: allCore, R: 0.42 }).slice(600);
    const rad = (o) => (o.fractions.rad1 + o.fractions.rad2 + o.fractions.rad3) / 3;
    const mean = outs.reduce((s, o) => s + rad(o), 0) / outs.length;
    assert.ok(mean <= 0.7, `seed ${seed}: the radiator at ${mean.toFixed(2)} on average under an all-core load`);
    // ...and the die still stays under its ceiling (95 - 5 - 7) on average, the liquid well under 46.
    const die = outs.reduce((s, o) => s + o.die, 0) / outs.length;
    assert.ok(die <= 83, `seed ${seed}: the die at ${die.toFixed(1)} on average`);
    assert.ok(Math.max(...outs.map((o) => o.liquid)) < 46, `seed ${seed}: the liquid past its ceiling`);
  }
});

test('brain: the air guess follows a real liquid reading past 30 C, a guessed one stays capped', () => {
  const idle = (liquidSensor) => {
    const brain = createBrain({ channels: CHANNELS, cpuName: 'AMD Ryzen 7 9800X3D 8-Core Processor' });
    let out = null;
    for (let t = 1; t <= 120; t += 1) {
      const at = t * 1000;
      const temps = { cpu: { value: 37.7 + 0.33 * 46, at }, gpu: { value: 43, at }, ...(liquidSensor ? { liquid: { value: 37.7, at } } : {}) };
      out = brain.tick({ at, power: { cpu: 46, gpu: 42 }, duty: {}, temps, rpm: { pump: 2500, rad1: 1370, rad2: 1370, rad3: 1370, case1: 1340, gpu1: 0 } }, { mode: 'auto', slider: 50, hour: 18 });
    }
    return out.ambient;
  };
  // The radiator cannot cool the liquid under the air it breathes: about 3 K under it.
  assert.ok(Math.abs(idle(true) - (37.7 - 3)) < 0.5, `air guessed at ${idle(true)}`);
  // A liquid worked out from the die alone is too rough to say the case is warm.
  assert.ok(idle(false) <= 30);
});
