// Bit's Vitals tools (server/vitals-ai-tools.js) and the math they share with
// the dashboard (js/vitals-core.js): what Bit reads is the bar on the screen,
// and a refill said to Bit writes what a tap writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../js/vitals-core.js');
const tools = require('../vitals-ai-tools.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const NOW = new Date(2026, 9, 30, 15, 0, 0).getTime();
const MIN = 60000;

function settings(over = {}) {
  return {
    vitals: {
      enabled: true,
      items: { hydration: { on: true, min: 45 }, energy: { on: true, min: 180 }, stamina: { on: true, min: 60 }, focus: { on: true, min: 25 }, posture: { on: false, min: 45 } },
      pet: { enabled: true, tone: 'spicy' },
      state: { last: { hydration: NOW - 45 * MIN, focus: NOW - 5 * MIN }, xp: 90, day: '2026-10-30', fills: 2, log: ['energy', 'focus'], mem: { streak: 3, bestStreak: 5, lastFillDay: '2026-10-29' }, pet: {} },
      ...over,
    },
  };
}

function rig(start = settings()) {
  let cur = start;
  const writes = [];
  return {
    deps: {
      read: () => cur,
      update: async (fn) => { const next = fn(cur); if (next) { cur = next; writes.push(next); } return cur; },
      now: () => NOW,
    },
    writes,
    get: () => cur,
  };
}

test('a meter is full when never refilled, empty after its interval, and in between on the way', () => {
  const v = settings().vitals;
  assert.equal(core.level(v, 'energy', NOW), 1);
  assert.equal(core.level(v, 'hydration', NOW), 0);
  assert.equal(core.level(v, 'focus', NOW), 0.8);
  assert.equal(Math.round(core.level({ items: { focus: { min: 1 } }, state: { last: { focus: NOW - 4 * MIN } } }, 'focus', NOW) * 100), 20, 'never shorter than 5 minutes');
});

test('get_vitals: the meters that are on, the level, today and the streak, and the pause', async () => {
  const r = rig(settings({ state: { ...settings().vitals.state, pet: { snoozeUntil: NOW + 10 * MIN } } }));
  const out = await tools.run('get_vitals', {}, r.deps);
  assert.deepEqual(out.meters.map((m) => m.id), ['hydration', 'energy', 'stamina', 'focus']);
  assert.deepEqual(out.meters.find((m) => m.id === 'focus'), { id: 'focus', percent: 80, everyMinutes: 25, emptyInMinutes: 20 });
  assert.equal(out.level, 1);
  assert.equal(out.refillsToday, 2);
  assert.equal(out.streakDays, 3);
  assert.deepEqual(out.pet, { on: true, tone: 'spicy', quietFrom: 23, quietTo: 7, snoozedMinutes: 10, quietToday: false });
  assert.equal(out.naturalBreaks, true);
});

test('refill_vital writes exactly what a tap writes, and the first refill of the day grows the streak', async () => {
  const r = rig();
  const out = await tools.run('refill_vital', { vital: 'hydration' }, r.deps);
  assert.equal(out.ok, true);
  assert.deepEqual(out.refilled, ['hydration']);
  assert.equal(out.levelUp, 2, '90 + 25 XP crosses level 2');
  const st = r.get().vitals.state;
  assert.equal(st.last.hydration, NOW);
  assert.equal(st.fills, 3);
  assert.deepEqual(st.log, ['energy', 'focus', 'hydration']);
  assert.deepEqual(st.mem, { streak: 4, bestStreak: 5, lastFillDay: '2026-10-30' });
  assert.equal(out.streakUp, 4);
  assert.deepEqual(core.refillPatch(settings().vitals, 'hydration', NOW).patch,
    { last: st.last, xp: 115, day: '2026-10-30', fills: 3, log: st.log, mem: st.mem }, 'the same patch the dashboard tap writes');
});

test('refill_vital "all" fills every meter that is on, and nothing that is off', async () => {
  const r = rig();
  const out = await tools.run('refill_vital', { vital: 'all' }, r.deps);
  assert.deepEqual(out.refilled, ['hydration', 'energy', 'stamina', 'focus']);
  assert.equal(r.get().vitals.state.last.posture, undefined);
  assert.equal(r.get().vitals.state.xp, 190);
});

test('refill_vital refuses an off meter, Vitals off, or a made-up one, and writes nothing', async () => {
  const r = rig();
  assert.equal((await tools.run('refill_vital', { vital: 'posture' }, r.deps)).error, 'vital_off');
  assert.equal((await tools.run('refill_vital', { vital: 'coffee' }, r.deps)).error, 'bad_args');
  const off = rig(settings({ enabled: false }));
  assert.equal((await tools.run('refill_vital', { vital: 'hydration' }, off.deps)).error, 'vitals_off');
  assert.equal(r.writes.length + off.writes.length, 0);
});

test('set_vitals: pet, meters, tone and the three pauses, each only when asked', async () => {
  const r = rig();
  await tools.run('set_vitals', { pause: 'snooze' }, r.deps);
  assert.equal(r.get().vitals.state.pet.snoozeUntil, NOW + 30 * MIN);
  await tools.run('set_vitals', { pause: 'today' }, r.deps);
  assert.equal(r.get().vitals.state.pet.muteDay, '2026-10-30');
  const resumed = await tools.run('set_vitals', { pause: 'resume' }, r.deps);
  assert.deepEqual([resumed.now.pet.snoozedMinutes, resumed.now.pet.quietToday], [0, false]);
  await tools.run('set_vitals', { pet: false, tone: 'soft' }, r.deps);
  assert.deepEqual([r.get().vitals.pet.enabled, r.get().vitals.pet.tone, r.get().vitals.enabled], [false, 'soft', true]);
  const before = r.writes.length;
  await tools.run('set_vitals', {}, r.deps);
  assert.equal(r.writes.length, before, 'nothing asked, nothing written');
  assert.equal((await tools.run('set_vitals', { tone: 'mean' }, r.deps)).error, 'bad_args');
  assert.equal((await tools.run('set_vitals', { pause: 'forever' }, r.deps)).error, 'bad_args');
});

test('set_vitals: the hours Bit sleeps and natural breaks, by voice', async () => {
  const r = rig(settings({ pet: { enabled: true, nightQuiet: false } }));
  assert.deepEqual([(await tools.run('get_vitals', {}, r.deps)).pet.quietFrom, (await tools.run('get_vitals', {}, r.deps)).naturalBreaks], [null, true]);
  const set = await tools.run('set_vitals', { quietFrom: 18, quietTo: 9, naturalBreaks: false }, r.deps);
  const pet = r.get().vitals.pet;
  assert.deepEqual([pet.quietFrom, pet.quietTo, pet.nightQuiet, r.get().vitals.naturalBreaks], [18, 9, true, false], 'choosing hours turns the quiet hours on');
  assert.deepEqual([set.now.pet.quietFrom, set.now.pet.quietTo, set.now.naturalBreaks], [18, 9, false]);
  const before = r.writes.length;
  for (const bad of [{ quietFrom: 24 }, { quietTo: -1 }, { quietFrom: 7.5 }, { quietTo: '9' }]) assert.equal((await tools.run('set_vitals', bad, r.deps)).error, 'bad_args', JSON.stringify(bad));
  assert.equal(r.writes.length, before, 'a wrong hour writes nothing');
});

test('wiring: Bit gets the three tools, the dashboard uses the same math, and lock_pc names no OS', () => {
  assert.deepEqual(tools.FUNCTIONS.map((f) => f.name), tools.NAMES);
  const server = read('../server.js');
  assert.match(server, /\.\.\.vitalsAiTools\.FUNCTIONS,/);
  assert.match(server, /vitalsAiTools\.NAMES\.includes\(fnName\)/);
  assert.doesNotMatch(server, /name: 'lock_pc', description: '[^']*Windows/);
  assert.match(read('../js/vitals.js'), /VitalsCore\.refillPatch\(v, id, Date\.now\(\)\)/);
  assert.match(read('../index.html'), /js\/vitals-core\.js"><\/script>\s*<script src="js\/vitals\.js"/);
});

test("the SDK vitals stream names each meter in the user's language and sends Bit's numbers", () => {
  const vitals = read('../js/vitals.js');
  assert.ok(vitals.includes('const snap = window.VitalsCore.snapshot(cfg(), effectiveNow());'));
  assert.ok(vitals.includes("snap.meters.map((m) => ({ ...m, name: t('vitals_' + m.id, m.id) }))"));
  assert.ok(vitals.includes('return { ok: true, ...snap, meters, away };'));
  assert.ok(read('../js/custom-widget.js').includes("vitals: Object.freeze({ ttl: 5000, load: async () => (window.VitalsWidget && typeof window.VitalsWidget.sdkSnapshot === 'function'"));
});

test('one missed day is forgiven: a refill two days later keeps the streak going', () => {
  const slip = settings({ state: { ...settings().vitals.state, mem: { streak: 6, bestStreak: 6, lastFillDay: '2026-10-28' } } }).vitals;
  const r = core.refillPatch(slip, 'focus', NOW);
  assert.deepEqual([r.patch.mem.streak, r.patch.mem.bestStreak, r.streakUp], [7, 7, 7]);
});

test('two missed days start the streak again, and a second refill the same day leaves it', () => {
  const gap = settings({ state: { ...settings().vitals.state, mem: { streak: 6, bestStreak: 6, lastFillDay: '2026-10-27' } } }).vitals;
  const r = core.refillPatch(gap, 'focus', NOW);
  assert.deepEqual([r.patch.mem.streak, r.patch.mem.bestStreak, r.streakUp], [1, 6, 0]);
  const again = core.refillPatch({ ...gap, state: { ...gap.state, ...r.patch } }, 'energy', NOW + MIN);
  assert.deepEqual([again.patch.mem.streak, again.streakUp, again.patch.fills], [1, 0, 4]);
});

test('time at the computer today: away time, a sleeping PC and yesterday do not count', () => {
  let a = core.activeStep(null, NOW, 0);
  assert.deepEqual(a, { day: '2026-10-30', ms: 0, at: NOW });
  a = core.activeStep(a, NOW + 5 * MIN, 0);
  assert.equal(a.ms, 5 * MIN, 'five minutes at the PC');
  a = core.activeStep(a, NOW + 7 * MIN, NOW + 6 * MIN);
  assert.equal(a.ms, 6 * MIN, 'only up to the freeze');
  a = core.activeStep(a, NOW + 9 * MIN, NOW + 6 * MIN);
  assert.equal(a.ms, 6 * MIN, 'nothing while still away');
  a = core.activeStep(a, NOW + 60 * MIN, 0);
  assert.equal(a.ms, 6 * MIN, 'a gap longer than any tick is a sleeping PC');
  const tomorrow = new Date(2026, 9, 31, 9, 0, 0).getTime();
  assert.deepEqual(core.activeStep(a, tomorrow, 0), { day: '2026-10-31', ms: 0, at: tomorrow });
  assert.match(read('../js/vitals.js'), /VitalsCore\.activeStep\(active, now, away \? freezeStart : 0\)/);
});
