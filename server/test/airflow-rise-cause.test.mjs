// The program a climb of the fans is for (server/airflow/rise-cause.js), told with the
// notice (rise.js): the busiest program by processor, or the game for a graphics card's heat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRiseCause, busiestOf, nameOf, MIN_CPU_PCT, WINDOW_MS } = require('../airflow/rise-cause.js');
const { createRiseNotices, SETTLE_MS } = require('../airflow/rise.js');

const S = 1000;
const app = (proc, cpuPct) => ({ proc, memMB: 100, cpuPct });

test('rise cause: the program that used the most processor, by a name a person knows', () => {
  assert.deepEqual(busiestOf([app('chrome.exe', 12.4), app('blender.exe', 38.6), app('obs64.exe', 9)]), { name: 'Blender', cpu: 39 });
  assert.deepEqual(busiestOf([app('MsMpEng.exe', 22), app('explorer.exe', 2)]), { name: 'Microsoft Defender', cpu: 22 });
  assert.deepEqual(busiestOf([app('tiworker', 30)]), { name: 'Windows Update', cpu: 30 });
  assert.equal(nameOf('Some Long Program Name That Goes On And On Forever.exe').length, 40);
});

test('rise cause: no program named when none used enough, or for the time nothing ran', () => {
  assert.equal(busiestOf([app('chrome', MIN_CPU_PCT - 0.6)]), null);
  assert.equal(busiestOf([app('Idle', 80), app('System Idle Process', 70)]), null);
  assert.deepEqual(busiestOf([app('idle', 80), app('code', 7)]), { name: 'Code', cpu: 7 });
  assert.equal(busiestOf([]), null);
  assert.equal(busiestOf(null), null);
  assert.equal(busiestOf([null, { proc: 4 }, app('x', Number.NaN)]), null);
});

test('rise cause: a graphics card\'s heat names the game and reads nothing', async () => {
  let reads = 0;
  const read = async () => { reads += 1; return { ok: true, apps: [app('chrome', 50)] }; };
  const playing = createRiseCause({ read, game: () => 'cyberpunk2077.exe' });
  assert.deepEqual(await playing('heat-gpu'), { name: 'Cyberpunk2077', game: true });
  assert.deepEqual(await playing('game-prepare'), { name: 'Cyberpunk2077', game: true });
  const desk = createRiseCause({ read, game: () => null });
  assert.equal(await desk('heat-gpu'), null, 'the processor\'s figure would point at the wrong part');
  assert.equal(reads, 0);
});

test('rise cause: the processor\'s heat reads the busiest program over a couple of seconds', async () => {
  const asked = [];
  const read = async (o) => { asked.push(o); return { ok: true, apps: [app('chrome', 4), app('handbrake', 61)] }; };
  const cause = createRiseCause({ read, game: () => 'game.exe' });
  assert.deepEqual(await cause('heat-cpu'), { name: 'Handbrake', cpu: 61 });
  assert.deepEqual(asked, [{ by: 'cpu', windowMs: WINDOW_MS }]);
});

test('rise cause: something too hot or fans at their limit name nothing and read nothing', async () => {
  let reads = 0;
  const cause = createRiseCause({ read: async () => { reads += 1; return { ok: true, apps: [app('x', 90)] }; }, game: () => 'game.exe' });
  for (const reason of ['hot', 'impossible', 'idle', '__proto__', '']) assert.equal(await cause(reason), null, reason);
  assert.equal(reads, 0);
});

test('rise cause: a table that fails, answers nothing or hangs names nothing', async () => {
  const fails = createRiseCause({ read: async () => { throw new Error('denied'); }, game: () => null });
  assert.equal(await fails('heat-cpu'), null);
  const throwsAtOnce = createRiseCause({ read: () => { throw new Error('denied'); }, game: () => null });
  assert.equal(await throwsAtOnce('heat-cpu'), null);
  const empty = createRiseCause({ read: async () => null, game: () => null });
  assert.equal(await empty('heat-cpu'), null);
  const hangs = createRiseCause({ read: () => new Promise(() => {}), game: () => null, timeoutMs: 20 });
  assert.equal(await hangs('heat-cpu'), null);
});

// A climb of the CPU's fans, as the engine publishes it, after the settling time.
function climb(notices, model) {
  const status = (t, why, level) => ({ at: t * S, state: 'driving', why, fans: [{ xenon: true, kind: 'case', planned: level }] });
  for (let t = 0; t <= SETTLE_MS / S + 10; t += 1) notices.push(status(t, 'idle', 25), model);
  for (let t = 0; t <= 30; t += 1) notices.push(status(200 + t, 'heat-cpu', 25 + t), model);
}

test('rise: the notice names the program, and Bit can ask for the last climb', async () => {
  const sent = [];
  const notices = createRiseNotices({ broadcast: (_, d) => sent.push(d), cause: async () => ({ name: 'blender', cpu: 40 }) });
  climb(notices, { options: {} });
  assert.equal(notices.last().reason, 'heat-cpu', 'kept at once');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].app, { name: 'blender', cpu: 40 });
  assert.deepEqual(notices.last().app, { name: 'blender', cpu: 40 });
});

test('rise: a program that cannot be found never holds the notice back', async () => {
  const sent = [];
  const notices = createRiseNotices({ broadcast: (_, d) => sent.push(d), cause: async () => { throw new Error('no table'); } });
  climb(notices, { options: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].reason, 'heat-cpu');
  assert.equal('app' in sent[0], false);
});
