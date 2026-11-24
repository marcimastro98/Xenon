// Airflow's brain and safety layer on the pretend PC (tools/airflow-sim/): the
// promises the feature makes, as numbers. Xenon never lets a component reach its
// full temperature nor cross its ceiling where one can be held, stays at its
// targets wherever they can be held, is clearly
// quieter and steadier than a BIOS curve and a careful FanControl setup, and the
// safety layer answers every fault in time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runScenario } from '../../tools/airflow-sim/run.mjs';
import { SCENARIOS } from '../../tools/airflow-sim/scenarios.mjs';

const require = createRequire(import.meta.url);
const L = require('../airflow/limits.js');

const CPU = 'AMD Ryzen 7 9700X';
const results = new Map();
const run = (name, ctrl = 'xenon', seed = 7) => {
  const key = `${name}/${ctrl}/${seed}`;
  if (!results.has(key)) results.set(key, runScenario(name, ctrl, { seed }));
  return results.get(key);
};

// Scenarios whose targets are within reach of the pretend PC's coolers.
const HOLDABLE = ['idle-spikes', 'game', 'game-known', 'call', 'night', 'dust', 'three-pin', 'lost-sensor', 'brain-crash', 'engine-restart'];
// Seconds a die may spend more than 1 C over its target: comfort is priced, so a
// load ramping up can lead the fans by a moment. A jammed fan is planned as standing
// still once the safety layer hands it back, so the others take its share at once.
const OVER_S = 5;
const ceiling = (n) => L.fullAt(n, CPU) - L.COMPONENTS[n].margin;

test('Xenon never lets a component reach its full temperature, in any scenario', () => {
  for (const name of Object.keys(SCENARIOS)) {
    const r = run(name);
    assert.ok(r.maxDie.cpu < L.cpuFullAt(CPU), `${name} cpu ${r.maxDie.cpu}`);
    assert.ok(r.maxDie.gpu < L.fullAt('gpu'), `${name} gpu ${r.maxDie.gpu}`);
    assert.ok(r.maxDie.gpuMem < L.fullAt('gpuMem'), `${name} gpuMem ${r.maxDie.gpuMem}`);
    assert.equal(r.fullSeconds, 0, name);
  }
});

test('Xenon never crosses a ceiling that can be held, and stays at its targets', () => {
  for (const name of [...HOLDABLE, 'stall']) {
    const r = run(name);
    for (const n of ['cpu', 'gpu', 'gpuMem']) {
      assert.ok(r.maxDie[n] <= ceiling(n), `${name} ${n} ${r.maxDie[n]} over ${ceiling(n)}`);
      assert.ok(r.overTarget[n] <= OVER_S, `${name} ${n}: ${r.overTarget[n]} s over target`);
    }
  }
});

// The board runs the fans fast while the engine is down; a new brain that started from that
// speed fell from it at 1 %/s for over a minute (a real PC, 23 Nov 2026).
test('after an engine restart mid-game the fans are back at Xenon speeds within seconds', () => {
  const caseFans = (row) => ['front1', 'front3', 'rear'].reduce((sum, id) => sum + row.rpm[id], 0) / 3;
  const at = {};
  runScenario('engine-restart', 'xenon', { seed: 7, trace: (t, row) => { if ([595, 611, 627].includes(t)) at[t] = caseFans(row); } });
  assert.ok(at[611] > at[595] + 300, `the board did not take the fans: ${JSON.stringify(at)}`);
  assert.ok(at[627] < at[595] + 100, `case fans at ${Math.round(at[627])} rpm 15 s after the restart, ${Math.round(at[595])} before`);
});

test('at the desktop and in a game Xenon is far quieter and steadier than fixed curves', () => {
  for (const seed of [7, 11]) {
    for (const name of ['idle-spikes', 'game']) {
      const x = run(name, 'xenon', seed);
      for (const other of ['bios', 'fancontrol']) {
        const o = run(name, other, seed);
        const at = `${name} seed ${seed} vs ${other}`;
        assert.ok(x.meanDb <= o.meanDb - 5, `${at}: ${x.meanDb} dB vs ${o.meanDb}`);
        assert.ok(x.changes * 10 <= o.changes, `${at}: ${x.changes} changes vs ${o.changes}`);
        assert.ok(x.reversals * 10 <= o.reversals, `${at}: ${x.reversals} reversals vs ${o.reversals}`);
      }
    }
  }
});

test('calls, night hours, dust and a 3-pin fan stay quieter than the BIOS', () => {
  for (const name of ['call', 'night', 'dust', 'three-pin', 'game-known']) {
    const x = run(name);
    const bios = run(name, 'bios');
    assert.ok(x.meanDb < bios.meanDb - 2, `${name}: ${x.meanDb} dB vs ${bios.meanDb}`);
    assert.ok(x.changes < bios.changes, `${name}: ${x.changes} changes vs ${bios.changes}`);
  }
  assert.ok(run('night').meanDb <= run('idle-spikes').meanDb + 0.1);
});

test('a load no cooler can hold costs no more noise than the BIOS and fewer changes', () => {
  const x = run('render');
  const bios = run('render', 'bios');
  assert.ok(x.meanDb <= bios.meanDb + 2, `${x.meanDb} dB vs ${bios.meanDb}`);
  assert.ok(x.p95Db <= bios.p95Db + 1, `${x.p95Db} dB p95 vs ${bios.p95Db}`);
  assert.ok(x.changes < bios.changes, `${x.changes} vs ${bios.changes}`);
});

// A real PC (23 Nov 2026): an X3D on an AIO its own app runs, a scan at full load. Air
// cannot touch the die's rise over its cooler, so the case fans are not bought for it.
test('a CPU at work on a cooler another app runs never gets the case fans at full for nothing', () => {
  const speeds = [];
  runScenario('hidden-cooler-work', 'xenon', { seed: 7, trace: (t, r) => { if (t >= 420 && t < 1200) speeds.push(r.rpm.front1 / 1500); } });
  const mean = speeds.reduce((a, x) => a + x, 0) / speeds.length;
  assert.ok(mean < 0.6, `case fans at ${Math.round(mean * 100)} % through the load`);
  const x = run('hidden-cooler-work');
  const bios = run('hidden-cooler-work', 'bios');
  assert.ok(x.meanDb <= bios.meanDb, `${x.meanDb} dB vs ${bios.meanDb}`);
  assert.ok(x.maxDie.cpu < L.cpuFullAt('AMD Ryzen 7 9800X3D'), `cpu ${x.maxDie.cpu}`);
});

// A real PC (23 Nov 2026): a case fan allowed to stop got its start duty for three
// seconds, which through the sensor service reached it late and was not enough from a
// dead stop; the safety layer called it jammed and the BIOS ran it from then on.
test('case fans that stopped start again on late hands without being called jammed', () => {
  let stalls = 0;
  let restarts = 0;
  let prev = null;
  runScenario('fan-restart', 'xenon', { seed: 7, trace: (_t, r) => {
    stalls += (r.verdict?.alerts || []).filter((a) => a.code === 'stall').length;
    const v = r.verdict?.channels?.front1;
    if (v?.action !== 'set') return;
    if (prev === 0 && v.duty > 0) restarts += 1;
    prev = v.duty;
  } });
  assert.ok(restarts >= 2, `front1 started again ${restarts} times, or this proves nothing`);
  assert.equal(stalls, 0, 'a fan that only needed a firmer push was handed to the BIOS as jammed');
});

test('the safety layer answers every fault in time', () => {
  for (const [name, s] of Object.entries(SCENARIOS)) {
    if (!s.fault) continue;
    const r = run(name);
    assert.ok(r.reactedIn != null, `${name}: no answer`);
    assert.ok(r.reactedIn <= s.fault.within, `${name}: ${r.reactedIn} s, allowed ${s.fault.within}`);
  }
});

test('the simulator is deterministic for a seed', () => {
  const a = runScenario('idle-spikes', 'xenon', { seed: 3 });
  const b = runScenario('idle-spikes', 'xenon', { seed: 3 });
  const strip = ({ brain: _brain, ...rest }) => rest;
  assert.deepEqual(strip(a), strip(b));
});
