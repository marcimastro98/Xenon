// Airflow's safety layer (server/airflow/safety.js): every rule that stands between
// the brain and a fan. Each test pins one rule; tools/airflow-sim/safety-mutations.mjs
// breaks each rule once and checks a test here notices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSafety, FROZEN_MS, FROZEN_POWER_SWING_W } = require('../airflow/safety.js');
const L = require('../airflow/limits.js');

const CPU = 'AMD Ryzen 7 9700X';
const CPU_FULL = L.cpuFullAt(CPU);

const CHANNELS = Object.freeze([
  { id: 'rad1', kind: 'fan', hasTach: true, minDuty: 20, zeroOk: false, deps: ['cpu'] },
  { id: 'front1', kind: 'fan', hasTach: true, minDuty: 15, zeroOk: true, deps: ['cpu', 'gpu'] },
  { id: 'gpu1', kind: 'fan', hasTach: true, minDuty: 30, zeroOk: true, zeroByDefault: true, deps: ['gpu'] },
  { id: 'pump', kind: 'pump', hasTach: true, minDuty: 60, deps: ['cpu'] },
]);

// A safety layer on a hand-moved clock, fed like the loop feeds it.
function rig() {
  let now = 1000000;
  const safety = createSafety({ cpuName: CPU, clock: () => now });
  const rpm = { rad1: 800, front1: 600, gpu1: 1200, pump: 2400 };
  const s = {
    safety,
    rpm,
    temps: { cpu: 60, gpu: 50 },
    power: { cpu: 80, gpu: 200 },
    targets: { rad1: 40, front1: 35, gpu1: 45, pump: 70 },
    allowZero: false,
    planAt: now,
    get now() { return now; },
    advance(ms) { now += ms; },
    check(over = {}) {
      const temps = Object.fromEntries(Object.entries(over.temps ?? s.temps).map(([k, v]) => [k, v && typeof v === 'object' ? v : { value: v, at: now }]));
      const channels = (over.channels ?? CHANNELS).map((c) => ({ ...c, rpm: rpm[c.id] }));
      const plan = over.plan === null ? null : { at: over.planAt ?? s.planAt, targets: over.targets ?? s.targets, allowZero: over.allowZero ?? s.allowZero };
      return safety.check({ temps, power: over.power ?? s.power, channels, plan });
    },
    // One tick per second with a fresh plan, as the loop runs.
    run(seconds, over = {}) {
      let v = null;
      for (let i = 0; i < seconds; i += 1) { now += 1000; s.planAt = now; v = s.check(over); }
      return v;
    },
  };
  return s;
}

const duties = (v) => Object.fromEntries(Object.entries(v.channels).map(([id, c]) => [id, c.action === 'set' ? c.duty : c.action]));

test('a sound plan passes through untouched', () => {
  const r = rig();
  const v = r.check();
  assert.equal(v.mode, 'brain');
  assert.equal(v.why, null);
  assert.deepEqual(duties(v), { rad1: 40, front1: 35, gpu1: 45, pump: 70 });
  assert.ok(Object.values(v.channels).every((c) => c.write === true));
  assert.deepEqual(v.alerts, []);
  assert.deepEqual(v.untrusted, []);
});

test('rule 1: a component at its full temperature sends every channel to 100 %', () => {
  const r = rig();
  r.check();
  r.advance(1000);
  r.planAt = r.now;
  const v = r.check({ temps: { cpu: CPU_FULL, gpu: 50 } });
  assert.equal(v.mode, 'full');
  assert.equal(v.why, 'hot');
  assert.deepEqual(duties(v), { rad1: 100, front1: 100, gpu1: 100, pump: 100 });
});

test('rule 1: one degree under full is not an overheat', () => {
  const r = rig();
  const v = r.check({ temps: { cpu: CPU_FULL - 0.5, gpu: L.fullAt('gpu') - 0.5 } });
  assert.equal(v.mode, 'brain');
});

test('rule 1: full holds until every component is RESUME_BELOW cooler for RESUME_AFTER_MS', () => {
  const r = rig();
  r.run(1, { temps: { cpu: CPU_FULL + 1, gpu: 50 } });
  // Cooler, but not by RESUME_BELOW yet: stays full however long it lasts.
  assert.equal(r.run(120, { temps: { cpu: CPU_FULL - L.RESUME_BELOW + 1, gpu: 50 } }).mode, 'full');
  // Cool enough: full until RESUME_AFTER_MS has passed.
  const seconds = L.RESUME_AFTER_MS / 1000;
  assert.equal(r.run(seconds - 1, { temps: { cpu: CPU_FULL - L.RESUME_BELOW, gpu: 50 } }).mode, 'full');
  assert.equal(r.run(2, { temps: { cpu: CPU_FULL - L.RESUME_BELOW, gpu: 50 } }).mode, 'brain');
});

test('rule 1: a warm spell during the cool-down starts the wait again', () => {
  const r = rig();
  r.run(1, { temps: { cpu: CPU_FULL + 1, gpu: 50 } });
  r.run(50, { temps: { cpu: 60, gpu: 50 } });
  r.run(1, { temps: { cpu: CPU_FULL - 5, gpu: 50 } });
  assert.equal(r.run(50, { temps: { cpu: 60, gpu: 50 } }).mode, 'full');
  assert.equal(r.run(20, { temps: { cpu: 60, gpu: 50 } }).mode, 'brain');
});

test('rule 1: a GPU, GPU memory or liquid at full counts like the CPU', () => {
  for (const name of ['gpu', 'gpuMem', 'gpuHot', 'liquid']) {
    const r = rig();
    const v = r.check({ temps: { cpu: 60, gpu: 50, [name]: L.fullAt(name) } });
    assert.equal(v.mode, 'full', name);
  }
});

test('rule 1: overheat wins even with the brain silent', () => {
  const r = rig();
  const v = r.check({ plan: null, temps: { cpu: CPU_FULL + 2, gpu: 50 } });
  assert.equal(v.mode, 'full');
  assert.deepEqual(duties(v), { rad1: 100, front1: 100, gpu1: 100, pump: 100 });
});

test('rule 1: a reading that cannot be trusted does not force full', () => {
  const r = rig();
  const v = r.check({ temps: { cpu: 200, gpu: 50 } });
  assert.notEqual(v.mode, 'full');
  assert.deepEqual(v.untrusted, ['cpu']);
});

test('rule 2: no plan, or a plan older than LEASE_MS, hands every channel to the firmware', () => {
  const r = rig();
  const none = r.check({ plan: null });
  assert.equal(none.mode, 'firmware');
  assert.equal(none.why, 'brain');
  assert.deepEqual(duties(none), { rad1: 'firmware', front1: 'firmware', gpu1: 'firmware', pump: 'firmware' });
  const planAt = r.now;
  r.advance(L.LEASE_MS);
  assert.equal(r.check({ planAt }).mode, 'brain');
  r.advance(1);
  const old = r.check({ planAt });
  assert.equal(old.mode, 'firmware');
  assert.equal(old.channels.rad1.why, 'brain');
});

test('rule 2: a channel taken back from the firmware is written at once', () => {
  const r = rig();
  r.check();
  r.check({ plan: null });
  const v = r.check();
  assert.equal(v.channels.rad1.write, true);
  assert.equal(v.channels.rad1.duty, 40);
});

test('rule 3: a missing sensor hands only the channels that depend on it to the firmware', () => {
  const r = rig();
  r.check();
  const v = r.check({ temps: { cpu: 60 } });
  assert.deepEqual(duties(v), { rad1: 40, front1: 'firmware', gpu1: 'firmware', pump: 70 });
  assert.equal(v.channels.gpu1.why, 'sensor');
  assert.deepEqual(v.untrusted, ['gpu']);
});

test('rule 3: a stale reading is untrusted', () => {
  const r = rig();
  r.check();
  const at = r.now - L.STALE_MS - 1;
  const v = r.check({ temps: { cpu: { value: 60, at }, gpu: 50 } });
  assert.deepEqual(v.untrusted, ['cpu']);
  assert.equal(v.channels.rad1.action, 'firmware');
  assert.equal(r.check({ temps: { cpu: { value: 60, at: r.now - L.STALE_MS }, gpu: 50 } }).channels.rad1.action, 'set');
});

// The antivirus held the engine's read of the Windows service's readings for up to 7.6 s on
// a PC busy on every core (23 Nov 2026), while the service read them fresh and guarded the heat.
test('rule 3: a reading only late, that the hands guard, keeps the last speed up to LATE_OK_MS', () => {
  const r = rig();
  r.check();
  const late = (at) => ({ cpu: { value: 60, at, guarded: true }, gpu: 50 });
  const read = r.now;
  r.advance(L.STALE_MS + 1);
  const v = r.check({ temps: late(read), targets: { rad1: 90, front1: 90, gpu1: 90, pump: 90 }, planAt: r.now });
  assert.deepEqual(v.channels.rad1, { action: 'set', duty: 40, write: false }, 'the last speed, not the new plan');
  assert.deepEqual(v.channels.front1, { action: 'set', duty: 35, write: false });
  assert.equal(v.channels.gpu1.duty, 90, 'a channel on fresh sensors follows the plan');
  assert.deepEqual(v.untrusted, ['cpu'], 'the brain decides nothing on it');
  r.advance(L.LATE_OK_MS - L.STALE_MS - 1);
  assert.equal(r.check({ temps: late(read), planAt: r.now }).channels.rad1.duty, 40, 'still held at LATE_OK_MS');
  r.advance(1);
  assert.deepEqual(r.check({ temps: late(read), planAt: r.now }).channels.rad1, { action: 'firmware', why: 'sensor' }, 'past LATE_OK_MS: back to the firmware');
});

test('rule 3: a late reading nobody guards, or a channel never written, goes to the firmware', () => {
  const r = rig();
  r.check();
  const at = r.now;
  r.advance(L.STALE_MS + 1);
  assert.deepEqual(r.check({ temps: { cpu: { value: 60, at }, gpu: 50 }, planAt: r.now }).channels.rad1, { action: 'firmware', why: 'sensor' });
  const fresh = rig();
  fresh.advance(L.STALE_MS + 1);
  const v = fresh.check({ temps: { cpu: { value: 60, at: fresh.now - L.STALE_MS - 1, guarded: true }, gpu: 50 }, planAt: fresh.now });
  assert.deepEqual(v.channels.rad1, { action: 'firmware', why: 'sensor' }, 'no speed of its own to keep');
});

test('rule 1: a late reading can keep the fans at full, never end it', () => {
  const r = rig();
  const cool = CPU_FULL - L.RESUME_BELOW - 5;
  r.check({ temps: { cpu: CPU_FULL, gpu: 50 } });
  r.advance(1000);
  r.check({ temps: { cpu: cool, gpu: 50 } });
  r.advance(L.RESUME_AFTER_MS - L.STALE_MS - 2000);
  r.check({ temps: { cpu: cool, gpu: 50 } });
  const at = r.now;
  r.advance(L.STALE_MS + 2000);
  assert.equal(r.check({ temps: { cpu: { value: cool, at, guarded: true }, gpu: 50 } }).mode, 'full', 'not ended on a late reading');
  const hot = rig();
  hot.check();
  hot.advance(L.STALE_MS + 1);
  assert.equal(hot.check({ temps: { cpu: { value: CPU_FULL, at: hot.now - L.STALE_MS - 1, guarded: true }, gpu: 50 } }).mode, 'full', 'started on one');
});

test('rule 3: an absurd reading is untrusted', () => {
  for (const value of [L.SANE_TEMP.max + 1, L.SANE_TEMP.min - 1, Number.NaN, null]) {
    const r = rig();
    const v = r.check({ temps: { cpu: { value, at: r.now }, gpu: 50 } });
    assert.deepEqual(v.untrusted, ['cpu'], String(value));
    assert.equal(v.channels.rad1.action, 'firmware');
  }
});

test('rule 3: a die frozen while its power swings is untrusted', () => {
  const r = rig();
  const seconds = FROZEN_MS / 1000;
  let v = null;
  for (let i = 0; i <= seconds; i += 1) {
    v = r.run(1, { temps: { cpu: 61.125, gpu: 50 + (i % 3) }, power: { cpu: i % 2 ? 60 : 60 + FROZEN_POWER_SWING_W.cpu, gpu: 200 } });
    if (i < seconds) assert.deepEqual(v.untrusted, [], `second ${i}`);
  }
  assert.deepEqual(v.untrusted, ['cpu']);
  assert.equal(v.channels.rad1.action, 'firmware');
  // It moves again: trusted at once.
  assert.deepEqual(r.run(1, { temps: { cpu: 62, gpu: 50 } }).untrusted, []);
});

test('rule 3: a die steady under steady power is not frozen', () => {
  const r = rig();
  const v = r.run(FROZEN_MS / 1000 + 30, { temps: { cpu: 61.125, gpu: 50 }, power: { cpu: 60 + FROZEN_POWER_SWING_W.cpu - 1, gpu: 200 } });
  assert.deepEqual(v.untrusted, []);
});

test('rule 3: a GPU needs a larger power swing to count as frozen', () => {
  const r = rig();
  const swing = (i, w) => ({ cpu: 60, gpu: i % 2 ? 150 : 150 + w });
  let i = 0;
  let v = null;
  for (; i < FROZEN_MS / 1000 + 5; i += 1) v = r.run(1, { temps: { cpu: 60 + (i % 2), gpu: 55 }, power: swing(i, FROZEN_POWER_SWING_W.cpu) });
  assert.deepEqual(v.untrusted, []);
  for (let j = 0; j < 2; j += 1, i += 1) v = r.run(1, { temps: { cpu: 60 + (i % 2), gpu: 55 }, power: swing(i, FROZEN_POWER_SWING_W.gpu) });
  assert.deepEqual(v.untrusted, ['gpu']);
});

test('rule 3: a sensor that vanished after being seen stays untrusted', () => {
  const r = rig();
  r.check();
  for (let i = 0; i < 3; i += 1) {
    r.advance(1000);
    r.planAt = r.now;
    assert.deepEqual(r.check({ temps: { gpu: 50 } }).untrusted, ['cpu']);
  }
});

test('rule 3: a channel with no dependency listed follows every sensor seen', () => {
  const r = rig();
  const loose = [{ id: 'side', kind: 'fan', hasTach: true, minDuty: 10, zeroOk: true }];
  r.check({ channels: loose, targets: { side: 30 } });
  assert.equal(r.check({ channels: loose, targets: { side: 30 }, temps: { cpu: 60 } }).channels.side.action, 'firmware');
});

test('rule 3: a channel whose sensors were never seen is not driven', () => {
  const r = rig();
  const onLiquid = [{ id: 'rad', kind: 'fan', hasTach: true, minDuty: 20, deps: ['liquid'] }];
  const v = r.check({ channels: onLiquid, targets: { rad: 30 } });
  assert.equal(v.channels.rad.action, 'firmware');
  assert.equal(v.channels.rad.why, 'sensor');
});

test('rule 4: a fan at 0 RPM while asked to turn stalls after STALL_MS, with an alert', () => {
  const r = rig();
  r.rpm.front1 = 0;
  const seconds = L.STALL_MS / 1000;
  const before = r.run(seconds);
  assert.equal(before.channels.front1.action, 'set');
  const v = r.run(1);
  assert.equal(v.channels.front1.action, 'firmware');
  assert.equal(v.channels.front1.why, 'stall');
  assert.deepEqual(v.alerts, [{ code: 'stall', id: 'front1' }]);
  assert.deepEqual(r.safety.stalled(), ['front1']);
  // Spinning again is not enough: it waits for clear().
  r.rpm.front1 = 600;
  assert.equal(r.run(3).channels.front1.action, 'firmware');
  r.safety.clear('front1');
  assert.equal(r.run(1).channels.front1.action, 'set');
});

test('rule 4: even at its minimum duty a jammed fan is a stall', () => {
  const r = rig();
  r.rpm.front1 = 0;
  const v = r.run(L.STALL_MS / 1000 + 1, { targets: { ...r.targets, front1: 15 } });
  assert.equal(v.channels.front1.why, 'stall');
});

test('rule 4: a fan stopped on purpose is not a stall', () => {
  const r = rig();
  r.rpm.front1 = 0;
  const v = r.run(L.STALL_MS / 1000 + 5, { targets: { ...r.targets, front1: 0 }, allowZero: true });
  assert.equal(v.channels.front1.action, 'set');
  assert.equal(v.channels.front1.duty, 0);
  assert.deepEqual(v.alerts, []);
});

test('rule 4: a fan that spins again before STALL_MS starts the count again', () => {
  const r = rig();
  r.rpm.front1 = 0;
  r.run(L.STALL_MS / 1000 - 1);
  r.rpm.front1 = 400;
  r.run(1);
  r.rpm.front1 = 0;
  assert.equal(r.run(L.STALL_MS / 1000).channels.front1.action, 'set');
});

test('rule 4: a fan without a tachometer, or with no reading, never stalls', () => {
  const r = rig();
  const blind = CHANNELS.map((c) => (c.id === 'front1' ? { ...c, hasTach: false } : c));
  r.rpm.front1 = 0;
  assert.equal(r.run(L.STALL_MS / 1000 + 5, { channels: blind }).channels.front1.action, 'set');
  r.rpm.front1 = null;
  assert.equal(r.run(L.STALL_MS / 1000 + 5).channels.front1.action, 'set');
});

test('rule 5: values are clamped to the channel minimum and to 100', () => {
  const r = rig();
  const v = r.check({ targets: { rad1: -10, front1: 250, gpu1: 10, pump: Number.NaN } });
  assert.deepEqual(duties(v), { rad1: 20, front1: 100, gpu1: 30, pump: 100 });
});

test('rule 5: a missing target goes to 100, never to 0', () => {
  const r = rig();
  const v = r.check({ targets: {} });
  assert.deepEqual(duties(v), { rad1: 100, front1: 100, gpu1: 100, pump: 100 });
});

test('rule 5: a pump never goes below PUMP_FLOOR or its own minimum', () => {
  const r = rig();
  const low = [{ id: 'pump', kind: 'pump', hasTach: true, minDuty: 10, deps: ['cpu'] }];
  assert.equal(r.check({ channels: low, targets: { pump: 0 }, allowZero: true }).channels.pump.duty, L.PUMP_FLOOR);
  assert.equal(rig().check({ targets: { ...r.targets, pump: 0 }, allowZero: true }).channels.pump.duty, 60);
});

test('rule 5: 0 only for a fan that stops safely and is allowed to', () => {
  const zero = { rad1: 0, front1: 0, gpu1: 0, pump: 0 };
  // Not allowed: only the card's own zero-RPM fans stop.
  assert.deepEqual(duties(rig().check({ targets: zero })), { rad1: 20, front1: 15, gpu1: 0, pump: 60 });
  // Allowed: every fan that can stop does; a fan that can't keeps its minimum.
  assert.deepEqual(duties(rig().check({ targets: zero, allowZero: true })), { rad1: 20, front1: 0, gpu1: 0, pump: 60 });
  // zeroByDefault without zeroOk never stops.
  const odd = [{ id: 'x', kind: 'fan', hasTach: true, minDuty: 25, zeroOk: false, zeroByDefault: true, deps: ['gpu'] }];
  assert.equal(rig().check({ channels: odd, targets: { x: 0 }, allowZero: true }).channels.x.duty, 25);
});

test('rule 5: a fan with no minimum still never gets 0 unless it may stop', () => {
  const bare = [{ id: 'x', kind: 'fan', hasTach: true, deps: ['cpu'] }];
  assert.equal(rig().check({ channels: bare, targets: { x: 0 }, allowZero: true }).channels.x.duty, 1);
});

test('rule 5: at most one write per channel per WRITE_EVERY_MS, and none for the same value', () => {
  const r = rig();
  assert.equal(r.check().channels.rad1.write, true);
  r.advance(L.WRITE_EVERY_MS - 1);
  r.planAt = r.now;
  const soon = r.check({ targets: { ...r.targets, rad1: 60 } });
  assert.equal(soon.channels.rad1.write, false);
  assert.equal(soon.channels.rad1.duty, 40);
  r.advance(1);
  r.planAt = r.now;
  const later = r.check({ targets: { ...r.targets, rad1: 60 } });
  assert.equal(later.channels.rad1.write, true);
  assert.equal(later.channels.rad1.duty, 60);
  r.advance(5000);
  r.planAt = r.now;
  assert.equal(r.check({ targets: { ...r.targets, rad1: 60 } }).channels.rad1.write, false);
});

test('reset() forgets every state', () => {
  const r = rig();
  r.rpm.front1 = 0;
  r.run(L.STALL_MS / 1000 + 1);
  assert.deepEqual(r.safety.stalled(), ['front1']);
  r.run(1, { temps: { cpu: CPU_FULL + 1, gpu: 50 } });
  assert.equal(r.run(1).mode, 'full');
  r.safety.reset();
  r.rpm.front1 = 600;
  const v = r.run(1, { temps: { gpu: 50 } });
  assert.deepEqual(r.safety.stalled(), []);
  assert.deepEqual(v.untrusted, []);
  assert.equal(v.mode, 'brain');
});

test('no temperature ever read: every fan stays with the PC, none is driven blind', () => {
  const s = rig();
  const v = s.check({ temps: {} });
  for (const c of Object.values(v.channels)) assert.deepEqual(c, { action: 'firmware', why: 'sensor' });
});
