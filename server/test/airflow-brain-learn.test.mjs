// Airflow's brain, how it learns a PC it does not know: the moment the thermal
// model is held to (server/airflow/brain-model.js `remember`), R from power steps,
// what a saved model brings back, and what the brain (brain.js) says and corrects
// while it learns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createNodeModel, PRIORS } = require('../airflow/brain-model.js');
const { createBrain } = require('../airflow/brain.js');
const L = require('../airflow/limits.js');

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

// A CPU on a radiator: the slow node relaxes toward Ta + P / G, G grows with the fan.
// The clock and the slow node carry over between runs.
function pc({ R = 0.3, C = 1500, G0 = 1, k = 6, Ta = 30, S = 40, seed = 1 } = {}) {
  const rng = seeded(seed);
  let t = 0;
  const truth = { G0, k };
  return {
    truth,
    run(model, seconds, power, fractions = { a: 0.5 }) {
      for (let i = 0; i < seconds; i += 1, t += 1) {
        const P = power(t);
        const fr = typeof fractions === 'function' ? fractions(t) : fractions;
        const G = truth.G0 + truth.k * Object.values(fr).reduce((s, f) => s + f ** 0.8, 0);
        S += (P - G * (S - Ta)) / C;
        const die = Math.round((S + R * P + (rng() - 0.5) * 0.2) / 0.125) * 0.125;
        model.observe({ at: (t + 1) * 1000, die, power: P, ambient: Ta, fractions: fr });
      }
    },
  };
}
const toggle = (t) => (Math.floor(t / 30) % 2 ? 120 : 40);
const flat = (w) => () => w;
const model = () => createNodeModel({ node: 'cpu', channels: [{ id: 'a', place: 'radiator' }] });

test('model: R keeps its prior until five power steps agree', () => {
  const m = model();
  const p = pc();
  p.run(m, 130, toggle);
  assert.equal(m.state().R, PRIORS.cpu.R, 'four steps are not enough');
  p.run(m, 300, toggle);
  assert.ok(Math.abs(m.state().R - 0.3) < 0.02, String(m.state().R));
});

test('model: a PC that sits still holds the plan to the rise it shows', () => {
  const m = model();
  const p = pc({ k: 5 });
  p.run(m, 600, toggle);
  p.run(m, 1200, flat(100));
  assert.equal(m.state().calibrated, true);
  const truth = 100 / (1 + 5 * 0.5 ** 0.8);
  assert.ok(Math.abs(m.steady({ a: 0.5 }, 100, 30) - 30 - truth) < 1, `${m.steady({ a: 0.5 }, 100, 30) - 30} vs ${truth}`);
});

test('model: no moment is kept until the fans held still five minutes after a change', () => {
  const m = model();
  // A slow node that settles within a minute or two, so only the wait holds it back.
  const p = pc({ C: 150 });
  p.run(m, 600, toggle, (t) => ({ a: Math.floor(t / 60) % 2 ? 0.4 : 0.6 }));
  assert.equal(m.state().calibrated, false, 'fans that keep moving');
  p.run(m, 250, flat(100), { a: 0.5 });
  assert.equal(m.state().calibrated, false, 'settled heat, fans changed 250 s ago');
  p.run(m, 300, flat(100), { a: 0.5 });
  assert.equal(m.state().calibrated, true);
});

test('model: no moment is kept before R is measured', () => {
  const m = model();
  pc().run(m, 1800, flat(100));
  assert.equal(m.state().calibrated, false);
});

test('model: a moment a hair from the kept one leaves it; a PC that changed replaces it', () => {
  const m = model();
  const p = pc({ k: 5 });
  p.run(m, 600, toggle);
  p.run(m, 1200, flat(100));
  const kept = m.save().anchor;
  p.run(m, 600, flat(100));
  assert.deepEqual(m.save().anchor, kept, 'the same PC, the same moment');
  p.truth.k = 3;   // dust: the same fan moves less heat
  p.run(m, 1800, flat(100));
  assert.notDeepEqual(m.save().anchor, kept);
  // Within the band, plus the creep of a slow node still settling.
  const truth = 100 / (1 + 3 * 0.5 ** 0.8);
  assert.ok(Math.abs(m.steady({ a: 0.5 }, 100, 30) - 30 - truth) < 0.08 * truth, `${m.steady({ a: 0.5 }, 100, 30) - 30} vs ${truth}`);
});

test('model: the kept moment follows an R that moved since', () => {
  const m = model();
  const p = pc({ k: 5 });
  p.run(m, 600, toggle);
  p.run(m, 1200, flat(100));
  const saved = JSON.parse(JSON.stringify(m.save()));
  const same = model();
  const moved = model();
  assert.equal(same.load(saved), true);
  assert.equal(moved.load({ ...saved, Rs: saved.Rs + 0.1 }), true);
  // S = die - R P: an R 0.1 higher puts S, and the rise it showed, 0.1 P lower.
  const { rise, P } = saved.anchor;
  const want = same.state().cal * ((rise - 0.1 * P) / rise);
  assert.ok(Math.abs(moved.state().cal - want) < 0.01, `${moved.state().cal} vs ${want}`);
});

test('model: a saved moment and R come back; broken ones are dropped or clamped', () => {
  const m = model();
  const p = pc({ k: 5 });
  p.run(m, 600, toggle);
  p.run(m, 1200, flat(100));
  const saved = JSON.parse(JSON.stringify(m.save()));
  const copy = model();
  assert.equal(copy.load(saved), true);
  assert.equal(copy.state().calibrated, true);
  assert.equal(copy.state().cal, m.state().cal);
  for (const anchor of [{ ...saved.anchor, F: [0.5, 0.5] }, { ...saved.anchor, rise: -3 }, { ...saved.anchor, F: [2] }, 'x']) {
    const bad = model();
    bad.load({ ...saved, anchor });
    assert.equal(bad.state().calibrated, false, JSON.stringify(anchor));
  }
  const wild = model();
  wild.load({ ...saved, R: 9, Rs: 9, rSamples: [9, 9, 9, 9, 9, 9], anchor: { ...saved.anchor, R: 9 } });
  assert.ok(wild.save().R <= PRIORS.cpu.Rmax && wild.save().Rs <= PRIORS.cpu.Rmax && wild.save().anchor.R <= PRIORS.cpu.Rmax);
  pc({ S: 55 }).run(wild, 40, toggle);
  assert.ok(wild.state().R <= PRIORS.cpu.Rmax, `R ${wild.state().R} from saved samples out of range`);
});

test('model: fans left to the PC keep what was learned of the others; the kept moment is taken again', () => {
  const two = createNodeModel({ node: 'cpu', channels: [{ id: 'a', place: 'radiator' }, { id: 'b', place: 'case' }] });
  const p = pc({ k: 5 });
  p.run(two, 600, toggle, { a: 0.5, b: 0.3 });
  p.run(two, 1200, flat(100), { a: 0.5, b: 0.3 });
  const saved = JSON.parse(JSON.stringify(two.save()));
  assert.ok(saved.anchor && saved.rSamples.length >= 5, 'nothing learned to keep');
  // 'a' left to the PC, 'c' newly driven: the cooler still has a fan Xenon drives.
  const other = createNodeModel({ node: 'cpu', channels: [{ id: 'b', place: 'case' }, { id: 'c', place: 'radiator' }] });
  const prior = other.save().est.theta;
  assert.equal(other.load(saved), true);
  const th = other.save().est.theta;
  assert.deepEqual(th.slice(0, 3), [saved.est.theta[0], saved.est.theta[1], saved.est.theta[3]]);
  assert.equal(th[3], prior[3], 'a new fan starts from its prior');
  assert.equal(other.state().R, two.state().R);
  assert.equal(other.state().calibrated, false);
});

test('model: a cooler none of whose fans Xenon drives still cools, and is never learned away', () => {
  const seen = createNodeModel({ node: 'cpu', channels: [{ id: 'a', place: 'radiator' }, { id: 'b', place: 'case' }] });
  const hidden = createNodeModel({ node: 'cpu', channels: [{ id: 'b', place: 'case' }] });
  const b0 = (m) => m.coefficients().b0;
  assert.ok(b0(hidden) > b0(seen) * 5, `hidden cooler ${b0(hidden)} vs ${b0(seen)}`);
  // At idle the fans hold still and nothing tells the cooler's share from the case fan's.
  const prior = b0(hidden);
  pc({ k: 5 }).run(hidden, 1800, flat(45), { b: 0.3 });
  assert.ok(b0(hidden) >= prior * 0.5 - 1e-12, `learned down to ${b0(hidden)} of ${prior}`);
  assert.equal(hidden.save().hidden, true);
});

test('model: what was learned with the cooler counted the other way is dropped, R stays', () => {
  const two = createNodeModel({ node: 'cpu', channels: [{ id: 'a', place: 'radiator' }, { id: 'b', place: 'case' }] });
  const p = pc({ k: 5 });
  p.run(two, 600, toggle, { a: 0.5, b: 0.3 });
  const saved = JSON.parse(JSON.stringify(two.save()));
  // The radiator's fan left to the PC: the cooler is now hidden.
  const one = createNodeModel({ node: 'cpu', channels: [{ id: 'b', place: 'case' }] });
  const fresh = one.save().est.theta;
  assert.equal(one.load(saved), false);
  assert.deepEqual(one.save().est.theta, fresh);
  assert.equal(one.state().R, two.state().R);
  // A model saved before the cooler was counted at all reads as one that saw it.
  const old = { ...saved };
  delete old.hidden;
  assert.equal(createNodeModel({ node: 'cpu', channels: [{ id: 'a', place: 'radiator' }, { id: 'b', place: 'case' }] }).load(old), true);
  assert.equal(createNodeModel({ node: 'cpu', channels: [{ id: 'b', place: 'case' }] }).load(old), false);
});

const cardFan = (id) => ({ id, kind: 'fan', place: 'gpu', maxRpm: 3750, minFrac: 0.3, zeroOk: true, zeroByDefault: true, hasTach: true, controllable: true, curve: [[30, 1125], [100, 3750]] });
const caseFan = (id) => ({ id, kind: 'fan', place: 'case', maxRpm: 3700, minFrac: 0.25, zeroOk: false, hasTach: true, controllable: true, curve: [[25, 900], [100, 3700]] });
// A tower cooler's fan Xenon drives: the CPU's cooler is seen, nothing is hidden.
const towerFan = (id) => ({ id, kind: 'fan', place: 'cpu', maxRpm: 2000, minFrac: 0.2, zeroOk: false, hasTach: true, controllable: true, curve: [[20, 400], [100, 2000]] });
// Readings held still: the brain's own steps can be told apart from the PC's.
function still(brain, seconds, { cpu, gpu, gpuMem, power, rpm }, ctx = {}) {
  const outs = [];
  for (let t = 1; t <= seconds; t += 1) {
    const at = t * 1000;
    const temps = { cpu: { value: cpu, at }, gpu: { value: gpu, at }, ...(gpuMem ? { gpuMem: { value: gpuMem, at } } : {}) };
    outs.push(brain.tick({ at, temps, power, rpm, duty: {} }, { mode: 'balanced', hour: 15, ...ctx }));
  }
  return outs;
}

test('brain: "out of reach" is not said of a cool PC it is still learning', () => {
  // An AIO another app runs: no fan Xenon drives helps the CPU, so the priors see a
  // chip no airflow can hold. It idles 15 degrees under its target.
  const brain = createBrain({ channels: [cardFan('gpu1'), cardFan('gpu2')], cpuName: 'AMD Ryzen 7 9700X' });
  const outs = still(brain, 300, { cpu: 58, gpu: 35, power: { cpu: 45, gpu: 20 }, rpm: { gpu1: 0, gpu2: 0 } });
  assert.ok(outs.every((o) => !o.impossible.includes('cpu')), 'called out of reach while learning');
});

test('brain: a game that starts while it is still learning lets the card fans climb at once', () => {
  // The learning hold lets fans only slow down while a PC it does not know yet sits cool;
  // a game ends it on its power, long before the die comes near its target: a card that
  // warmed with its fans held cost degrees for the rest of the game.
  const brain = createBrain({ channels: [cardFan('gpu1'), cardFan('gpu2')], cpuName: 'AMD Ryzen 7 9700X' });
  const target = L.targetFor('gpu', 0.5);
  let gpu = 40;
  let rpm = 1125;
  const outs = [];
  for (let t = 1; t <= 150; t += 1) {
    const game = t > 60;
    if (game) gpu += 0.1;
    const at = t * 1000;
    const out = brain.tick({ at, temps: { cpu: { value: 50, at }, gpu: { value: gpu, at } }, power: { cpu: 40, gpu: game ? 250 : 25 }, rpm: { gpu1: rpm, gpu2: rpm }, duty: {} }, { mode: 'balanced', hour: 15 });
    rpm = Math.round(out.fractions.gpu1 * 3750);
    outs.push({ game, gpu, f: out.fractions.gpu1 });
  }
  const late = outs.filter((o) => o.game).slice(30);
  assert.ok(late.every((o) => o.gpu < target - 8), 'the die came near its target: the hold would end anyway');
  const top = Math.max(...late.map((o) => o.f));
  assert.ok(top > 0.5, `the card fans held at ${top.toFixed(2)}, where they turned at takeover, with a game running`);
});

test('brain: a card memory over its target makes the plan ask more of the card fans', () => {
  // The core sits under its target, the memory a degree and a half over: only the
  // memory says the model is wrong, and the plan has to grow until it obeys.
  const run = (gpuMem) => {
    const brain = createBrain({ channels: [cardFan('gpu1'), cardFan('gpu2')], cpuName: 'AMD Ryzen 7 9700X' });
    return still(brain, 90, { cpu: 50, gpu: 64, gpuMem, power: { cpu: 40, gpu: 150 }, rpm: { gpu1: 1500, gpu2: 1500 } }).map((o) => o.planned.gpu1);
  };
  const over = run(83.5);
  assert.ok(over[89] > over[14] + 0.15, `planned ${over[14]} at 15 s, ${over[89]} at 90 s`);
  const within = run(83);
  assert.ok(within[89] - within[14] < 0.01, 'a degree over is inside the band the correction leaves alone');
});

// A CPU on a cooler another app runs, under a load the priors cannot hold: the
// case fan is the only one Xenon has for it. `saved`: a model that learned it helps.
const busyCpu = (cpu, saved) => {
  const brain = createBrain({ channels: [caseFan('case1'), cardFan('gpu1'), cardFan('gpu2')], cpuName: 'AMD Ryzen 7 9700X', saved });
  return still(brain, 60, { cpu, gpu: 35, power: { cpu: 150, gpu: 20 }, rpm: { case1: 1800, gpu1: 0, gpu2: 0 } });
};

// A fit that learned the case fan helps a hidden cooler: half the cooler's prior
// share, a case fan worth more than ten times its own.
function learnedCase() {
  const fresh = createBrain({ channels: [caseFan('case1'), cardFan('gpu1'), cardFan('gpu2')], cpuName: 'AMD Ryzen 7 9700X' }).save();
  return { ...fresh, cpu: { ...fresh.cpu, est: { ...fresh.cpu.est, theta: [66.7, 43.4, 60, 0.67, 0.67] } } };
}

// A card whose fans never stopped while the brain watched it: the fit handed the
// card's own passive cooling to its fans and to the case fan (a real PC, 23 Nov 2026,
// where the case fan, allowed to stop, stopped and the idle card's fans took over).
function learnedCard() {
  const fresh = createBrain({ channels: [cardFan('gpu1'), cardFan('gpu2'), caseFan('case1')], cpuName: 'AMD Ryzen 7 9700X' }).save();
  // Settled after hours of it: the variances a hundredth of the priors'.
  const P = fresh.gpu.est.P.map((row, i) => row.map((x, j) => (i === j ? x / 100 : 0)));
  return { ...fresh, gpu: { ...fresh.gpu, est: { theta: [95, 4.1, 63, 64, 19], P, updates: 180 } } };
}

test('brain: an idle card keeps its fans stopped after a fit learned with them always on, and gets them under load', () => {
  const channels = [cardFan('gpu1'), cardFan('gpu2'), { ...caseFan('case1'), zeroOk: true }];
  const card = (gpu, power) => still(createBrain({ channels, cpuName: 'AMD Ryzen 7 9700X', saved: learnedCard() }), 120,
    { cpu: 50, gpu, power: { cpu: 45, gpu: power }, rpm: { gpu1: 0, gpu2: 0, case1: 0 } }, { allowZero: true }).at(-1).planned;
  const idle = card(34, 22);
  assert.deepEqual([idle.gpu1, idle.gpu2], [0, 0], 'a card at 34 C spins its fans');
  const busy = card(L.targetFor('gpu', 0.5) + 2, 250);
  assert.ok(busy.gpu1 >= 0.3 && busy.gpu2 >= 0.3, `a card over its target at ${busy.gpu1}`);
});

test('brain: a busy CPU never spins the card fans of an idle card', () => {
  const outs = busyCpu(86, learnedCase());
  assert.ok(outs.at(-1).planned.case1 > 0.5, `case fan ${outs.at(-1).planned.case1}: the CPU did ask for air`);
  assert.ok(outs.every((o) => o.planned.gpu1 === 0 && o.planned.gpu2 === 0), 'card fans bought for the CPU');
});

test('brain: "out of reach" only once the component sits at its target', () => {
  const target = L.targetFor('cpu', 0.5, 'AMD Ryzen 7 9700X');
  assert.ok(busyCpu(target - 3).every((o) => !o.impossible.includes('cpu')), 'said three degrees under the target');
  assert.ok(busyCpu(target + 1).at(-1).impossible.includes('cpu'), 'not said at the target');
});

test('brain: a CPU without power readings: its plain curve never reaches the card fans', () => {
  // With the cooler seen, the card fans' small share of the CPU passes the curve's size
  // test: only what they serve keeps them off it.
  const brain = createBrain({ channels: [towerFan('cpu1'), caseFan('case1'), cardFan('gpu1'), cardFan('gpu2')], cpuName: 'AMD Ryzen 7 9700X' });
  const outs = still(brain, 30, { cpu: L.targetFor('cpu', 0.5, 'AMD Ryzen 7 9700X'), gpu: 35, power: { gpu: 20 }, rpm: { cpu1: 1000, case1: 1800, gpu1: 0, gpu2: 0 } });
  assert.ok(outs.at(-1).planned.cpu1 > 0.9 && outs.at(-1).planned.case1 > 0.9, `${JSON.stringify(outs.at(-1).planned)}: the curve did ask`);
  assert.ok(outs.every((o) => o.planned.gpu1 === 0), 'card fans on the CPU curve');
});

test('brain: an idle PC it has not calibrated never hears a fan above the speed it found, however long', () => {
  // A PC that never sits still enough to calibrate, idling far under its targets,
  // with a fit from a load that overstates the heat: the guess asks the case fan for
  // more than the board ran it at, and fifteen minutes in that guess still must not
  // be heard (22 Nov 2026: once the hold ran out after 8 minutes, it was). The fit is
  // settled (variances a ten-thousandth of the priors'), so still readings correct it slowly.
  const channels = [towerFan('cpu1'), caseFan('case1'), cardFan('gpu1'), cardFan('gpu2')];
  const fresh = createBrain({ channels, cpuName: 'AMD Ryzen 7 9700X' }).save();
  const theta = fresh.cpu.est.theta.map((v, i) => (i === 0 ? v * 18 : v));
  const P = fresh.cpu.est.P.map((row, i) => row.map((x, j) => (i === j ? x / 1e4 : 0)));
  const brain = createBrain({ channels, cpuName: 'AMD Ryzen 7 9700X', saved: { ...fresh, cpu: { ...fresh.cpu, est: { theta, P, updates: 0 } } } });
  const outs = still(brain, 900, { cpu: 55, gpu: 51, power: { cpu: 44, gpu: 39 }, rpm: { cpu1: 900, case1: 1000, gpu1: 0, gpu2: 0 } });
  assert.ok(outs.at(-1).planned.cpu1 > 900 / 2000 + 0.05, 'the guess must still ask for more at the end, or this proves nothing');
  const loudest = Math.max(...outs.map((o) => o.fractions.cpu1));
  assert.ok(loudest <= 900 / 2000 + 1e-9, `ran at ${loudest}`);
  assert.ok(Math.max(...outs.map((o) => o.fractions.case1)) <= 1000 / 3700 + 1e-9, 'the case fan climbed');
});

// A CPU cooler's own fans move with the case fans, and without a board sensor the air is
// guessed from the liquid itself: the windows cannot always tell which of them cools. A
// 360 AIO's fans were learned down to 2 % of their prior and a case fan ran at 80 % in their
// place (25 Nov 2026). A cooler's fans keep COOLER_KEEP of their prior; a case fan that does
// nothing for the CPU can still be learned to almost nothing.
test('model: a cooler\'s own fan is never learned away; a case fan that does nothing is', () => {
  const channels = [{ id: 'rad', place: 'radiator' }, { id: 'case', place: 'case' }];
  for (const [cools, idle] of [['case', 'rad'], ['rad', 'case']]) {
    const m = createNodeModel({ node: 'cpu', channels });
    const prior = m.coefficients().b[idle];
    let S = 40;
    for (let t = 0; t < 7200; t += 1) {
      const fr = { [cools]: Math.floor(t / 90) % 2 ? 0.8 : 0.3, [idle]: Math.floor(t / 150) % 2 ? 0.9 : 0.2 };
      const P = toggle(t);
      S += (P - (1 + 8 * fr[cools] ** 0.8) * (S - 30)) / 1500;
      m.observe({ at: (t + 1) * 1000, die: S + 0.3 * P, power: P, ambient: 30, fractions: fr });
    }
    const kept = m.coefficients().b[idle] / prior;
    if (idle === 'rad') assert.ok(kept >= 0.15 - 1e-9 && kept < 0.3, `the radiator kept ${kept.toFixed(3)} of its prior`);
    else assert.ok(kept < 0.15, `the case fan kept ${kept.toFixed(3)} of its prior, no less than a cooler's`);
  }
});
