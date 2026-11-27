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
const L = require('../airflow/limits.js');
const { createAir, WARM_PER_W, CREEP } = require('../airflow/brain-air.js');

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
// R x P over the liquid. `load` gives the CPU's power at each second, `card` the graphics
// card's: its heat warms the air the radiator breathes by CARD_WARM K a watt, over two minutes.
const idleLoad = (rng, st) => {
  if (st.burst <= 0 && rng() < 0.02) st.burst = 2 + Math.floor(rng() * 4);
  return st.burst-- > 0 ? 80 + rng() * 30 : 44 + rng() * 6;
};
const CARD_WARM = 6 / 185;
function warmCase(brain, seconds, seed, { load = idleLoad, R = 0.33, card = null } = {}) {
  let a = seed;
  const rng = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
  const frac = { pump: 0.93, rad1: 0.65, rad2: 0.65, rad3: 0.65, case1: 0.64, gpu1: 0 };
  let liquid = 37.7;
  let warm = 0;
  const st = { burst: 0 };
  const outs = [];
  for (let t = 1; t <= seconds; t += 1) {
    const P = load(rng, st);
    const Pg = card ? card(t, rng) : 40 + rng() * 5;
    if (card) warm += (CARD_WARM * (Pg - 36) - warm) / 120;
    const air = 4 + 5.8 * ['rad1', 'rad2', 'rad3'].reduce((s, id) => s + frac[id] ** 0.8, 0);
    liquid += (AIR + warm + P / air - liquid) / 300;
    const at = t * 1000;
    const out = brain.tick({
      at, power: { cpu: P, gpu: Pg }, duty: {},
      temps: { cpu: { value: Math.round((liquid + R * P) * 8) / 8, at }, gpu: { value: card ? Math.round(AIR + warm + 0.12 * Pg) : 43, at }, liquid: { value: Math.round(liquid * 10) / 10, at } },
      rpm: Object.fromEntries(CHANNELS.map((c) => [c.id, Math.round(frac[c.id] * c.maxRpm)])),
    }, { mode: 'auto', slider: 50, hour: 18 });
    for (const c of CHANNELS) if (Number.isFinite(out.fractions[c.id])) frac[c.id] = out.fractions[c.id];
    outs.push({ ...out, die: liquid + R * P, liquid, air: AIR + warm });
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

// A model held to a moment kept warm and early (a 16 K rise at 41 W, the fans low) and whose
// radiator fans look weak, as a real one learned: at a light load its liquid settles 3-4 K
// over the air, under a third of an X3D's R x P. Such a moment was taken only when derived
// through R, so no new one was ever kept on the real liquid and the plan held the radiator
// and a case fan at 80 % for good, the CPU at 60 C (25 Nov 2026).
// A model that learned its radiator as near useless (its fans move with the case fan, and the
// air is guessed from the liquid itself) and a moment kept warm and early held a radiator and a
// case fan at 80 % on a CPU at 60 C (25 Nov 2026).
test('brain: a radiator learned as near useless and a moment kept warm still let the fans come down at a light load', () => {
  const cpuName = 'AMD Ryzen 7 7800X3D 8-Core Processor';
  const light = (rng, st) => {
    if (st.burst <= 0 && rng() < 0.02) st.burst = 3 + Math.floor(rng() * 10);
    return st.burst-- > 0 ? 65 + rng() * 15 : 46 + rng() * 8;
  };
  for (const seed of [3, 7, 11]) {
    const first = createBrain({ channels: CHANNELS, cpuName });
    warmCase(first, 900, seed, { load: light, R: 0.49 });
    const saved = first.save();
    const { ids } = saved.cpu;
    const learned = { case1: 4.25, rad1: 0.93, rad2: 0.53, rad3: 0.53, gpu1: 0.67 };
    saved.cpu.est.theta = [13.55, 3.37, ...ids.map((id) => learned[id])];
    saved.cpu.anchor = { rise: 16.2, P: 41.3, F: ids.map((id) => (id === 'case1' ? 0.35 : id.startsWith('rad') ? 0.245 : 0)), R: 0.34 };
    const outs = warmCase(createBrain({ channels: CHANNELS, cpuName, saved }), 2700, seed + 50, { load: light, R: 0.49 }).slice(-900);
    const mean = (f) => outs.reduce((s, o) => s + f(o), 0) / outs.length;
    const rad = mean((o) => (o.fractions.rad1 + o.fractions.rad2 + o.fractions.rad3) / 3);
    const air = mean((o) => o.fractions.case1);
    assert.ok(rad <= 0.4 && air <= 0.4, `seed ${seed}: the radiator at ${rad.toFixed(2)}, the case fan at ${air.toFixed(2)} at a light load`);
    // ...and nothing gets warm for it: the liquid under the comfort the slider allows, and a
    // burst, which lifts the die by R x P within a second whatever the fans do, well short of
    // where the die is called hot.
    assert.ok(Math.max(...outs.map((o) => o.liquid)) < AIR + L.liquidRiseFor(0.5), `seed ${seed}: the liquid past its comfort`);
    assert.ok(Math.max(...outs.map((o) => o.die)) < L.fullAt('cpu', cpuName) - 2, `seed ${seed}: a burst took the die close to hot`);
  }
});

// A graphics card at 185 W (a browser drawing on it) warmed the case air the radiator breathes
// by about 6 K. With no board sensor the air was guessed from the coolest liquid seen and did not
// move: the liquid's comfort (air + what the slider allows) was out of reach, and a radiator
// learned as weak ran at 85-100 % on a CPU at 60-68 C (25 Nov 2026).
test('brain: a graphics card warming the case does not run the radiator up when no board reads the air', () => {
  const cpuName = 'AMD Ryzen 7 7800X3D 8-Core Processor';
  const light = (rng, st) => {
    if (st.burst <= 0 && rng() < 0.02) st.burst = 3 + Math.floor(rng() * 10);
    return st.burst-- > 0 ? 70 + rng() * 10 : 50 + rng() * 10;
  };
  const card = (t, rng) => (t > 900 ? 180 + rng() * 10 : 36);
  for (const seed of [3, 7, 11]) {
    const first = createBrain({ channels: CHANNELS, cpuName });
    warmCase(first, 900, seed, { load: light, R: 0.42 });
    const saved = first.save();
    const { ids } = saved.cpu;
    // Its radiator fans learned at the floor, as a real one did.
    const learned = { case1: 3.4, rad1: 4, rad2: 4, rad3: 4, gpu1: 0.62 };
    saved.cpu.est.theta = [21.9, 4.19, ...ids.map((id) => learned[id])];
    const outs = warmCase(createBrain({ channels: CHANNELS, cpuName, saved }), 2400, seed + 50, { load: light, R: 0.42, card }).slice(-1200);
    const rad = (o) => (o.fractions.rad1 + o.fractions.rad2 + o.fractions.rad3) / 3;
    const mean = outs.reduce((s, o) => s + rad(o), 0) / outs.length;
    const top = Math.max(...outs.map(rad));
    assert.ok(mean <= 0.6 && top <= 0.75, `seed ${seed}: the radiator at ${mean.toFixed(2)} on average, up to ${top.toFixed(2)}, for the card's heat`);
    // The guess followed the warmer air, from under it.
    const last = outs[outs.length - 1];
    assert.ok(last.ambient > last.air - 3 && last.ambient <= last.air + 0.5, `seed ${seed}: the air guessed at ${last.ambient.toFixed(1)}, ${last.air.toFixed(1)} real`);
    // A burst lifts the die by R x P within a second whatever the fans do: on average under its
    // target, and never close to where it is called hot.
    const die = outs.reduce((sum, o) => sum + o.die, 0) / outs.length;
    assert.ok(die < L.targetFor('cpu', 0.5, cpuName) && Math.max(...outs.map((o) => o.die)) < L.fullAt('cpu', cpuName) - 2, `seed ${seed}: the die got warm`);
  }
});

test("brain-air: a guessed air rises with the card's heat over its rest, never past the coolest slow node", () => {
  const run = (air, seconds, from, o) => {
    let out = null;
    for (let t = 1; t <= seconds; t += 1) out = air.update({ now: (from + t) * 1000, dt: 1000, board: null, liquid: true, ...o(t) });
    return out;
  };
  const air = createAir(null);
  const idle = run(air, 600, 0, () => ({ slows: [40, 55], cardPower: 36 }));
  assert.ok(Math.abs(idle.smooth - 37) < 0.01, `an idle card warms nothing: ${idle.smooth}`);
  // The card at 186 W with the liquid still where it was: the air cannot be warmer than it allows.
  assert.ok(Math.abs(run(air, 1200, 600, () => ({ slows: [40, 55], cardPower: 186 })).smooth - 37) < 0.01);
  // The liquid warmed with the case: the guess follows the card's 150 W over its rest (and the
  // coolest low, no longer seen, creeps up meanwhile).
  const warm = run(air, 1200, 1800, () => ({ slows: [48, 60], cardPower: 186 }));
  assert.ok(Math.abs(warm.smooth - (37 + CREEP * 1200000 + WARM_PER_W * 150)) < 0.05, `warmed to ${warm.smooth}`);
  assert.equal(warm.now, warm.smooth);
  // The card back at rest: the warmth goes with it, over minutes.
  const after = run(air, 900, 3000, () => ({ slows: [48, 60], cardPower: 36 }));
  assert.ok(after.smooth < 37 + CREEP * 2100000 + 0.2, `still ${after.smooth} after the card rested`);
  // The case air follows the card over minutes, not at once.
  const slow = createAir(null);
  run(slow, 600, 0, () => ({ slows: [40, 55], cardPower: 36 }));
  const minute = run(slow, 60, 600, () => ({ slows: [48, 60], cardPower: 186 }));
  assert.ok(minute.smooth - 37 < (WARM_PER_W * 150) / 2, `warmed to ${minute.smooth} in a minute`);
  // A board that reads the air is the air; a card with no power reading warms nothing.
  const board = createAir(null);
  run(board, 600, 0, () => ({ slows: [40, 55], cardPower: 36 }));
  assert.ok(Math.abs(run(board, 1200, 600, () => ({ slows: [48, 60], cardPower: 186, board: 33 })).smooth - 33) < 0.01);
  const blind = createAir(null);
  assert.ok(Math.abs(run(blind, 1200, 0, () => ({ slows: [48, 60], cardPower: null })).smooth - 45) < 0.01);
});
