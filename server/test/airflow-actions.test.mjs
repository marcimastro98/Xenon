// Airflow's actions (server/airflow/actions.js): the one rule set the menu, Bit, a Deck
// key and a paired phone all go through, on the real store in a throwaway folder and a
// stand-in engine. And the live event (live.js): told only when something drawn changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NOW, airflowView } from './airflow-view-fixture.mjs';

const require = createRequire(import.meta.url);
const { createAirflowActions, patched } = require('../airflow/actions.js');
const { createAirflowStore, FILE } = require('../airflow/store.js');
const { createAirflowLive, PROGRESS_STEP, MIN_GAP_MS } = require('../airflow/live.js');
const Model = require('../js/airflow/airflow-model.js');

const CALIB = { at: NOW - 1000, maxRpm: 1500 };

/** A stand-in engine: a status of a given age, the calls it got. */
function fakeLoop({ age = 0, startCheck = { ok: true }, cleaned = true } = {}) {
  const s = airflowView();
  const calls = [];
  return {
    calls,
    status: () => ({ ...s, at: NOW - age }),
    look: () => { calls.push('look'); return { ...s, at: NOW }; },
    refresh: () => calls.push('refresh'),
    startCheck: () => { calls.push('startCheck'); return startCheck; },
    cancelCheck: () => calls.push('cancelCheck'),
    cleaned: () => { calls.push('cleaned'); return cleaned; },
    relearn: async () => { calls.push('relearn'); },
  };
}

async function rig(t, { saved = null, loop = fakeLoop(), hubLights, lastRise } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xenon-airflow-actions-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createAirflowStore({ dataDir });
  if (saved) await store.update(() => saved);
  let started = 0;
  const actions = createAirflowActions({ store, loop, start: async () => { started++; }, clock: () => NOW, hubLights, lastRise });
  const run = (a) => actions.run(a);
  const set = (patch) => run({ type: 'airflowSet', patch: typeof patch === 'string' ? patch : JSON.stringify(patch) });
  const onDisk = async () => JSON.parse(await readFile(path.join(dataDir, FILE), 'utf8'));
  return { store, loop, actions, run, set, onDisk, started: () => started };
}

const checked = (over = {}) => ({ fans: { 'lhm:chip0:0': { calib: CALIB }, ...over } });

test('airflowGet: the engine status with each fan\'s own choices and the slider', async (t) => {
  const { run } = await rig(t, { saved: { ...checked({ 'lhm:chip0:1': { leave: true, calib: CALIB } }), slider: 70, check: { at: NOW, problems: { 'lhm:chip0:2': 'no-start' } } } });
  const out = await run({ type: 'airflowGet' });
  assert.equal(out.ok, true);
  assert.equal(out.state, 'driving');
  assert.equal(out.slider, 70);
  assert.deepEqual(out.options, { night: { on: false, from: 23, to: 7 }, callQuiet: true, allowZero: false, linkHub: false, riseAlert: true });
  const by = Object.fromEntries(out.fans.map((f) => [f.id, [f.checked, f.leave, f.problem]]));
  assert.deepEqual(by, {
    'lhm:chip0:0': [true, false, null], 'lhm:chip0:1': [true, true, null],
    'lhm:chip0:2': [false, false, 'no-start'], 'lhm:gpu0:0': [false, false, null],
  });
});

test('the view says why a held LINK hub shows no lights, null otherwise', async (t) => {
  assert.equal((await (await rig(t)).run({ type: 'airflowGet' })).hubLights, null);
  const dark = await rig(t, { hubLights: () => 'unknown-leds' });
  assert.equal((await dark.run({ type: 'airflowGet' })).hubLights, 'unknown-leds');
});

test('the view tells Bit the last climb of the fans and the program behind it', async (t) => {
  assert.equal((await (await rig(t)).run({ type: 'airflowGet' })).rise, null);
  const told = { reason: 'heat-cpu', from: 25, to: 45, at: NOW, app: { name: 'Blender', cpu: 40 } };
  const loud = await rig(t, { lastRise: () => told });
  assert.deepEqual((await loud.run({ type: 'airflowGet' })).rise, told);
});

test('a status older than two seconds is read again, a fresh one is used as it is', async (t) => {
  const fresh = await rig(t, { loop: fakeLoop({ age: 500 }) });
  await fresh.run({ type: 'airflowGet' });
  assert.deepEqual(fresh.loop.calls, []);
  const stale = await rig(t, { loop: fakeLoop({ age: 2500 }) });
  await stale.run({ type: 'airflowGet' });
  assert.deepEqual(stale.loop.calls, ['look']);
  assert.ok(stale.started() >= 1, 'the engine is started before it is asked');
});

test('airflowMode: refused while Airflow is off, kept while it watches or drives', async (t) => {
  const off = await rig(t);
  assert.deepEqual(await off.run({ type: 'airflowMode', mode: 'quiet' }), { ok: false, error: 'airflow_off' });
  assert.equal((await off.store.ready()).mode, 'auto', 'nothing stored unseen');

  const on = await rig(t, { saved: { ...checked(), drive: 'on' } });
  assert.deepEqual(await on.run({ type: 'airflowMode', mode: 'quiet' }), { ok: true, mode: 'quiet' });
  assert.equal((await on.onDisk()).mode, 'quiet');
  assert.deepEqual(on.loop.calls, ['refresh']);
  const bad = await on.run({ type: 'airflowMode', mode: 'turbo' });
  assert.equal(bad.error, 'bad_value');
  assert.deepEqual(bad.choices, Model.MODES);
});

test('airflowSet: switching on needs a fan the check measured and the person did not leave', async (t) => {
  const none = await rig(t);
  assert.equal((await none.set({ drive: 'on' })).error, 'needs_check');
  const left = await rig(t, { saved: { fans: { 'lhm:chip0:0': { calib: CALIB, leave: true } } } });
  assert.equal((await left.set({ drive: 'shadow' })).error, 'needs_check');
  assert.deepEqual(await left.set({ drive: 'off' }), { ok: true }, 'off needs nothing');

  const ok = await rig(t, { saved: checked() });
  assert.deepEqual(await ok.set({ drive: 'shadow' }), { ok: true });
  assert.equal((await ok.onDisk()).drive, 'shadow');
  assert.equal((await ok.set({ drive: 'full' })).error, 'bad_value');
});

test('airflowSet: a raw speed or any unknown key is never kept, out of range is the default', async (t) => {
  const { set, onDisk } = await rig(t, { saved: checked() });
  assert.deepEqual(await set({ slider: 140, duty: 100, pwm: 255, rpm: 3000, callQuiet: false, allowZero: 'yes', night: { on: true, from: 30 } }), { ok: true });
  const m = await onDisk();
  assert.equal(m.slider, 50, 'out of range goes back to the default, it is not stretched to fit');
  assert.equal(m.options.callQuiet, false);
  assert.equal(m.options.riseAlert, true, 'a choice left out of the patch stays as it was');
  assert.equal(m.options.allowZero, false, 'only a real boolean changes a choice');
  assert.deepEqual(m.options.night, { on: true, from: 23, to: 7 });
  const text = JSON.stringify(m);
  for (const word of ['duty', 'pwm', 'rpm']) assert.ok(!text.includes(word), `${word} never reaches the store`);
  assert.deepEqual(await set({ riseAlert: false }), { ok: true });
  assert.equal((await onDisk()).options.riseAlert, false, 'the notice can be switched off');
});

test('airflowSet: a fan\'s choices only for a fan this PC has now', async (t) => {
  const { set, onDisk, store } = await rig(t, { saved: checked() });
  assert.deepEqual(await set({ fan: { id: 'lhm:chip0:2', pump: true, place: 'radiator', leave: true, duty: 90 } }), { ok: true });
  assert.deepEqual((await onDisk()).fans['lhm:chip0:2'], { place: 'radiator', leave: true, pump: true, calib: null });
  assert.equal((await set({ fan: { id: 'lhm:chip0:0', place: 'roof' } })).error, 'bad_value');
  assert.equal((await set({ fan: { id: 'lhm:chip9:0', leave: true } })).error, 'unknown_fan', 'a well formed id this PC lacks');
  assert.equal((await set({ fan: { id: '../etc', leave: true } })).error, 'unknown_fan');
  assert.equal((await set({ fan: 'lhm:chip0:0' })).error, 'unknown_fan');
  assert.deepEqual(Object.keys((await store.ready()).fans).sort(), ['lhm:chip0:0', 'lhm:chip0:2']);
});

test('airflowSet: a broken patch is refused, the filters cleaned are told to the engine', async (t) => {
  const { set, loop } = await rig(t);
  for (const bad of ['{', '[1]', 'null', '"x"']) assert.deepEqual(await set(bad), { ok: false, error: 'bad_value' }, bad);
  assert.deepEqual(await set({ cleaned: true }), { ok: true });
  assert.deepEqual(loop.calls, ['cleaned']);
  const away = await rig(t, { loop: fakeLoop({ cleaned: false }) });
  assert.deepEqual(await away.set({ cleaned: true }), { ok: false, error: 'unavailable' });
});

test('airflowSet: learning again from scratch is told to the engine; the choices stay as they were', async (t) => {
  const saved = Model.normalize({ drive: 'on', mode: 'quiet', fans: { 'lhm:board:control-1': { place: 'front', calib: CALIB } } });
  const { set, loop, store } = await rig(t, { saved });
  assert.deepEqual(await set({ relearn: true }), { ok: true });
  assert.deepEqual(loop.calls, ['relearn']);
  assert.deepEqual(store.peek(), saved);
});

test('airflowCheck: started, busy, unavailable, and stopped', async (t) => {
  const { run, loop } = await rig(t);
  assert.deepEqual(await run({ type: 'airflowCheck', do: 'start' }), { ok: true });
  assert.deepEqual(await run({ type: 'airflowCheck', do: 'cancel' }), { ok: true });
  assert.deepEqual(loop.calls, ['startCheck', 'cancelCheck']);
  const busy = await rig(t, { loop: fakeLoop({ startCheck: { ok: false, why: 'running' } }) });
  assert.deepEqual(await busy.run({ type: 'airflowCheck' }), { ok: false, error: 'busy' });
  const no = await rig(t, { loop: fakeLoop({ startCheck: { ok: false, why: 'no-fans' } }) });
  assert.deepEqual(await no.run({ type: 'airflowCheck' }), { ok: false, error: 'unavailable' });
  assert.deepEqual(await no.run({ type: 'airflowFull' }), { ok: false, error: 'unsupported' });
});

test('patched leaves the model it was given as it was', () => {
  const model = Model.normalize(checked());
  const before = JSON.stringify(model);
  const out = patched(model, { drive: 'on', mode: 'cool', night: { on: true }, fan: { id: 'lhm:chip0:0', leave: true } });
  assert.equal(out.model.drive, 'on');
  assert.equal(JSON.stringify(model), before);
});

// The live event on a clock the test moves: the 2 s floor is real time, not ticks.
function liveRig() {
  const sent = [];
  let clock = 1_000_000;
  let timer = null;
  const live = createAirflowLive({
    broadcast: (e, d) => sent.push([e, d]),
    now: () => clock,
    setTimer: (fn, ms) => { timer = { fn, due: clock + ms }; return timer; },
    clearTimer: (t) => { if (timer === t) timer = null; },
  });
  const pass = (ms) => {
    clock += ms;
    if (timer && timer.due <= clock) { const { fn } = timer; timer = null; fn(); }
  };
  return { live, sent, pass, waiting: () => timer !== null };
}

test('live: told when the state, a reason, a step or who drives changes, never for speeds', () => {
  const { live, sent, pass } = liveRig();
  const base = airflowView();
  live.push(base);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], ['airflow', { state: 'driving', why: 'idle', check: null }]);
  pass(MIN_GAP_MS);
  live.push({ ...base, at: NOW + 1000, fans: base.fans.map((f) => ({ ...f, rpm: f.rpm + 40, duty: f.duty + 3 })) });
  assert.equal(sent.length, 1, 'speeds and the clock alone change nothing drawn');
  live.push({ ...base, why: 'heat-gpu' });
  pass(MIN_GAP_MS);
  live.push({ ...base, why: 'heat-gpu', fans: base.fans.map((f, i) => (i ? f : { ...f, xenon: false, why: 'stall' })) });
  assert.equal(sent.length, 3);

  const checking = (progress) => ({ ...base, state: 'checking', check: { phase: 'pair', progress } });
  pass(MIN_GAP_MS);
  live.push(checking(0.21));
  pass(MIN_GAP_MS);
  live.push(checking(0.21 + (PROGRESS_STEP - 2) / 100));
  assert.equal(sent.length, 4, 'progress inside one step is told once');
  pass(MIN_GAP_MS);
  live.push(checking(0.31));
  assert.equal(sent.length, 5);
});

test('live: a reason that flips every second is told at most every 2 s, the latest one last', () => {
  const { live, sent, pass, waiting } = liveRig();
  const base = airflowView();
  live.push(base);
  for (let i = 0; i < 6; i++) {
    pass(1000);
    live.push({ ...base, why: i % 2 ? 'idle' : 'spike-ignored' });
  }
  pass(1000);
  assert.ok(sent.length <= 1 + Math.ceil(7000 / MIN_GAP_MS), `${sent.length} events in 7 s`);
  live.push({ ...base, why: 'heat-cpu' });
  pass(MIN_GAP_MS);
  assert.equal(waiting(), false);
  assert.equal(sent.at(-1)[1].why, 'heat-cpu', 'the last change always arrives');
});

test('live: stop drops a change still waiting, so nothing is sent after shutdown', () => {
  const { live, sent, pass, waiting } = liveRig();
  const base = airflowView();
  live.push(base);
  live.push({ ...base, why: 'heat-gpu' });
  assert.equal(waiting(), true);
  live.stop();
  assert.equal(waiting(), false);
  pass(MIN_GAP_MS * 2);
  assert.equal(sent.length, 1);
});
