// Airflow's brain, the parts that move fans and read the moment: the smoother
// (server/airflow/brain-smooth.js), the context (brain-context.js), the reason
// codes (reasons.js) and the brain's own tick (brain.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../airflow/limits.js');
const { createSmoother, dutyFor, STOP_AFTER_MS } = require('../airflow/brain-smooth.js');
const { createContext, inNight, PREPARE_MS, LEARN_AFTER_MS } = require('../airflow/brain-context.js');
const { explain, spiked, PRIORITY } = require('../airflow/reasons.js');
const { createBrain } = require('../airflow/brain.js');
const { createLow, CREEP } = require('../airflow/brain-air.js');

const CURVE = [[20, 400], [40, 700], [60, 1000], [80, 1300], [100, 1500]];
const fan = (id, extra = {}) => ({ id, kind: 'fan', place: 'front', maxRpm: 1500, minFrac: 0.25, minDuty: 20, startDuty: 30, hasTach: true, controllable: true, curve: CURVE, ...extra });

// Steps a smoother once a second toward fixed targets; returns the last output.
function steps(sm, channels, fractions, seconds, from = 0, extra = {}) {
  let out = null;
  for (let i = 1; i <= seconds; i += 1) out = sm.step({ now: from + i * 1000, dtMs: 1000, channels, fractions, ...extra });
  return out;
}

test('smoother: duty comes from the fan\'s own curve', () => {
  const ch = fan('a');
  assert.equal(dutyFor(ch, 1000 / 1500), 60);
  assert.equal(dutyFor(ch, 850 / 1500), 50);
  assert.equal(dutyFor(ch, 0.1), 20);
  assert.equal(dutyFor(ch, 1.2), 100);
  assert.equal(dutyFor({ maxRpm: 1500 }, 0.4), 40);
});

test('smoother: rises gently, faster when heat is close, slower in calm moments', () => {
  const rise = (extra) => steps(createSmoother(), [fan('a', { startFrac: 0.3 })], { a: 0.9 }, 5, 0, extra).fractions.a;
  assert.ok(Math.abs(rise({}) - (0.3 + 5 * L.RATE.up)) < 1e-9);
  assert.ok(Math.abs(rise({ urgent: true }) - (0.3 + 5 * L.RATE.upUrgent)) < 1e-9);
  assert.ok(Math.abs(rise({ calm: true }) - (0.3 + 5 * L.RATE.up / 2)) < 1e-9);
});

test('smoother: falls slowly, only after the hold that follows a rise', () => {
  const sm = createSmoother();
  const ch = [fan('a', { startFrac: 0.5 })];
  steps(sm, ch, { a: 0.6 }, 5);
  const held = steps(sm, ch, { a: 0.3 }, L.RATE.holdAfterRiseMs / 1000 - 1, 5000);
  assert.ok(Math.abs(held.fractions.a - 0.6) < 1e-9, 'held');
  const down = steps(sm, ch, { a: 0.3 }, 10, 5000 + L.RATE.holdAfterRiseMs);
  assert.ok(down.fractions.a < 0.6 && down.fractions.a >= 0.6 - 10 * L.RATE.down - 1e-9);
});

test('smoother: small moves are not made, and a fall once started goes all the way', () => {
  const sm = createSmoother();
  const ch = [fan('a', { startFrac: 0.5 })];
  assert.equal(steps(sm, ch, { a: 0.5 + L.RATE.deadBand / 2 }, 5).fractions.a, 0.5);
  assert.equal(steps(sm, ch, { a: 0.5 - L.RATE.downBand / 2 }, 30, 5000).fractions.a, 0.5);
  steps(sm, ch, { a: 0.5 - L.RATE.downBand * 1.5 }, 1, 40000);
  const out = steps(sm, ch, { a: 0.5 - L.RATE.downBand * 1.5 }, 30, 41000);
  assert.ok(Math.abs(out.fractions.a - (0.5 - L.RATE.downBand * 1.5)) < 1e-9);
});

test('smoother: a fan stops only after a minute of not being needed, and restarts with a kick', () => {
  const sm = createSmoother();
  const ch = [fan('a', { startFrac: 0.25 })];
  const waiting = steps(sm, ch, { a: 0 }, STOP_AFTER_MS / 1000 - 1);
  assert.equal(waiting.fractions.a, 0.25);
  assert.ok(waiting.duties.a > 0);
  const stopped = steps(sm, ch, { a: 0 }, 2, STOP_AFTER_MS - 1000);
  assert.equal(stopped.duties.a, 0);
  // The push goes over the start duty the check found and holds while the tachometer
  // still reads 0 (a command and its reading each travel a second or two).
  const at = (ms, rpm) => sm.step({ now: STOP_AFTER_MS + ms, dtMs: 1000, channels: ch, fractions: { a: 0.25 }, measured: { a: rpm } });
  assert.equal(at(5000, 0).duties.a, 40, 'a push ten points over the start duty');
  assert.equal(at(8000, 0).duties.a, 40, 'still pushed while the tach reads 0');
  assert.ok(at(9000, 420).duties.a < 30, 'back to its target once it turns');
});

test('smoother: a restart push lasts its minimum even on a reading from the coast-down, and ends on its own', () => {
  const restart = (ch, rpmAt) => {
    const sm = createSmoother();
    steps(sm, ch, { a: 0 }, STOP_AFTER_MS / 1000 + 2);
    return (ms) => sm.step({ now: STOP_AFTER_MS + 2000 + ms, dtMs: 1000, channels: ch, fractions: { a: 0.25 }, measured: { a: rpmAt(ms) } }).duties.a;
  };
  const coasting = restart([fan('a', { startFrac: 0.25 })], () => 300);
  assert.deepEqual([1000, 2000].map(coasting), [40, 40], 'a turning reading this early may be the fan still coasting');
  const still = restart([fan('a', { startFrac: 0.25 })], () => 0);
  assert.deepEqual([1000, 4000, 5000, 6000].map(still).map((d) => d >= 40), [true, true, true, false], 'the push ends where the safety layer takes over');
  const blind = restart([fan('a', { startFrac: 0.25, hasTach: false })], () => undefined);
  assert.deepEqual([1000, 2000, 3000, 4000].map(blind).map((d) => d >= 40), [true, true, true, false], 'a fan without a tach is pushed for three seconds');
});

test('smoother: a fan left a hair over its floor when it is no longer needed still stops', () => {
  const sm = createSmoother();
  const ch = [fan('a', { startFrac: 0.6 })];
  // Down to just over the floor, inside the band where small moves are not made.
  steps(sm, ch, { a: 0.25 + 0.02 }, 120);
  const near = steps(sm, ch, { a: 0.25 }, 30, 120000);
  assert.ok(near.fractions.a > 0.25, 'the band leaves it over the floor, or this proves nothing');
  const out = steps(sm, ch, { a: 0 }, STOP_AFTER_MS / 1000 + 30, 150000);
  assert.equal(out.duties.a, 0);
});

test('smoother: a fan found stopped and not needed is never started', () => {
  const out = steps(createSmoother(), [fan('a', { startFrac: 0 })], { a: 0 }, 5);
  assert.equal(out.duties.a, 0);
});

test('smoother: a pump follows the liquid but never drops below its floor', () => {
  const pump = { id: 'p', kind: 'pump', controllable: true };
  const sm = createSmoother();
  assert.equal(sm.step({ now: 1000, dtMs: 1000, channels: [pump], fractions: {}, pumpFraction: 0.1 }).duties.p, L.PUMP_FLOOR);
  assert.equal(sm.step({ now: 2000, dtMs: 1000, channels: [pump], fractions: {}, pumpFraction: 0.8 }).duties.p, 80);
});

test('smoother: a beat group turns as one, trimmed on the tachometers', () => {
  const sm = createSmoother();
  const ch = [fan('a', { startFrac: 0.5 }), fan('b', { startFrac: 0.5 })];
  let out = null;
  // b reads 60 RPM slow at the same duty: its duty is trimmed up, a's stays.
  for (let i = 1; i <= 40; i += 1) {
    out = sm.step({ now: i * 1000, dtMs: 1000, channels: ch, fractions: { a: 0.5, b: 0.48 }, measured: { a: 750, b: 690 } });
  }
  assert.equal(out.fractions.a, out.fractions.b);
  assert.ok(out.duties.b > out.duties.a, JSON.stringify(out.duties));
});

// The planner prices fans for different components as separate groups; locked together
// here, a case fan planned at 99 % dragged three radiator fans planned at half to 91 %
// (a real PC after a restart, 23 Nov 2026).
test('smoother: fans the planner planned apart are not locked together, however alike', () => {
  const sm = createSmoother();
  const same = { maxRpm: 2000, startFrac: 0.4, curve: [[20, 400], [100, 2000]] };
  const ch = [fan('radA', { place: 'radiator', ...same }), fan('radB', { place: 'radiator', ...same }), fan('case', { place: 'rear', ...same })];
  const out = steps(sm, ch, { radA: 0.4, radB: 0.4, case: 0.9 }, 90);
  assert.ok(Math.abs(out.fractions.radA - 0.4) < 0.02 && out.fractions.radA === out.fractions.radB, JSON.stringify(out.fractions));
  assert.ok(out.fractions.case > 0.85, JSON.stringify(out.fractions));
});

test('smoother: the trim does not wind up against the floor', () => {
  const sm = createSmoother();
  const ch = [fan('a', { startFrac: 0.25 }), fan('b', { startFrac: 0.25 })];
  // Both read far too fast at their minimum: the trim cannot pull them lower.
  for (let i = 1; i <= 200; i += 1) sm.step({ now: i * 1000, dtMs: 1000, channels: ch, fractions: { a: 0.25, b: 0.25 }, measured: { a: 900, b: 900 } });
  const up = steps(sm, ch, { a: 0.6, b: 0.6 }, 20, 200000, { measured: {} });
  assert.ok(up.duties.a >= Math.round(dutyFor(ch[0], up.fractions.a)) - 1, JSON.stringify(up.duties));
});

test('context: night hours, overnight or not', () => {
  assert.equal(inNight({ on: true, from: 23, to: 7 }, 2), true);
  assert.equal(inNight({ on: true, from: 23, to: 7 }, 12), false);
  assert.equal(inNight({ on: true, from: 13, to: 15 }, 14), true);
  assert.equal(inNight({ on: true, from: 13, to: 15 }, 15), false);
  assert.equal(inNight({ on: false, from: 23, to: 7 }, 2), false);
  assert.equal(inNight({ on: true, from: 5, to: 5 }, 5), false);
  assert.equal(inNight({ on: true, from: '23', to: 7 }, 2), false);
});

test('context: a known game is prepared for at launch, then left to the readings', () => {
  const ctx = createContext({ memory: { 'game.exe': { cpu: 100, gpu: 300, n: 600 } } });
  ctx.update({ now: 1000, hour: 15, mode: 'balanced' });
  const launch = ctx.update({ now: 2000, hour: 15, mode: 'balanced', game: 'game.exe' });
  assert.deepEqual(launch.anticipate, { cpu: 80, gpu: 240 });
  assert.ok(launch.reasons.includes('game-prepare'));
  const later = ctx.update({ now: 2000 + PREPARE_MS, hour: 15, mode: 'balanced', game: 'game.exe' });
  assert.deepEqual(later.anticipate, {});
  assert.equal(createContext().update({ now: 1, hour: 15, game: 'new.exe' }).reasons.includes('game-prepare'), false);
});

test('context: a game\'s power is learned once loading is over', () => {
  const ctx = createContext();
  for (let t = 0; t <= LEARN_AFTER_MS + 3600000; t += 1000) ctx.update({ now: t, dtMs: 1000, hour: 15, game: 'new.exe', power: { cpu: 90, gpu: 250 } });
  const m = ctx.memory()['new.exe'];
  assert.ok(Math.abs(m.cpu - 90) < 1 && Math.abs(m.gpu - 250) < 1, JSON.stringify(m));
  ctx.forget('new.exe');
  assert.deepEqual(ctx.memory(), {});
});

test('context: broken memory entries and names are ignored', () => {
  const long = 'x'.repeat(121);
  const ctx = createContext({ memory: { ok: { cpu: 1, gpu: 2, n: 3 }, bad: { cpu: 'x', gpu: 1 }, [long]: { cpu: 1, gpu: 1 }, empty: null } });
  assert.deepEqual(Object.keys(ctx.memory()), ['ok']);
  assert.deepEqual(ctx.update({ now: 1, hour: 15, game: long }).anticipate, {});
});

test('context: calls and recordings go quieter and calmer unless turned off; night caps at quiet', () => {
  const ctx = createContext();
  const call = ctx.update({ now: 1, hour: 15, mode: 'balanced', call: true });
  assert.ok(Math.abs(call.bias - (L.MODES.balanced - 0.3)) < 1e-9);
  assert.equal(call.calm, true);
  assert.deepEqual(call.reasons, ['call-quiet']);
  assert.equal(ctx.update({ now: 2, hour: 15, mode: 'balanced', recording: true, options: { callQuiet: false } }).bias, L.MODES.balanced);
  const night = ctx.update({ now: 3, hour: 2, mode: 'cool', options: { night: { on: true, from: 23, to: 7 } } });
  assert.equal(night.bias, L.MODES.quiet);
  assert.deepEqual(night.reasons, ['night-quiet']);
});

test('reasons: the most important code leads', () => {
  const firmware = (why) => ({ action: 'firmware', why });
  assert.equal(explain({ safety: { mode: 'full', channels: {} }, plan: { binding: ['cpu'], impossible: [] } }).primary, 'hot');
  const stall = explain({ safety: { mode: 'brain', channels: { a: firmware('stall'), b: { action: 'set' } } }, context: { reasons: ['call-quiet'] } });
  assert.deepEqual(stall.all, ['stall', 'call-quiet']);
  assert.deepEqual(explain({ plan: { binding: ['gpu', 'cpu'], impossible: [] } }).all, ['heat-gpu', 'heat-cpu']);
  // The heat codes follow the binding, which brain.js orders by the source closest to its limit.
  assert.deepEqual(explain({ plan: { binding: ['cpu', 'gpu'], impossible: [] } }).all, ['heat-cpu', 'heat-gpu']);
  assert.equal(explain({ plan: { binding: ['cpu'], impossible: ['cpu'] } }).primary, 'impossible');
  assert.deepEqual(explain({}).all, ['idle']);
  assert.deepEqual(explain({ confidence: 0.1 }).all, ['learning', 'idle']);
  assert.deepEqual(explain({ confidence: 0.1, context: { reasons: ['call-quiet'] } }).all, ['call-quiet', 'learning']);
  assert.deepEqual(explain({ spike: true }).all, ['spike-ignored']);
  for (const code of explain({ safety: { mode: 'full', channels: { a: firmware('sensor') } }, spike: true, confidence: 0 }).all) assert.ok(PRIORITY.includes(code));
});

test('reasons: a die jump with the slow node still is a spike', () => {
  assert.equal(spiked([50, 52, 57], [40, 40.2, 40.4]), true);
  assert.equal(spiked([50, 52, 57], [40, 41, 42]), false);
  assert.equal(spiked([50, 52, 53], [40, 40, 40]), false);
  assert.equal(spiked([50], [40]), false);
});

const BRAIN_CHANNELS = [
  fan('rad1', { place: 'radiator', maxRpm: 2000, curve: [[20, 500], [100, 2000]] }),
  fan('front1', { zeroOk: true }),
  fan('gpu1', { place: 'gpu', maxRpm: 3000, zeroOk: true, zeroByDefault: true, minDuty: 30, curve: [[30, 900], [100, 3000]] }),
];
const snap = (at, { cpu = 50, gpu = 40, power = { cpu: 30, gpu: 20 }, rpm = { rad1: 800, front1: 600, gpu1: 0 } } = {}) => ({
  at, temps: { cpu: { value: cpu, at }, gpu: { value: gpu, at }, board: { value: 32, at } }, power, rpm, duty: {},
});

test('brain: holds the speeds the fans already turn at while it warms up', () => {
  const brain = createBrain({ channels: BRAIN_CHANNELS, cpuName: 'AMD Ryzen 7 9700X' });
  const out = brain.tick(snap(1000, { power: { cpu: 120, gpu: 20 } }), { mode: 'balanced', hour: 15 });
  assert.ok(Math.abs(out.fractions.rad1 - 800 / 2000) < 1e-9);
  assert.ok(Math.abs(out.fractions.front1 - 600 / 1500) < 1e-9);
  for (const key of ['duties', 'fractions', 'planned', 'targets', 'predicted', 'binding', 'impossible', 'urgent', 'contextReasons']) assert.ok(key in out, key);
});

test('brain: a load in its first seconds moves no fan until the warm-up ends', () => {
  const brain = createBrain({ channels: BRAIN_CHANNELS, cpuName: 'AMD Ryzen 7 9700X' });
  const busy = (t) => brain.tick(snap(t * 1000, { cpu: 72, power: { cpu: 140, gpu: 20 } }), { mode: 'balanced', hour: 15 });
  for (let t = 1; t <= 10; t += 1) {
    const out = busy(t);
    assert.ok(Math.abs(out.fractions.rad1 - 800 / 2000) < 1e-9, `second ${t}: ${out.fractions.rad1}`);
  }
  let after = 0;
  for (let t = 11; t <= 40; t += 1) after = busy(t).fractions.rad1;
  assert.ok(Math.abs(after - 800 / 2000) > 0.02, `the plan moves it once warmed up: ${after}`);
});

// A hub just taken has not read its tachs yet and reports the full speed its stand-in was
// told a second ago. Read as measured, that duty held the radiator at full for a minute
// after every restart while the hub ramped up to it (23 Nov 2026).
test('brain: a fan taken before its first tach reading starts where it really turns, not at the duty last written', () => {
  const brain = createBrain({ channels: BRAIN_CHANNELS, cpuName: 'AMD Ryzen 7 9700X' });
  const rpm = { rad1: 800, front1: 600, gpu1: 0 };
  let top = 0;
  for (let t = 1; t <= 60; t += 1) {
    const s = snap(t * 1000, { power: { cpu: 40, gpu: 20 } });
    const first = t === 1;
    const out = brain.tick({ ...s, rpm: first ? {} : { ...rpm }, duty: first ? { rad1: 100, front1: 100 } : {} }, { mode: 'balanced', hour: 15 });
    // The hub moves about 45 rpm a second toward what it is told.
    rpm.rad1 += Math.max(-45, Math.min(45, out.fractions.rad1 * 2000 - rpm.rad1));
    if (t > 1) top = Math.max(top, out.fractions.rad1);
  }
  assert.ok(top <= 800 / 2000 + 0.03, `the radiator went up to ${top.toFixed(2)} after the takeover`);
});

// A beat group turns at its fastest member's speed. While the engine restarted the BIOS
// ran the board's fan of the group at 95 %, and the group pulled the hub's fans up to it
// for a minute (23 Nov 2026).
test('brain: a beat group taken with its fans at different speeds starts at its slowest, once every fan in it is read', () => {
  const same = { maxRpm: 2000, minFrac: 0.14, curve: [[14, 280], [100, 2000]] };
  const channels = [fan('radA', { place: 'radiator', ...same }), fan('radB', { place: 'radiator', ...same }), fan('board', { place: 'radiator', ...same })];
  for (const blindTicks of [0, 2]) {
    const brain = createBrain({ channels, cpuName: 'AMD Ryzen 7 9700X' });
    const rpm = { radA: 760, radB: 760, board: 1900 };
    let topRad = 0;
    let boardAt = 1;
    for (let t = 1; t <= 40; t += 1) {
      const at = t * 1000;
      const seen = t <= blindTicks ? { board: rpm.board } : { ...rpm };
      const out = brain.tick({ at, temps: { cpu: { value: 50, at }, gpu: { value: 40, at }, board: { value: 30, at } }, power: { cpu: 30, gpu: 20 }, rpm: seen, duty: {} }, { mode: 'balanced', hour: 15 });
      // The hub moves about 45 rpm a second toward what it is told, the board's header faster.
      for (const [id, step] of [['radA', 45], ['radB', 45], ['board', 150]]) rpm[id] += Math.max(-step, Math.min(step, out.fractions[id] * 2000 - rpm[id]));
      topRad = Math.max(topRad, out.fractions.radA, out.fractions.radB);
      boardAt = out.fractions.board;
    }
    assert.ok(topRad <= 760 / 2000 + 0.03, `radiator pulled up to ${topRad.toFixed(2)} (blind for ${blindTicks})`);
    assert.ok(boardAt <= 760 / 2000 + 0.03, `the board's fan stayed at ${boardAt.toFixed(2)} (blind for ${blindTicks})`);
  }
});

test('brain: a fan the safety layer found jammed is planned as standing still, and the others take its share', () => {
  const channels = [fan('rad1', { place: 'radiator', maxRpm: 2000, curve: [[20, 500], [100, 2000]] }), fan('front1'), fan('front2', { maxRpm: 1400 })];
  const brain = createBrain({ channels, cpuName: 'AMD Ryzen 7 9700X' });
  const tick = (t, jam) => brain.tick({ at: t * 1000, temps: { cpu: { value: 72, at: t * 1000 }, gpu: { value: 72, at: t * 1000 }, board: { value: 30, at: t * 1000 } },
    power: { cpu: 90, gpu: 230 }, rpm: { rad1: 1000, front1: 700, front2: jam ? 0 : 650 }, duty: {} }, { mode: 'balanced', hour: 15, stalled: jam ? ['front2'] : [] });
  let before = null;
  for (let t = 1; t <= 40; t += 1) before = tick(t, false);
  assert.ok(before.planned.front2 > 0.4, 'the card must need the front fans, or this proves nothing');
  const after = tick(41, true);
  assert.ok(!('front2' in after.duties) && !('front2' in after.planned), 'a jammed fan is no longer driven nor counted on');
  assert.ok(after.planned.front1 > before.planned.front1 + 0.1, `front1 did not take its share: ${before.planned.front1} -> ${after.planned.front1}`);
});

test('brain: a reading the safety layer distrusts never feeds the model', () => {
  const brain = createBrain({ channels: BRAIN_CHANNELS, cpuName: 'AMD Ryzen 7 9700X' });
  for (let t = 1; t <= 30; t += 1) brain.tick(snap(t * 1000, { cpu: 99 }), { mode: 'balanced', hour: 15, untrusted: ['cpu'] });
  assert.equal(brain.slow().cpu.S, null);
  assert.notEqual(brain.slow().gpu.S, null);
});

test('brain: what it learned survives a restart', () => {
  const brain = createBrain({ channels: BRAIN_CHANNELS, cpuName: 'AMD Ryzen 7 9700X' });
  for (let t = 1; t <= 300; t += 1) {
    const P = Math.floor(t / 20) % 2 ? 110 : 40;
    brain.tick(snap(t * 1000, { cpu: 45 + 0.3 * P, power: { cpu: P, gpu: 20 } }), { mode: 'balanced', hour: 15 });
  }
  const saved = JSON.parse(JSON.stringify(brain.save()));
  const again = createBrain({ channels: BRAIN_CHANNELS, cpuName: 'AMD Ryzen 7 9700X', saved });
  assert.deepEqual(again.models.cpu.coefficients(), brain.models.cpu.coefficients());
});

// Without an air sensor the air is bounded under the coolest the liquid has been. Forgotten
// at every engine restart, it read as a working PC's liquid minus 3, and a case fan ran at
// 88 % for a minute after each restart (23 Nov 2026).
test('brain: the air it found survives a restart, and a stale one is forgotten', () => {
  const at = (t) => 1e12 + t * 1000;
  const reading = (t, liquid, P) => ({
    at: at(t), power: { cpu: P, gpu: 20 }, rpm: { rad1: 800, front1: 600, gpu1: 0 }, duty: {},
    temps: { cpu: { value: liquid + 0.3 * P, at: at(t) }, gpu: { value: 60, at: at(t) }, liquid: { value: liquid, at: at(t) } },
  });
  const ctx = { mode: 'balanced', hour: 15 };
  const brain = createBrain({ channels: BRAIN_CHANNELS, cpuName: 'AMD Ryzen 7 9700X' });
  let before = null;
  for (let t = 1; t <= 900; t += 1) before = brain.tick(reading(t, t <= 600 ? 33 : 41, t <= 600 ? 30 : 90), ctx);
  const saved = JSON.parse(JSON.stringify(brain.save()));
  const restart = (gapS, from) => {
    const b = createBrain({ channels: BRAIN_CHANNELS, cpuName: 'AMD Ryzen 7 9700X', saved: from });
    let out = null;
    for (let t = 1; t <= 30; t += 1) out = b.tick(reading(900 + gapS + t, 41, 90), ctx);
    return out;
  };
  const fresh = restart(15, undefined);
  const soon = restart(15, saved);
  assert.ok(Math.abs(soon.ambient - before.ambient) < 0.2 && soon.ambient < fresh.ambient - 3, `air ${soon.ambient} after a restart, ${before.ambient} before, ${fresh.ambient} fresh`);
  assert.ok(soon.planned.front1 <= before.planned.front1 + 0.05, `case fan planned ${soon.planned.front1} after a restart, ${before.planned.front1} before`);
  // Ten hours off: the liquid it once was says nothing of today's room.
  assert.ok(Math.abs(restart(36000, saved).ambient - fresh.ambient) < 0.2);
  // A broken save is a fresh start, never a crash.
  for (const air of [{ coolest: { v: 'x', at: 1 } }, { coolest: { v: 33 } }, 'x', null]) {
    assert.ok(Math.abs(restart(15, { ...saved, air }).ambient - fresh.ambient) < 0.2, JSON.stringify(air));
  }
});

// While the engine restarts the board takes its headers back and its curve runs them fast;
// a brain that started from that speed fell from it at 1 %/s for 80 s after every restart
// (a case fan from 38 % to 81 %, 23 Nov 2026).
test('brain: a restart of seconds resumes from the speeds it asked, never above what the fans turn at', () => {
  const ctx = { mode: 'balanced', hour: 15, driving: true };
  const brain = createBrain({ channels: BRAIN_CHANNELS, cpuName: 'AMD Ryzen 7 9700X' });
  let before = null;
  for (let t = 1; t <= 300; t += 1) before = brain.tick(snap(t * 1000, { rpm: { rad1: 600, front1: 450, gpu1: 0 } }), ctx);
  const saved = JSON.parse(JSON.stringify(brain.save()));
  const last = JSON.parse(JSON.stringify(brain.last()));
  // The board ran the case fan near full while the engine was down.
  const restart = (gapS, from, extra = {}) => {
    const b = createBrain({ channels: BRAIN_CHANNELS, cpuName: 'AMD Ryzen 7 9700X', saved, last: from });
    const outs = [];
    for (let t = 1; t <= 30; t += 1) outs.push(b.tick(snap((300 + gapS + t) * 1000, { rpm: { rad1: 600, front1: 1400, gpu1: 0 } }), { ...ctx, ...extra }));
    return outs;
  };
  const resumed = restart(12, last);
  const top = Math.max(...resumed.map((o) => o.fractions.front1));
  assert.ok(top <= before.fractions.front1 + 0.02, `case fan at ${top} after the restart, ${before.fractions.front1} before`);
  // Off for ten minutes, or watching before: a takeover like any other, where the fan turns.
  assert.ok(Math.abs(restart(600, last)[0].fractions.front1 - 1400 / 1500) < 0.02);
  const watched = createBrain({ channels: BRAIN_CHANNELS, cpuName: 'AMD Ryzen 7 9700X' });
  for (let t = 1; t <= 300; t += 1) watched.tick(snap(t * 1000, { rpm: { rad1: 600, front1: 450, gpu1: 0 } }), { ...ctx, driving: false });
  assert.equal(watched.last(), null);
  assert.ok(Math.abs(restart(12, watched.last())[0].fractions.front1 - 1400 / 1500) < 0.02);
  // A fan the board slowed starts where it turns: resuming never raises one.
  const slowed = createBrain({ channels: BRAIN_CHANNELS, cpuName: 'AMD Ryzen 7 9700X', saved, last });
  const first = slowed.tick(snap(313000, { rpm: { rad1: 600, front1: 380, gpu1: 0 } }), ctx);
  assert.ok(first.fractions.front1 <= 380 / 1500 + 1e-9, String(first.fractions.front1));
  for (const broken of [{ at: 'x' }, { at: 300000, out: { front1: 'x' } }, 'x', null]) {
    assert.ok(Math.abs(restart(12, broken)[0].fractions.front1 - 1400 / 1500) < 0.02, JSON.stringify(broken));
  }
  assert.equal('last' in saved, false, 'the speeds are kept apart from the learning');
});

test('brain-air: a low creeps up while unseen, and a save carries when it was seen', () => {
  const low = createLow(null);
  assert.equal(low.see(0, [NaN]), null);
  assert.equal(low.see(0, [36, 41]), 36);
  assert.ok(Math.abs(low.see(3600000, [41]) - (36 + CREEP * 3600000)) < 1e-9);
  const again = createLow(JSON.parse(JSON.stringify(low.save())));
  assert.ok(Math.abs(again.see(3600000, []) - low.see(3600000, [])) < 1e-9);
  // A clock set back never lowers it.
  assert.ok(again.see(0, []) >= 36);
});

// A warm-idling X3D shaped on a shadow recording of one (22 Nov 2026, the recording
// not kept): power wanders around 48 W with short bursts to 70-88 W, the die follows
// it about 1.5 s late, the AIO is run by another app and the board has no air sensor.
// Single power steps then measured R anywhere from 0.13 to 0.80, the slow node slid
// under the guessed air and the plan went to full speed on an idle PC.
function warmIdle(brain, seconds, seed = 5, rpm = {}) {
  let a = seed;
  const rng = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
  let liquid = 26;
  let die = 58;
  let burst = 0;
  let base = 48;
  const outs = [];
  for (let t = 1; t <= seconds; t += 1) {
    base = 48 + 0.8 * (base - 48) + (rng() - 0.5) * 12;
    if (burst <= 0 && rng() < 0.02) burst = 2 + Math.floor(rng() * 6);
    const P = burst-- > 0 ? 70 + rng() * 18 : base;
    liquid += (P - 7 * (liquid - 19)) / 1500;
    die += (liquid + 0.45 * P + 9 - die) * (1 - Math.exp(-1 / 1.5));
    const at = t * 1000;
    outs.push(brain.tick({
      at, power: { cpu: P, gpu: 30 + rng() * 9 }, duty: {},
      temps: { cpu: { value: Math.round(die / 0.125) * 0.125, at }, gpu: { value: 34 + rng(), at }, gpuMem: { value: 50, at } },
      rpm: { gpu1: 0, gpu2: 0, fan3: 1080, ...rpm },
    }, { mode: 'auto', slider: 50, hour: 18 }));
  }
  return outs;
}

test('brain: a warm-idling chip with a late die, jumpy power and no air sensor keeps its fans low', () => {
  const card = [
    { id: 'gpu1', kind: 'fan', place: 'gpu', maxRpm: 3750, minFrac: 0.3, zeroOk: true, zeroByDefault: true, hasTach: true, controllable: true, curve: [[30, 1125], [100, 3750]] },
    { id: 'gpu2', kind: 'fan', place: 'gpu', maxRpm: 3800, minFrac: 0.3, zeroOk: true, zeroByDefault: true, hasTach: true, controllable: true, curve: [[30, 1140], [100, 3800]] },
    { id: 'fan3', kind: 'fan', place: 'case', maxRpm: 2080, minFrac: 0.2, zeroOk: true, hasTach: true, controllable: true, curve: [[20, 430], [100, 2080]] },
  ];
  // The same chip as recorded (its AIO run by another app), then with a cooler fan
  // Xenon drives, whose guessed share is what the plan reaches for first. Low is not
  // enough: a fan heard going up again and again is the noise this test is about.
  const cooler = { id: 'cpu1', kind: 'fan', place: 'cpu', maxRpm: 2000, minFrac: 0.2, zeroOk: false, hasTach: true, controllable: true, curve: [[20, 400], [100, 2000]] };
  for (const [channels, rpm, cap] of [[card, {}, 0.4], [[...card, cooler], { cpu1: 700 }, 0.45]]) {
    const ids = channels.filter((c) => c.place !== 'gpu').map((c) => c.id);
    for (const seed of [3, 5, 7, 9, 11, 13, 17, 19]) {
      const outs = warmIdle(createBrain({ channels, cpuName: 'AMD Ryzen 7 9800X3D 8-Core Processor' }), 1500, seed, rpm).slice(120);
      const driven = Math.max(...outs.flatMap((o) => ids.map((id) => o.fractions[id])));
      assert.ok(driven <= cap, `seed ${seed}, ${channels.length} fans: driven up to ${driven} on an idle PC`);
      const climbed = Math.max(...ids.map((id) => outs.slice(1).reduce((s, o, i) => s + Math.max(0, o.fractions[id] - outs[i].fractions[id]), 0)));
      assert.ok(climbed <= 0.3, `seed ${seed}, ${channels.length} fans: a fan climbed ${climbed} in all on an idle PC`);
      assert.ok(outs.every((o) => !o.impossible.includes('cpu')), `seed ${seed}: the CPU called out of reach at idle`);
    }
  }
});
