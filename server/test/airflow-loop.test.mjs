// Airflow's engine (server/airflow/loop.js) end to end on the pretend board
// (tools/airflow-sim/bench.mjs) through a fake driver: it never ticks switched off,
// watches without writing, drives only checked fans inside the safety layer, hands
// everything back when asked or stopped, and the fan check it runs is kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createBench, defaultBench } from '../../tools/airflow-sim/bench.mjs';
import { createFakeDriver } from '../../tools/airflow-sim/fake-driver.mjs';

const require = createRequire(import.meta.url);
const { createAirflowLoop, CHECK_WAIT_MS, SAVE_EVERY_MS, WAKE_MS, WAKE_RETRY_MS } = require('../airflow/loop.js');
const { createAirflowStore } = require('../airflow/store.js');
const Check = require('../airflow/loop-check.js');
const { mergePolls } = require('../airflow/sense.js');

const flush = async () => { for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r)); };
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return false;
}

// dataDir and bench: a second engine on the same disk and board, as after a restart.
// extra: more drivers after the fake one.
async function rig(t, { model = null, driver: driverOpts = {}, latencyMs = 1500, dataDir: shared = null, bench: board = null, onDriving, extra = [] } = {}) {
  const dataDir = shared ?? await fs.mkdtemp(path.join(os.tmpdir(), 'airflow-loop-'));
  const store = createAirflowStore({ dataDir });
  if (model) await store.update((m) => ({ ...m, ...model }));
  const bench = board ?? createBench(defaultBench(), { latencyMs });
  const driver = createFakeDriver(bench, driverOpts);
  const timers = {
    fn: null, started: 0, later: null,
    setInterval(fn) { this.fn = fn; this.started += 1; return { n: this.started }; }, clearInterval() { this.fn = null; },
    setTimeout(fn) { this.later = fn; return {}; }, clearTimeout() { this.later = null; },
  };
  const warnings = [];
  const loop = createAirflowLoop({
    drivers: [driver, ...extra], store, clock: bench.now, timers, situation: () => ({ hour: 14 }),
    warn: (m) => warnings.push(m), onDriving,
  });
  // The engine stops (and saves) before its folder goes.
  t.after(async () => { await loop.stop(); await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3 }); });
  /** Ticks once a second while the engine wants to; returns the seconds it ran. */
  async function run(seconds, each = () => {}) {
    let n = 0;
    for (; n < seconds && timers.fn; n += 1) {
      await timers.fn();
      each(loop.status(), n);
      bench.advance(1000);
    }
    return n;
  }
  return { store, bench, driver, timers, loop, run, warnings, dataDir };
}

const calls = (driver, name, from = 0) => driver.log.slice(from).filter((e) => e.call === name);

// The fans the check measured on the default board, kept for the tests that need checked fans.
let measured = null;
async function checkedFans(t) {
  if (measured) return measured;
  const r = await rig(t);
  await r.loop.start();
  assert.equal(r.loop.startCheck().ok, true);
  const seen = new Set();
  await r.run(15 * 60, (s) => seen.add(s?.state));
  const s = r.loop.status();
  measured = { fans: r.store.peek().fans, check: r.store.peek().check, ended: s.checkEnded, seen, ticking: r.timers.fn != null, log: r.driver.log };
  return measured;
}

test('loop: switched off it never ticks or writes; it reads the fans once for the menu', async (t) => {
  const { loop, timers, driver, bench } = await rig(t);
  await loop.start();
  loop.refresh();
  await flush();
  assert.equal(timers.started, 0);
  assert.deepEqual(driver.log.map((e) => e.call), ['clear'], 'only what a crash left is put back');
  const s = loop.status();
  assert.equal(s.state, 'off');
  assert.equal(s.fans.length, bench.channels().length, 'the fans are listed before anything is switched on');
  assert.ok(s.fans.every((f) => f.why === 'unchecked' && f.xenon === false));
});

test('loop: a PC with no driver never ticks and says why', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airflow-loop-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = createAirflowStore({ dataDir });
  await store.update((m) => ({ ...m, drive: 'on' }));
  const timers = { started: 0, setInterval() { this.started += 1; return { n: this.started }; }, clearInterval() {} };
  const loop = createAirflowLoop({ drivers: [], none: 'platform', store, timers, clock: () => 1000 });
  await loop.start();
  assert.equal(timers.started, 0);
  assert.deepEqual(loop.startCheck(), { ok: false, why: 'platform' });
  assert.equal(loop.status().state, 'unavailable');
  assert.deepEqual(loop.status().unavailable, { pc: 'platform' });
  await loop.stop();
});

test('loop: the fan check runs from the menu, is kept, and the engine rests after it', async (t) => {
  const m = await checkedFans(t);
  assert.equal(m.ended.ok, true, `ended ${JSON.stringify(m.ended)}`);
  assert.ok(m.seen.has('checking'));
  assert.equal(m.ticking, false, 'switched off, the engine stops once the check is over');
  for (const id of ['lhm:board:control-1', 'lhm:board:control-2', 'lhm:board:control-3']) {
    assert.ok(m.fans[id]?.calib?.maxRpm > 0, `${id} measured`);
    assert.ok(['case', 'cpu', 'gpu'].includes(m.fans[id].place), `${id} keeps the place the list guessed`);
  }
  assert.ok(m.check && Number.isFinite(m.check.at), 'the check time is kept for the menu');
  assert.equal(m.fans['lhm:board:control-5']?.calib?.hasTach, false, 'the empty header shows no speed: never driven');
  assert.equal(m.log.at(-1).call, 'release', 'every fan goes back to the PC at the end');
});

test('loop: watching computes a plan and keeps score but never writes a fan', async (t) => {
  const { fans } = await checkedFans(t);
  const { loop, run, driver, bench, store } = await rig(t, { model: { drive: 'shadow', fans } });
  await loop.start();
  await run(SAVE_EVERY_MS / 1000 + 5);
  assert.equal(calls(driver, 'apply').length, 0);
  assert.ok(calls(driver, 'hello').length > 0, 'the hands still hear from the engine');
  assert.equal(Object.values(bench.read().duty).every((d) => d === bench.read().duty['lhm:board:control-1']), true, 'every header still on the BIOS');
  const s = loop.status();
  assert.equal(s.state, 'watching');
  assert.ok(s.fans.some((f) => Number.isFinite(f.planned)), 'what Xenon would do is shown');
  assert.ok(s.fans.every((f) => f.xenon === false));
  assert.ok(s.shadow.minutes >= 4, `scored ${s.shadow.minutes} min`);
  const learned = await store.readLearned();
  assert.ok(learned.shadow?.seconds > 0, 'saved every few minutes, not only at the end');
  assert.deepEqual(learned.health.wear, {}, 'wear is learned only from what Xenon drove');
});

test("loop: watching, a fan the PC stopped is no stall of Xenon's", async (t) => {
  const { fans } = await checkedFans(t);
  const { loop, run, driver } = await rig(t, { model: { drive: 'shadow', fans } });
  driver.state.stopTachs = true;
  await loop.start();
  await run(30);
  const s = loop.status();
  assert.deepEqual(s.alerts, []);
  assert.ok(s.fans.every((f) => f.why !== 'stall'));
});

test('loop: driving writes only checked fans, inside the safety layer', async (t) => {
  const { fans } = await checkedFans(t);
  const { loop, run, driver } = await rig(t, { model: { drive: 'on', fans } });
  await loop.start();
  await run(120);
  const applies = calls(driver, 'apply');
  assert.ok(applies.length >= 100);
  const checked = new Set(Object.entries(fans).filter(([, f]) => f.calib).map(([id]) => id));
  for (const { verdicts } of applies) {
    for (const [id, v] of Object.entries(verdicts)) {
      assert.ok(checked.has(id), `${id} was never checked`);
      if (v.action === 'set') assert.ok(v.duty >= (fans[id].calib.zeroOk ? 0 : fans[id].calib.minDuty) && v.duty <= 100, `${id} at ${v.duty}`);
    }
  }
  const s = loop.status();
  assert.equal(s.state, 'driving');
  assert.ok(s.fans.some((f) => f.xenon));
  assert.equal(s.fans.find((f) => f.id === 'lhm:board:control-5').xenon, false);
  assert.equal(s.shadow.minutes, 0, 'the shadow score is kept only while watching');
});

test('loop: "leave it to the PC" hands the fans back once, then only says hello', async (t) => {
  const { fans } = await checkedFans(t);
  const { loop, run, driver, store } = await rig(t, { model: { drive: 'on', fans } });
  await loop.start();
  await run(20);
  await store.update((m) => ({ ...m, mode: 'pc' }));
  loop.refresh();
  const from = driver.log.length;
  await run(20);
  assert.equal(calls(driver, 'release', from).length, 1);
  assert.equal(calls(driver, 'apply', from).length, 0);
  assert.ok(calls(driver, 'hello', from).length >= 19);
  assert.equal(loop.status().state, 'pc');
});

test('loop: switching off hands every fan back and keeps what it learned', async (t) => {
  const { fans } = await checkedFans(t);
  const { loop, run, driver, store, timers } = await rig(t, { model: { drive: 'on', fans } });
  await loop.start();
  await run(30);
  await store.update((m) => ({ ...m, drive: 'off' }));
  loop.refresh();
  await flush();
  assert.equal(timers.fn, null);
  assert.equal(driver.log.at(-1).call, 'release');
  assert.ok(await waitFor(async () => { const l = await store.readLearned(); return l.brain && l.health && l.shadow; }), 'brain, health and shadow saved');
  assert.equal(loop.status().state, 'off');
});

// The engine moves up the CPU queue only while it holds the fans (index.js, priority.js): on a
// real PC a test run on every core starved the below-normal engine for three minutes and the
// fans went to the BIOS, loud (23 Nov 2026). So the loop says when it takes them and lets go.
test('loop: it says once when it takes the fans and once when it lets them go', async (t) => {
  const { fans } = await checkedFans(t);
  const held = [];
  const { loop, run, store } = await rig(t, { model: { drive: 'on', fans }, onDriving: (on) => held.push(on) });
  await loop.start();
  await run(10);
  assert.deepEqual(held, [true]);
  await store.update((m) => ({ ...m, mode: 'pc' }));
  loop.refresh();
  await run(5);
  assert.deepEqual(held, [true, false]);
  await store.update((m) => ({ ...m, mode: 'auto' }));
  loop.refresh();
  await run(5);
  await loop.stop();
  assert.deepEqual(held, [true, false, true, false]);
});

test('loop: watching never takes the fans, so the engine keeps its place', async (t) => {
  const { fans } = await checkedFans(t);
  const held = [];
  const { loop, run } = await rig(t, { model: { drive: 'shadow', fans }, onDriving: (on) => held.push(on) });
  await loop.start();
  await run(10);
  await loop.stop();
  assert.deepEqual(held, []);
});

// An update stops the engine by force, with no save on the way out, and the board runs its
// headers fast while it is down: the next engine started from that speed and fell from it at
// 1 %/s for over a minute (a real PC, 23 Nov 2026).
test('loop: an engine killed mid-run is resumed by the next one from the speeds it asked', async (t) => {
  const { fans } = await checkedFans(t);
  const a = await rig(t, { model: { drive: 'on', fans } });
  await a.loop.start();
  await a.run(200);
  const asked = calls(a.driver, 'apply').at(-1).verdicts;
  a.timers.fn = null;
  a.bench.apply({});
  a.bench.advance(12000);
  const b = await rig(t, { dataDir: a.dataDir, bench: a.bench });
  await b.loop.start();
  await b.run(3);
  const first = calls(b.driver, 'apply')[0].verdicts;
  const set = Object.keys(first).filter((id) => first[id].action === 'set' && asked[id]?.action === 'set' && asked[id].duty < 50);
  assert.ok(set.length >= 2, `fans to compare: ${JSON.stringify({ first, asked })}`);
  for (const id of set) assert.ok(first[id].duty <= asked[id].duty + 3, `${id} started at ${first[id].duty} %, asked ${asked[id].duty} % before the restart`);
});

test('loop: heat during the check ends it at once, nothing kept, full speed asked', async (t) => {
  const { loop, run, driver, store } = await rig(t);
  await loop.start();
  loop.startCheck();
  await run(20);
  driver.state.temps.cpu = 99;
  const from = driver.log.length;
  await run(3);
  const s = loop.status();
  assert.deepEqual({ ok: s.checkEnded.ok, why: s.checkEnded.why }, { ok: false, why: 'hot' });
  const hot = calls(driver, 'apply', from)[0];
  assert.ok(Object.values(hot.verdicts).length > 0 && Object.values(hot.verdicts).every((v) => v.action === 'set' && v.duty === 100));
  assert.equal(store.peek().check, null);
  assert.ok(Object.values(store.peek().fans).every((f) => !f.calib));
});

test('loop: a check with no fans to move waits a little, then says so', async (t) => {
  const { loop, run, timers } = await rig(t, { driver: { silent: true } });
  await loop.start();
  assert.deepEqual(loop.startCheck(), { ok: true, why: null });
  assert.deepEqual(loop.startCheck(), { ok: false, why: 'running' });
  const ran = await run(CHECK_WAIT_MS / 1000 + 5);
  assert.ok(ran <= CHECK_WAIT_MS / 1000 + 1, `stopped after ${ran} s`);
  assert.equal(timers.fn, null);
  assert.deepEqual({ ok: loop.status().checkEnded.ok, why: loop.status().checkEnded.why }, { ok: false, why: 'no-fans' });
});

test('loop: the check can be called off by the person', async (t) => {
  const { loop, run, store } = await rig(t);
  await loop.start();
  loop.startCheck();
  await run(10);
  loop.cancelCheck();
  await run(3);
  assert.equal(loop.status().checkEnded.why, 'cancel');
  assert.equal(store.peek().check, null);
});

test('loop: a driver that cannot run says why, and nothing is driven', async (t) => {
  const { loop, run, driver, store } = await rig(t, { driver: { available: { ok: false, why: 'no-service' } } });
  await loop.start();
  assert.equal(loop.status().state, 'unavailable', 'switched off, the menu still offers the fix');
  await store.update((m) => ({ ...m, drive: 'on' }));
  loop.refresh();
  await run(5);
  const s = loop.status();
  assert.equal(s.state, 'unavailable');
  assert.deepEqual(s.unavailable, { fake: 'no-service' });
  assert.equal(calls(driver, 'apply').length, 0);
});

// Updating the sensor service is one confirmation; on a real PC the board's fans then stayed
// with a loud BIOS for up to a minute, until the engine asked again (23 Nov 2026).
test('loop: a sensor service installed or updated is taken up within seconds, not a minute', async (t) => {
  for (const why of ['outdated', 'no-service']) {
    const { loop, run, driver, store } = await rig(t, { driver: { available: { ok: false, why } } });
    await store.update((m) => ({ ...m, drive: 'on' }));
    await loop.start();
    await run(10);
    assert.deepEqual(loop.status().unavailable, { fake: why });
    driver.state.available = { ok: true, why: null };
    let back = null;
    await run(70, (s, n) => { if (back == null && !s.unavailable?.fake) back = n; });
    assert.ok(back != null && back <= 6, `${why}: back after ${back} s`);
  }
});

// The Windows sensor service reads the fans only while asked: switched off, the menu
// opening must wake it, not call the PC unreachable (seen on a real PC, 22 Nov 2026).
async function lookAgain(timers, bench) {
  const again = timers.later;
  timers.later = null;
  bench.advance(WAKE_RETRY_MS);
  await again();
}

test('loop: switched off, a service that reads only when asked is woken by a hello', async (t) => {
  const { loop, driver, timers, bench } = await rig(t, { driver: { asleep: true } });
  await loop.start();
  assert.equal(loop.status().state, 'off', 'reachable while it wakes: the menu offers the fan check');
  assert.equal(loop.status().fans.length, 0);
  assert.equal(calls(driver, 'hello').length, 1);
  assert.equal(calls(driver, 'apply').length, 0, 'a hello holds no fan');
  assert.equal(timers.fn, null, 'switched off it still does not tick');
  await lookAgain(timers, bench);
  assert.equal(loop.status().state, 'off');
  assert.ok(loop.status().fans.length > 0, 'the next look reads the fans');
  assert.equal(timers.later, null, 'and looks no more');
});

test('loop: a service still silent after the hellos is unreachable, with no fix to offer', async (t) => {
  const { loop, timers, bench } = await rig(t, { driver: { silent: true } });
  await loop.start();
  assert.equal(loop.status().state, 'off');
  let looks = 0;
  for (; timers.later && looks < 50; looks += 1) await lookAgain(timers, bench);
  assert.ok(looks <= Math.ceil(WAKE_MS / WAKE_RETRY_MS), `${looks} looks`);
  assert.equal(loop.status().state, 'unavailable');
  assert.deepEqual(loop.status().unavailable, {});
});

test('loop: a driver that keeps failing is reported once, not every second', async (t) => {
  const { fans } = await checkedFans(t);
  const { loop, run, warnings } = await rig(t, { model: { drive: 'on', fans }, driver: { failApply: true } });
  await loop.start();
  await run(30);
  assert.equal(warnings.filter((w) => w.includes('did not answer')).length, 1);
});

test('loop: stopping hands every fan back and saves', async (t) => {
  const { fans } = await checkedFans(t);
  const { loop, run, driver, store, timers } = await rig(t, { model: { drive: 'on', fans } });
  await loop.start();
  await run(10);
  await loop.stop();
  assert.equal(timers.fn, null);
  assert.equal(driver.log.at(-1).call, 'release');
  assert.ok((await store.readLearned()).brain);
  loop.refresh();
  assert.equal(timers.fn, null, 'a stopped engine never starts again');
});

test('loop: a driver that stops answering while driving gets its fans back', async (t) => {
  const { fans } = await checkedFans(t);
  const { loop, run, driver } = await rig(t, { model: { drive: 'on', fans } });
  await loop.start();
  await run(10);
  driver.state.available = { ok: false, why: 'access' };
  const from = driver.log.length;
  await run(65);
  const released = driver.log.findIndex((e, i) => i >= from && e.call === 'release');
  assert.ok(released >= from, 'its fans went back');
  assert.equal(calls(driver, 'apply', released).length, 0, 'and it is not driven after');
  assert.deepEqual(loop.status().unavailable, { fake: 'access' });
});

// A busy PC held the service's heartbeat read for seconds (23 Nov 2026): the fans held keep
// getting a command every second while the minute's check is out.
test('loop: driving, a slow availability check never holds the commands', async (t) => {
  const { fans } = await checkedFans(t);
  const { loop, run, driver, timers, bench } = await rig(t, { model: { drive: 'on', fans } });
  await loop.start();
  await run(5);
  driver.available = () => new Promise((res) => { setTimeout(() => res({ ok: true, why: null }), 3000); });
  const from = driver.log.length;
  let slowest = 0;
  for (let i = 0; i < 64; i += 1) {
    const t0 = Date.now();
    await timers.fn();
    slowest = Math.max(slowest, Date.now() - t0);
    bench.advance(1000);
  }
  assert.ok(slowest < 1500, `a tick waited ${slowest} ms`);
  assert.equal(calls(driver, 'apply', from).length, 64, 'a command every second');
});

// A LINK hub waits up to 2 s a USB call, longer when libuv's pool is full (23 Nov 2026): the
// board's fans keep a command every second, the hub is never asked twice at once, and it
// is let go after the call it is busy with.
function stuckHub() {
  const hub = {
    id: 'hub', log: [], overlaps: 0, busy: false, channels: () => [], clear: async () => {},
    answer: { ok: true, why: null },
    available: async () => hub.answer,
    poll() {
      if (hub.busy) hub.overlaps += 1;
      hub.busy = true;
      hub.log.push('poll');
      return new Promise((res) => { setTimeout(() => { hub.busy = false; hub.log.push('poll done'); res(null); }, 1500); });
    },
    async apply() { if (hub.busy) hub.overlaps += 1; hub.log.push('apply'); },
    async hello() { if (hub.busy) hub.overlaps += 1; hub.log.push('hello'); },
    async release() { if (hub.busy) hub.overlaps += 1; hub.log.push('release'); },
  };
  return hub;
}

test("loop: driving, a hub stuck on USB never holds the board fans' commands", async (t) => {
  const { fans } = await checkedFans(t);
  const hub = stuckHub();
  const { loop, driver, timers, bench } = await rig(t, { model: { drive: 'on', fans }, extra: [hub] });
  await loop.start();
  const from = driver.log.length;
  let slowest = 0;
  for (let i = 0; i < 8; i += 1) {
    const t0 = Date.now();
    await timers.fn();
    slowest = Math.max(slowest, Date.now() - t0);
    bench.advance(1000);
  }
  assert.ok(slowest < 1200, `a tick waited ${slowest} ms`);
  assert.equal(calls(driver, 'apply', from).length, 8, 'a command every second');
  await loop.stop();
  assert.equal(hub.overlaps, 0, 'never two calls at once');
  assert.equal(hub.log.at(-1), 'release', 'let go last, after its call');
});

test('loop: letting go reaches a hub busy on USB, after its call', async (t) => {
  const { fans } = await checkedFans(t);
  for (const how of ['pc', 'unusable']) {
    const hub = stuckHub();
    const { loop, timers, bench, store } = await rig(t, { model: { drive: 'on', fans }, extra: [hub] });
    await loop.start();
    // A tick that finds the hub idle asks it again: it is then busy for the next one.
    const busyTick = async () => { await waitFor(() => !hub.busy); await timers.fn(); bench.advance(1000); };
    await busyTick();
    await busyTick();
    if (how === 'pc') { await store.update((m) => ({ ...m, mode: 'pc' })); loop.refresh(); }
    else { hub.answer = { ok: false, why: 'vendor-app' }; loop.recheck(); }
    assert.equal(hub.busy, true);
    await timers.fn();
    await waitFor(() => !hub.busy && hub.log.includes('release'));
    assert.ok(hub.log.includes('release'), `${how}: let go`);
    assert.equal(hub.overlaps, 0, `${how}: never during its call`);
    await loop.stop();
  }
});

test('loop: holding nothing yet, the first check is awaited, so the fans are taken at the first tick', async (t) => {
  const { fans } = await checkedFans(t);
  const { loop, run, driver } = await rig(t, { model: { drive: 'on', fans } });
  driver.available = () => new Promise((res) => { setTimeout(() => res({ ok: true, why: null }), 400); });
  await loop.start();
  await run(1);
  assert.equal(calls(driver, 'apply').length, 1);
});

test('loop: asked again at once after a choice or a check start, not a minute later', async (t) => {
  const { fans } = await checkedFans(t);
  const { loop, run, driver } = await rig(t, { model: { drive: 'on', fans } });
  await loop.start();
  await run(5);
  driver.state.available = { ok: false, why: 'link-off' };
  await run(2);
  assert.deepEqual(loop.status().unavailable, {}, 'without a reason to ask, the minute holds');
  loop.recheck();
  await run(1);
  assert.deepEqual(loop.status().unavailable, { fake: 'link-off' });
  driver.state.available = { ok: true, why: null };
  assert.equal(loop.checking(), false);
  loop.startCheck();
  assert.equal(loop.checking(), true);
  await run(1);
  assert.deepEqual(loop.status().unavailable, {});
});

test("loop: the hands' own guard or a lost sensor ends the check", async (t) => {
  for (const [why, spoil] of [['guard', (d) => { d.state.guard = 'guard'; }], ['sensor', (d) => { delete d.state.temps.cpu; }]]) {
    const { loop, run, driver, store } = await rig(t);
    await loop.start();
    loop.startCheck();
    await run(10);
    spoil(driver);
    await run(10);
    assert.equal(loop.status().checkEnded.why, why);
    assert.equal(store.peek().check, null);
  }
});

test('loop-check: the check moves what can be written, not what the person left to the PC', () => {
  const found = [
    { id: 'a:b:c-1', controllable: true, tach: 't1', min: 0, settleMs: 40000, beta: true },
    { id: 'a:b:c-2', controllable: true, tach: null, min: 30 },
    { id: 'a:b:c-3', controllable: false },
    { id: 'a:b:c-4', controllable: true },
  ];
  const model = { fans: { 'a:b:c-4': { leave: true } } };
  const channels = [{ id: 'a:b:c-2', kind: 'pump' }, { id: 'a:b:c-1', kind: 'fan' }];
  assert.deepEqual(Check.checkChannels(found, model, channels), [
    { id: 'a:b:c-1', kind: 'fan', tach: 't1', floor: 0, settleMs: 40000, beta: true },
    { id: 'a:b:c-2', kind: 'pump', tach: null, floor: 30, beta: false },
  ], 'a beta control tells the check, which then also proves it goes back');
});

test('loop-check: what is kept: new measurements, guessed places, problems cleared, the time', async () => {
  let model = { fans: { 'a:b:c-1': { place: 'front', calib: { old: true } }, 'a:b:c-3': { place: 'top', calib: { old: true } } }, check: null };
  const store = { update: async (step) => { model = step(model); return model; } };
  const channels = [{ id: 'a:b:c-1', place: 'front' }, { id: 'a:b:c-2', place: 'gpu' }, { id: 'a:b:c-3', place: 'top' }];
  await Check.keepResult(store, { calibs: { 'a:b:c-1': { n: 1 }, 'a:b:c-2': { n: 2 } }, problems: { 'a:b:c-3': 'no-start', 'a:b:c-9': 'no-speed' } }, channels, 5000);
  assert.deepEqual(model.fans, {
    'a:b:c-1': { place: 'front', calib: { n: 1 } },
    'a:b:c-2': { place: 'gpu', calib: { n: 2 } },
    'a:b:c-3': { place: 'top', calib: null },
  });
  assert.deepEqual(model.check, { at: 5000, problems: { 'a:b:c-3': 'no-start', 'a:b:c-9': 'no-speed' } });
});

test('sense: two drivers make one reading, the fresher temperature wins', () => {
  const d = (id, chans) => ({ id, channels: () => chans });
  const snap = mergePolls([d('x', [{ id: 'x:a:1' }]), d('y', [{ id: 'y:a:1' }]), d('z', [{ id: 'z:a:1' }])], [
    { at: 10, temps: { cpu: { value: 50, at: 10 }, gpu: { value: 40, at: 10 } }, power: { cpu: 30, gpu: -5 }, tachs: { t1: 900 }, duty: { 'x:a:1': 40 }, guard: 'hot' },
    { at: 12, temps: { cpu: { value: 55, at: 12 }, gpu: { value: 41, at: 8 }, bad: { value: NaN, at: 12 } }, power: {}, tachs: { t2: 0 }, duty: {}, guard: null },
    null,
  ], 20);
  assert.deepEqual(snap.temps, { cpu: { value: 55, at: 12 }, gpu: { value: 40, at: 10 } });
  assert.deepEqual(snap.power, { cpu: 30 });
  assert.deepEqual(snap.tachs, { t1: 900, t2: 0 });
  assert.deepEqual([snap.at, snap.readAt, snap.guard], [20, 12, 'hot']);
  assert.deepEqual(snap.answering, ['x', 'y']);
  assert.deepEqual(snap.found.map((x) => [x.id, x.driver]), [['x:a:1', 'x'], ['y:a:1', 'y']]);
});

test('loop: a tick that hangs hands the fans back instead of holding their last speed', async (t) => {
  const { fans } = await checkedFans(t);
  const { loop, run, driver, store, bench, timers, warnings } = await rig(t, { model: { drive: 'on', fans } });
  await loop.start();
  await run(20);
  let free;
  const hung = new Promise((ok) => { free = ok; });
  const real = { saveLast: store.saveLast, saveLearned: store.saveLearned };
  store.saveLast = () => hung;
  store.saveLearned = () => hung;
  try {
  // Ticks until one waits on the save that never ends.
  for (let i = 0; i < 400 && !warnings.some((w) => /hangs/.test(w)); i += 1) {
    timers.fn?.();
    await new Promise((ok) => setImmediate(ok));
    bench.advance(1000);
  }
  assert.ok(warnings.some((w) => /hangs/.test(w)), 'the hang is noticed');
  await waitFor(() => calls(driver, 'release').length > 0);
  } finally { Object.assign(store, real); free(); }
});
