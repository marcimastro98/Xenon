// fps-demand.js: when the frame reader runs. FC 27 refused every new trace session
// while it ran ("access denied", 7 Nov 2026), so a reader paused in the middle of a
// game could not come back until the game closed: the counter stayed blank.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { createFpsDemand, PAUSE_GRACE_MS } = require('../fps-demand.js');

function rig() {
  const calls = [];
  const pending = new Map();
  let next = 1;
  const timers = {
    setTimeout(fn, ms) {
      const t = { id: next++, fn, ms, unrefed: false, unref() { t.unrefed = true; } };
      pending.set(t.id, t);
      return t;
    },
    clearTimeout(t) { pending.delete(t.id); },
  };
  const demand = createFpsDemand({ resume: () => calls.push('resume'), pause: () => calls.push('pause'), timers });
  const fire = () => {
    for (const t of [...pending.values()]) { pending.delete(t.id); t.fn(); }
  };
  return { demand, calls, pending, fire };
}

test('a dashboard reads frames, and the reader pauses only after the grace once it leaves', () => {
  const { demand, calls, pending, fire } = rig();
  demand.clients(1);
  assert.deepEqual(calls, ['resume']);
  demand.clients(0);
  assert.deepEqual(calls, ['resume'], 'not at once: a reload comes back within seconds');
  const [grace] = pending.values();
  assert.equal(grace.ms, PAUSE_GRACE_MS);
  assert.equal(grace.unrefed, true, 'the grace never keeps the server from exiting');
  fire();
  assert.deepEqual(calls, ['resume', 'pause']);
});

test('a reload inside the grace keeps the trace', () => {
  const { demand, calls, pending, fire } = rig();
  demand.clients(1);
  demand.clients(0);
  demand.clients(1);
  assert.equal(pending.size, 0);
  fire();
  assert.equal(calls.includes('pause'), false);
});

test('a second goodbye neither restarts nor doubles the grace', () => {
  const { demand, calls, pending, fire } = rig();
  demand.clients(1);
  demand.clients(0);
  demand.clients(0);
  assert.equal(pending.size, 1);
  demand.clients(1);
  fire();
  assert.equal(calls.includes('pause'), false, 'a forgotten timer would pause a watched reader');
});

test('a game keeps the running reader after the dashboard leaves, until the game ends', () => {
  const { demand, calls, pending, fire } = rig();
  demand.clients(1);
  demand.game(true);
  demand.clients(0);
  fire();
  assert.equal(calls.includes('pause'), false, 'a reader stopped mid-game may never start again');
  demand.game(false);
  assert.equal(pending.size, 1, 'the game is over: the grace starts');
  fire();
  assert.deepEqual(calls.filter((c) => c === 'pause'), ['pause']);
});

test('a game that starts during the grace still keeps the reader', () => {
  const { demand, calls, fire } = rig();
  demand.clients(1);
  demand.clients(0);
  demand.game(true);
  fire();
  assert.equal(calls.includes('pause'), false);
  demand.game(false);
  fire();
  assert.equal(calls.at(-1), 'pause');
});

test('a game never starts a reader by itself', () => {
  const { demand, calls } = rig();
  demand.game(true);
  demand.game(false);
  assert.equal(calls.includes('resume'), false, 'with nobody watching, nothing reads');
});

test('a recording that marks stutters reads like a dashboard', () => {
  const { demand, calls, fire } = rig();
  demand.capture(true);
  assert.deepEqual(calls, ['resume']);
  demand.capture(false);
  fire();
  assert.deepEqual(calls, ['resume', 'pause']);
});

test('the status tick asks again and again, and the reader hears only changes', () => {
  const { demand, calls } = rig();
  demand.clients(1);
  for (let i = 0; i < 3; i++) { demand.game(false); demand.capture(false); }
  assert.deepEqual(calls, ['resume'], 'each resume cuts a failing reader\'s back-off short');
});

test('server.js tells it the dashboards, the recording and the game, dashboard or not', () => {
  const s = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(s, /function _syncFpsMonitor\(\) \{\s*_fpsDemand\.clients\(sseClients\.size\);/);
  const tick = s.slice(s.indexOf('function broadcastStatusNow()'), s.indexOf('const j = JSON.stringify(st);'));
  const beforeSplit = tick.slice(0, tick.indexOf('if (sseClients.size === 0)'));
  assert.match(beforeSplit, /_fpsDemand\.game\(gameDetect\.isGameRunning\(\)\); \} catch \{\}/,
    'a dashboard that left mid-game is the very case, so the game is told with none connected');
  assert.match(s, /\n {2}try \{ _fpsDemand\.stop\(\); \} catch \{\}\n/, 'shutdown clears the grace');
});

test('stop leaves no pause behind', () => {
  const { demand, calls, pending } = rig();
  demand.clients(1);
  demand.clients(0);
  demand.stop();
  assert.equal(pending.size, 0);
  assert.deepEqual(calls, ['resume']);
});
