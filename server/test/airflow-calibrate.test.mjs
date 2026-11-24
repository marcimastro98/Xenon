// Airflow's fan check (server/airflow/calibrate.js + calibrate-fit.js) on a pretend
// board (tools/airflow-sim/bench.mjs), through the real safety layer every tick as
// in the product: it pairs every control with the readings it really moves, finds
// the floor, the stop and the kick of each fan, leaves alone what it cannot drive,
// never trips the stall rule, and ends cleanly on every way out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createBench, defaultBench } from '../../tools/airflow-sim/bench.mjs';

const require = createRequire(import.meta.url);
const { createFanCheck, MAX_MS, NO_READING_MS, START_TRY_MS, SLOW_SETTLE_MAX_MS } = require('../airflow/calibrate.js');
const { createSettle, SETTLE } = require('../airflow/calibrate-settle.js');
const { fitChannel, pairDrops } = require('../airflow/calibrate-fit.js');
const { createSafety } = require('../airflow/safety.js');
const L = require('../airflow/limits.js');

const B = (n) => `lhm:board:control-${n}`;
const T = (n) => `lhm:board:fan-${n}`;
const GPU = 'lhm:gpu:control-1';

/**
 * The check as the engine will run it: reading -> check -> safety -> hands. Also
 * measures, with the board's own wiring, the longest time any fan read 0 while
 * asked to turn: the stall rule only sees the readings the check has paired.
 */
function runCheck(bench, { stopAt = Infinity, cancelAt = Infinity, frozenAt = Infinity } = {}) {
  const check = createFanCheck({ channels: bench.channels(), clock: bench.now });
  const safety = createSafety({ clock: bench.now });
  const alerts = [];
  const asked = [];
  const progress = [];
  const phases = [];
  const stillSince = new Map();
  let still = 0;
  let view = check.view();
  let last = null;
  while (!view.done && bench.now() < 15 * 60000) {
    if (bench.now() < frozenAt) last = bench.read();
    const reading = bench.now() < stopAt ? last : null;
    view = bench.now() >= cancelAt ? check.cancel() : check.step(reading);
    progress.push(view.progress);
    phases.push(view.phase);
    const v = safety.check({
      temps: { cpu: { value: 45, at: bench.now() } }, channels: check.safetyChannels(reading),
      plan: { at: bench.now(), targets: view.targets, allowZero: true },
    });
    alerts.push(...v.alerts);
    const duties = Object.fromEntries(Object.entries(v.channels).filter(([, x]) => x.action === 'set').map(([id, x]) => [id, x.duty]));
    asked.push(duties);
    for (const { id } of bench.channels()) {
      const stopped = bench.tachsOf(id).some((t) => reading?.tachs[t] === 0);
      if (!(duties[id] > 0) || !stopped) { stillSince.delete(id); continue; }
      if (!stillSince.has(id)) stillSince.set(id, bench.now());
      still = Math.max(still, bench.now() - stillSince.get(id));
    }
    bench.apply(duties);
    bench.advance(1000);
  }
  return { view, alerts, asked, progress, phases, still, seconds: bench.now() / 1000 };
}

const cache = new Map();
const standard = (latencyMs = 1500) => {
  if (!cache.has(latencyMs)) cache.set(latencyMs, runCheck(createBench(defaultBench(), { latencyMs })));
  return cache.get(latencyMs);
};

test('pairs each control with the readings it really moves', () => {
  const { view } = standard();
  assert.equal(view.why, null);
  const tachs = Object.fromEntries(Object.entries(view.result.calibs).map(([id, c]) => [id, c.tachs]));
  assert.deepEqual(tachs, {
    [B(1)]: [T(1)],
    [B(2)]: [T(3)],
    [B(3)]: [T(4), T(5)],
    [B(4)]: [T(6)],
    [B(5)]: [],
    [B(6)]: [T(8)],
    [GPU]: ['lhm:gpu:fan-1', 'lhm:gpu:fan-2'],
  }, 'a header reading elsewhere, a hub with two readings, a card with two fans on one control');
  const { asked, phases } = standard();
  const sweep = phases.indexOf('sweep');
  for (const id of [B(4), B(5)]) {
    assert.ok(id in asked[0] && asked.slice(sweep).every((d) => !(id in d)), `${id} is left to the PC once the check knows it cannot drive it`);
  }
  const all = Object.values(tachs).flat();
  assert.equal(new Set(all).size, all.length, 'no reading belongs to two controls');
  assert.ok(!all.includes(T(9)), 'a fan the BIOS slowed during the check is not taken for one of ours');
});

test('measures the floor, the stop and the kick of each fan', () => {
  const c = standard().view.result.calibs;
  assert.deepEqual([c[B(1)].minDuty, c[B(1)].startDuty, c[B(1)].zeroOk], [20, 25, true], 'stops at 10, flat below 20, starts from 22');
  assert.deepEqual([c[B(2)].minDuty, c[B(2)].startDuty, c[B(2)].zeroOk], [25, 25, false], 'never stops: its floor is where the speed stops falling');
  assert.deepEqual([c[B(3)].minDuty, c[B(3)].startDuty, c[B(3)].zeroOk], [25, 35, true], 'a hub: the first fan to stop and the last to start decide');
  assert.ok(Math.abs(c[B(1)].maxRpm - 1800) < 40);
  assert.ok(c[B(3)].maxRpm < 1215, 'a hub reads as its slower fan (1200 against 1250)');
  for (const cal of Object.values(c)) {
    for (let i = 1; i < cal.curve.length; i += 1) {
      assert.ok(cal.curve[i][0] > cal.curve[i - 1][0] && cal.curve[i][1] >= cal.curve[i - 1][1], 'duty rising, speed never falling');
    }
  }
});

test('leaves what it cannot drive to the PC, and says why', () => {
  const c = standard().view.result.calibs;
  assert.equal(c[B(4)].threePin, true, 'a 3-pin fan on a PWM header turns at full whatever the duty');
  assert.equal(c[B(5)].hasTach, false, 'nothing reads on an empty header');
  const pump = c[B(6)];
  assert.ok(pump.minDuty >= L.PUMP_FLOOR && pump.curve.every(([d]) => d >= L.PUMP_FLOOR) && !pump.zeroOk);
  assert.deepEqual([c[GPU].minDuty, c[GPU].zeroOk], [30, false], 'a card\'s own floor holds');
});

test('the check never trips the stall rule, never asks a pump or a card below its floor', () => {
  const { alerts, asked, seconds, progress, still } = standard();
  assert.deepEqual(alerts, []);
  assert.ok(still < L.STALL_MS, `no fan read 0 while asked to turn for ${still} ms`);
  for (const d of asked) {
    if (B(6) in d) assert.ok(d[B(6)] >= L.PUMP_FLOOR);
    if (GPU in d) assert.ok(d[GPU] >= 30);
    for (const v of Object.values(d)) assert.ok(v >= 0 && v <= 100);
  }
  assert.ok(seconds < 180, `about two minutes, not ${seconds} s`);
  assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]) && progress.at(-1) === 1, 'progress only goes forward');
});

test('the same answers whether the hands apply a duty quickly or slowly', () => {
  const pick = (r) => Object.fromEntries(Object.entries(r.view.result.calibs).map(([id, c]) => [id, [c.tachs, c.minDuty, c.startDuty, c.zeroOk, c.threePin]]));
  for (const latency of [300, 3500]) {
    const r = standard(latency);
    assert.deepEqual(r.alerts, []);
    assert.deepEqual(pick(r), pick(standard()), `latency ${latency} ms`);
  }
});

function oneControl(fans, extra = {}) {
  return { controls: [{ id: B(1), tach: T(1), fans, ...extra }], bios: [], biosDuty: () => 60 };
}
const fan = (extra) => ({ tach: T(1), maxRpm: 1500, floorRpm: 400, knee: 20, stopDuty: null, startDuty: 0, ...extra });

test('a fan that stops and will not start again is handed back and reported', () => {
  const spec = {
    controls: [
      { id: B(1), tach: T(1), fans: [fan({ stopDuty: 45, startDuty: 101 })] },
      { id: B(2), tach: T(2), fans: [fan({ tach: T(2), stopDuty: 10, startDuty: 95 })] },
    ],
    bios: [], biosDuty: () => 60,
  };
  const { view, alerts, asked, still } = runCheck(createBench(spec));
  assert.deepEqual(view.result.problems, { [B(1)]: 'no-start' });
  assert.ok(!(B(1) in view.result.calibs));
  assert.deepEqual([view.result.calibs[B(2)].startDuty, view.result.calibs[B(2)].zeroOk], [95, true]);
  assert.deepEqual(alerts, [], 'a rest at 0 between tries: the stall rule never sees one long try');
  assert.ok(still < L.STALL_MS);
  const full = asked.findLastIndex((d) => d[B(1)] === 100);
  assert.ok(full > 0, 'tried up to full power first');
  assert.ok(asked.slice(full + 1).every((d) => !(B(1) in d)) && asked.slice(full + 1).some((d) => B(2) in d),
    'back to the PC at once, while the other fan is still being tried');
});

test('a fan the pairing stopped that 80 % cannot restart keeps a safe floor', () => {
  const { view, alerts } = runCheck(createBench(oneControl([fan({ stopDuty: 55, startDuty: 85 })])));
  const c = view.result.calibs[B(1)];
  assert.deepEqual([c.tachs, c.minDuty, c.startDuty, c.zeroOk], [[T(1)], 85, 85, true]);
  assert.deepEqual(alerts, []);
});

test('a reading that vanishes mid-check: that fan is handed back, nothing kept', () => {
  const { view, alerts, asked } = runCheck(createBench(oneControl([fan({ goneAt: 40000 })])));
  assert.deepEqual(view.result, { calibs: {}, problems: { [B(1)]: 'no-speed' } });
  assert.deepEqual(alerts, []);
  assert.ok(asked.every((d) => !(B(1) in d) || d[B(1)] > 0), 'never left at 0 while unseen');
});

test('a jittery reading still settles, by time', () => {
  const { view, alerts } = runCheck(createBench(oneControl([fan({ jitter: 400 })])));
  assert.equal(view.why, null);
  assert.deepEqual(view.result.calibs[B(1)].tachs, [T(1)]);
  assert.deepEqual(alerts, []);
});

const withFan = (spec) => ({ ...spec, controls: [...spec.controls, { id: B(2), tach: T(2), fans: [fan({ tach: T(2), stopDuty: 10, startDuty: 22 })] }] });

test('a weak fan that stops at the pairing duty is paired at once and put back to full', () => {
  const { view, alerts, still } = runCheck(createBench(withFan(oneControl([fan({ stopDuty: 55, startDuty: 70 })])), { latencyMs: 3500 }));
  const c = view.result.calibs[B(1)];
  assert.deepEqual([c.tachs, c.minDuty, c.startDuty, c.zeroOk], [[T(1)], 65, 70, true]);
  assert.deepEqual(view.result.calibs[B(2)].tachs, [T(2)]);
  assert.deepEqual(alerts, []);
  assert.ok(still < L.STALL_MS, `stopped ${still} ms while asked, with slow hands`);
  const alone = runCheck(createBench(oneControl([fan({ stopDuty: 55, startDuty: 70 })]))).view.result.calibs[B(1)];
  assert.deepEqual([alone.minDuty, alone.startDuty], [65, 70], 'alone, it is still spinning up when the sweep begins: no stop counted yet');
});

test('a pump that stops is never left stopped nor saved', () => {
  const bench = createBench(withFan(oneControl([fan({ maxRpm: 2800, floorRpm: 1300, knee: 0, stopDuty: 52, startDuty: 60 })], { kind: 'pump' })));
  const { view, asked, alerts, still } = runCheck(bench);
  assert.deepEqual(view.result.problems, { [B(1)]: 'pump-stopped' });
  assert.ok(!(B(1) in view.result.calibs) && B(2) in view.result.calibs);
  assert.ok(still < L.STALL_MS);
  assert.deepEqual(alerts, [], 'put back to full the moment it stops');
  assert.ok(asked.every((d) => !(B(1) in d) || d[B(1)] >= L.PUMP_FLOOR));
});

test('every way out ends the check with nothing kept and every fan handed back', () => {
  const cancelled = runCheck(createBench(), { cancelAt: 30000 });
  assert.deepEqual([cancelled.view.why, cancelled.view.result, cancelled.view.targets], ['cancel', null, {}]);
  const silent = runCheck(createBench(), { stopAt: 20000 });
  assert.equal(silent.view.why, 'no-reading');
  assert.ok(silent.seconds * 1000 <= 20000 + NO_READING_MS + 2000);
  const frozen = runCheck(createBench(), { frozenAt: 20000 });
  assert.equal(frozen.view.why, 'no-reading', 'the same reading again is no reading');
  let t = 0;
  const check = createFanCheck({ channels: createBench().channels(), clock: () => t });
  t = MAX_MS + 1;
  assert.equal(check.step({ at: 1, tachs: {} }).why, 'timeout');
  assert.equal(check.cancel('hot').why, 'timeout', 'the first reason stands');
});

test('a try to start never outlasts the stall rule', () => {
  assert.ok(START_TRY_MS < L.STALL_MS);
});

test('channels: bad ids, repeats and floors out of range are cleaned', () => {
  const check = createFanCheck({
    channels: [{ id: B(1), floor: 250 }, { id: B(1) }, { id: '../x' }, null, { id: B(2), kind: 'pump', floor: -4, tach: 'BAD' }],
    clock: () => 0,
  });
  const v = check.view();
  assert.deepEqual(v.targets, { [B(1)]: 100, [B(2)]: 100 });
  assert.deepEqual(check.safetyChannels(null), [
    { id: B(1), kind: 'fan', rpm: null, hasTach: false, minDuty: 0, zeroOk: true, deps: [] },
    { id: B(2), kind: 'pump', rpm: null, hasTach: false, minDuty: 0, zeroOk: false, deps: [] },
  ], 'no stall rule on a reading not yet paired, never a rest for a pump');
});

test('fit: a reading that dropped by chance but ignores the sweep is not kept', () => {
  const sweep = {
    samples: [80, 60, 45, 35].map((duty) => ({ duty, tachs: { [T(1)]: 15 * duty, [T(9)]: 700 } })),
    stoppedAt: null, lowestTurning: 35,
  };
  const r = fitChannel({ ch: { id: B(1), tach: T(1) }, base: { [T(1)]: 1500, [T(9)]: 1200 }, claimed: [T(9), T(1)], pairedElsewhere: new Set(), sweep, startDuty: null, at: 1 });
  assert.deepEqual(r.calib.tachs, [T(1)]);
  const only = fitChannel({ ch: { id: B(1), tach: T(1) }, base: { [T(1)]: 0, [T(9)]: 1200 }, claimed: [T(9)], pairedElsewhere: new Set(), sweep, startDuty: null, at: 1 });
  assert.equal(only.calib.hasTach, false);
  const both = { ...sweep, samples: sweep.samples.map((x) => ({ ...x, tachs: { [T(1)]: 15 * x.duty, [T(2)]: 14 * x.duty } })) };
  const ordered = fitChannel({ ch: { id: B(1), tach: T(1) }, base: { [T(1)]: 1500, [T(2)]: 1400 }, claimed: [T(2), T(1)], pairedElsewhere: new Set(), sweep: both, startDuty: null, at: 1 });
  assert.deepEqual(ordered.calib.tachs, [T(1), T(2)], 'the reading on its own header first');
  assert.equal(ordered.calib.maxRpm, 1400, 'the slowest reading');
  const unread = fitChannel({ ch: { id: B(1), tach: T(1) }, base: {}, claimed: [T(1)], pairedElsewhere: new Set(), sweep, startDuty: null, at: 1 });
  assert.deepEqual(unread, { calib: null, problem: 'no-speed' });
  const card = fitChannel({ ch: { id: GPU, tach: null, floor: 40 }, base: { [T(1)]: 1500 }, claimed: [T(1)], pairedElsewhere: new Set(), sweep, startDuty: null, at: 1 });
  assert.equal(card.calib.minDuty, 40, 'the floor a control declares holds even where the fan would go lower');
});

test('pairDrops: only clear drops, from a turning fan, not already taken', () => {
  const taken = new Set([T(3)]);
  const got = pairDrops({ [T(1)]: 1000, [T(2)]: 1000, [T(3)]: 1000, [T(4)]: 40, [T(5)]: 1000 }, { [T(1)]: 600, [T(2)]: 900, [T(3)]: 100, [T(4)]: 0, [T(5)]: null }, taken);
  assert.deepEqual(got, [T(1)]);
  assert.ok(taken.has(T(1)));
});

test('settle: samples count only once the duty is applied, then once still', () => {
  const st = createSettle();
  const at = (t, rpm, duty) => st.record(t, { tachs: { [T(1)]: rpm }, duty: { [B(1)]: duty } }, { [B(1)]: 40 });
  st.change(0, [B(1)]);
  for (let t = 1000; t <= 4000; t += 1000) at(t, 900, 80);
  assert.equal(st.settled(4000, [T(1)]), false, 'readings from before the hands applied it do not count');
  for (let t = 5000; t <= 7000; t += 1000) at(t, 600, 40);
  assert.equal(st.settled(7000, [T(1)]), false, 'never sooner than minMs after it was applied');
  at(8000, 600, 40);
  assert.equal(st.settled(8000, [T(1)]), true);
  assert.deepEqual(st.snapshot([T(1)]), { [T(1)]: 600 });
  st.change(10000, [B(1)]);
  for (let t = 11000; t <= 15000; t += 1000) at(t, t % 2000 ? 500 : 650, 40);
  assert.equal(st.settled(15000, [T(1)]), false, 'still moving');
  assert.equal(st.settled(10000 + SETTLE.maxMs, [T(1)]), true, 'never later than maxMs');
  st.change(30000, [B(1)]);
  st.record(31000, { tachs: { [T(1)]: 1 } }, { [B(1)]: 40 });
  assert.equal(st.snapshot([T(1)])[T(1)], 1, 'a driver that does not report the duty is trusted');
});

test('a hub that ramps slowly (iCUE LINK): every channel paired with its own reading, top speeds whole', () => {
  const H = (n) => `link:hub:ch-${n}`;
  const R = (n) => `link:hub:rpm-${n}`;
  const slow = (n, extra) => ({ id: H(n), tach: R(n), settleMs: 40000, fans: [fan({ tach: R(n), rampRpmS: 45, ...extra })] });
  const spec = {
    controls: [
      { ...slow(2, { maxRpm: 2850, floorRpm: 1300, knee: 0 }), kind: 'pump' },
      slow(13, { maxRpm: 2120, floorRpm: 500 }),
      slow(14, { maxRpm: 2120, floorRpm: 500 }),
    ],
    bios: [], biosDuty: () => 60,
  };
  const { view, alerts, seconds } = runCheck(createBench(spec));
  assert.equal(view.why, null);
  assert.deepEqual(view.result.problems, {});
  for (const n of [2, 13, 14]) assert.deepEqual(view.result.calibs[H(n)].tachs, [R(n)]);
  assert.ok(Math.abs(view.result.calibs[H(2)].maxRpm - 2850) < 60, 'the pump reached its top before it was read');
  assert.ok(Math.abs(view.result.calibs[H(13)].maxRpm - 2120) < 60);
  assert.ok(view.result.calibs[H(2)].minDuty >= L.PUMP_FLOOR);
  assert.deepEqual(alerts, []);
  assert.ok(seconds * 1000 < MAX_MS, `done in ${seconds} s`);
});

test('settle: a reading still ramping one way is not settled, however small each step', () => {
  const st = createSettle();
  st.change(0, [B(1)], 30000);
  let rpm = 2850;
  for (let t = 1000; t <= 20000; t += 1000) {
    st.record(t, { tachs: { [T(1)]: (rpm -= 40) }, duty: { [B(1)]: 50 } }, { [B(1)]: 50 });
    assert.equal(st.settled(t, [T(1)]), false, `still falling at ${t / 1000} s`);
  }
  assert.equal(st.settled(SETTLE.maxMs + 1000, [T(1)]), false, 'a slow channel gets its own longer limit');
  assert.equal(st.settled(30000, [T(1)]), true);
  st.change(40000, [B(1)], 10 * 60000);
  assert.equal(st.settled(40000 + SLOW_SETTLE_MAX_MS, [T(1)]), false, 'the settle helper takes the limit it is given');
});

test('settle: a slow channel is judged over more readings, so a gentle ramp never passes for still', () => {
  const st = createSettle();
  st.change(0, [B(1)], 40000);
  let rpm = 2100;
  for (let t = 1000; t <= 12000; t += 1000) {
    st.record(t, { tachs: { [T(1)]: (rpm -= 20) }, duty: { [B(1)]: 50 } }, { [B(1)]: 50 });
    assert.equal(st.settled(t, [T(1)]), false, `20 rpm a second still falling at ${t / 1000} s`);
  }
  // Still readings with some noise: settled once there are enough of them.
  const noise = [12, -9, 4, -14, 8, 0, -6, 11, -3, 7];
  st.change(20000, [B(1)], 40000);
  noise.forEach((n, i) => {
    st.record(21000 + i * 1000, { tachs: { [T(1)]: 1680 + n }, duty: { [B(1)]: 50 } }, { [B(1)]: 50 });
    assert.equal(st.settled(21000 + i * 1000, [T(1)]), i === noise.length - 1, `${i + 1} readings`);
  });
  // A board fan still settles on three.
  st.change(40000, [B(1)], SETTLE.maxMs);
  for (let i = 0; i < 4; i += 1) st.record(41000 + i * 1000, { tachs: { [T(1)]: 900 } }, {});
  assert.equal(st.settled(44000, [T(1)]), true);
});

test('a long chain of slow fans gets the time it needs, not the fixed limit', () => {
  const H = (n) => `link:hub:ch-${n}`;
  const R = (n) => `link:hub:rpm-${n}`;
  const controls = [];
  for (let n = 1; n <= 14; n += 1) controls.push({ id: H(n), tach: R(n), settleMs: 40000, fans: [fan({ tach: R(n), rampRpmS: 45, maxRpm: 2120, floorRpm: 500 })] });
  const { view, alerts, seconds } = runCheck(createBench({ controls, bios: [], biosDuty: () => 60 }));
  assert.equal(view.why, null);
  assert.equal(Object.keys(view.result.calibs).length, 14);
  assert.deepEqual(alerts, []);
  assert.ok(seconds * 1000 > MAX_MS, `it took ${seconds} s, past the fixed limit`);
});

test('a slower hub: every speed of the curve is read once the fan got there, not on the way down', () => {
  const H = (n) => `link:hub:ch-${n}`;
  const R = (n) => `link:hub:rpm-${n}`;
  const shape = { maxRpm: 2120, floorRpm: 500, knee: 20 };
  const truth = (d) => (d <= shape.knee ? shape.floorRpm : shape.floorRpm + (shape.maxRpm - shape.floorRpm) * ((d - shape.knee) / (100 - shape.knee)) ** 1.1);
  // Half the measured hub's pace, from its profile's top speed: each 20-point step of the
  // sweep takes about 22 s, longer than a board fan's wait.
  const controls = [13, 14].map((n) => ({ id: H(n), tach: R(n), settleMs: 40000, fans: [fan({ tach: R(n), rampRpmS: 20, startRpm: shape.maxRpm, ...shape })] }));
  const { view } = runCheck(createBench({ controls, bios: [], biosDuty: () => 60 }));
  assert.equal(view.why, null);
  for (const n of [13, 14]) {
    const off = view.result.calibs[H(n)].curve.filter(([d]) => d > shape.knee).map(([d, rpm]) => Math.abs(rpm - truth(d)) / truth(d));
    assert.ok(off.length >= 4 && Math.max(...off) < 0.05, `curve read off by up to ${Math.round(Math.max(...off) * 100)} %`);
  }
});

test('a driver asking for an endless settle gets the longest one Xenon allows', () => {
  const id = 'link:hub:ch-13';
  const tach = 'link:hub:rpm-13';
  // A reading that crawls one way never settles: only the time limit ends each wait.
  const controls = [{ id, tach, settleMs: 3600000, fans: [fan({ tach, rampRpmS: 1, maxRpm: 2120, floorRpm: 500 })] }];
  const { view, seconds } = runCheck(createBench({ controls, bios: [], biosDuty: () => 60 }));
  assert.equal(view.done, true, 'the check ended on its own');
  assert.ok(seconds < 15 * 60, `done in ${seconds} s`);
});

test('settle: a board fan drifting one way within the spread is not settled yet', () => {
  const st = createSettle();
  st.change(0, [B(1)], SETTLE.maxMs);
  // Within 3 % of each other, but each one higher: still on its way.
  [1500, 1522, 1544].forEach((rpm, i) => st.record(4000 + i * 1000, { tachs: { [T(1)]: rpm } }, {}));
  assert.equal(st.settled(7000, [T(1)]), false);
  st.change(10000, [B(1)], SETTLE.maxMs);
  [1500, 1522, 1510].forEach((rpm, i) => st.record(14000 + i * 1000, { tachs: { [T(1)]: rpm } }, {}));
  assert.equal(st.settled(17000, [T(1)]), true, 'back and forth is noise');
});
