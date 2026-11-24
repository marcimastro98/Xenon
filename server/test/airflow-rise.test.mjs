// When Airflow tells the person its fans climbed, and why (server/airflow/rise.js):
// once per climb a person hears, never for a change they asked for, never in a burst.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRise, createRiseNotices, levelOf, GAP_MS, SAME_MS, SETTLE_MS } = require('../airflow/rise.js');

const S = 1000;
const status = (at, why, level, state = 'driving') => ({
  at, state, why,
  fans: [{ xenon: true, kind: 'case', planned: level }, { xenon: true, kind: 'pump', planned: 100 }],
});

// Feeds one status a second from `from` to `to` (seconds), the level moving linearly.
function run(rise, model, from, to, why, a, b = a) {
  const told = [];
  for (let t = from; t <= to; t += 1) {
    const level = Math.round(a + (b - a) * (t - from) / Math.max(1, to - from));
    const r = rise.step(status(t * S, why, level), model);
    if (r) told.push(r);
  }
  return told;
}

// A rise that has driven quietly past its settling time.
function settled() {
  const rise = createRise();
  const model = { options: {} };
  assert.deepEqual(run(rise, model, 0, SETTLE_MS / S + 10, 'idle', 25), []);
  return { rise, model, t: SETTLE_MS / S + 11 };
}

test('rise: a climb a person hears is told once, with its reason', () => {
  const { rise, model, t } = settled();
  const told = run(rise, model, t, t + 30, 'heat-cpu', 25, 55);
  assert.equal(told.length, 1);
  assert.equal(told[0].reason, 'heat-cpu');
  assert.equal(told[0].from, 25);
  assert.ok(told[0].to >= 40 && told[0].to <= 55);
  assert.deepEqual(run(rise, model, t + 31, t + 1800, 'heat-cpu', 55), [], 'fans that stay up are not told again');
});

test('rise: a small climb, or one that stays quiet, is not told', () => {
  const { rise, model, t } = settled();
  assert.deepEqual(run(rise, model, t, t + 30, 'heat-cpu', 25, 38), []);
  const low = createRise();
  run(low, model, 0, SETTLE_MS / S + 10, 'idle', 12);
  assert.deepEqual(run(low, model, 200, 230, 'heat-cpu', 12, 33), [], 'a climb from 12 to 33 % is still quiet');
});

test('rise: a climb with a reason that does not raise the fans is not told', () => {
  const { rise, model, t } = settled();
  assert.deepEqual(run(rise, model, t, t + 30, 'learning', 25, 60), []);
});

test('rise: a climb the person asked for (a new mode or option) is not told', () => {
  const { rise, t } = settled();
  const cooler = { options: {} };
  assert.deepEqual(run(rise, cooler, t, t + 60, 'heat-cpu', 25, 60), []);
  assert.deepEqual(run(rise, cooler, t + 61, t + 600, 'heat-cpu', 60), [], 'nor once it settled there');
});

test('rise: the first moments of driving are not told, after a start or a fan check', () => {
  const rise = createRise();
  const model = { options: {} };
  assert.deepEqual(run(rise, model, 0, 60, 'heat-cpu', 25, 60), [], 'an engine start');
  run(rise, model, 61, 200, 'heat-cpu', 60);
  assert.equal(rise.step(status(201 * S, 'heat-cpu', 60, 'checking'), model), null);
  assert.deepEqual(run(rise, model, 300, 360, 'heat-cpu', 25, 60), [], 'the end of a fan check');
  for (const state of ['watching', 'pc', 'off', 'unavailable']) {
    assert.equal(rise.step(status(400 * S, 'heat-cpu', 90, state), model), null, state);
  }
});

test('rise: told again only after the fans came back down, the same reason not for a while', () => {
  const { rise, model, t } = settled();
  assert.equal(run(rise, model, t, t + 30, 'heat-cpu', 25, 55).length, 1);
  run(rise, model, t + 31, t + 300, 'idle', 55, 25);
  const again = t + 301;
  assert.deepEqual(run(rise, model, again, again + 30, 'heat-cpu', 25, 55), [], 'heat-cpu was told minutes ago');
  run(rise, model, again + 31, again + 120, 'idle', 55, 25);
  const other = run(rise, model, again + 121, again + 150, 'heat-gpu', 25, 55);
  assert.equal(other.length, 1, 'another reason after the gap');
  assert.equal(other[0].reason, 'heat-gpu');
  run(rise, model, again + 151, again + 300, 'idle', 55, 25);
  const late = t + SAME_MS / S + 60;
  run(rise, model, again + 301, late, 'idle', 25);
  assert.equal(run(rise, model, late + 1, late + 30, 'heat-cpu', 25, 55).length, 1, 'heat-cpu once its time passed');
});

test('rise: a more urgent reason taking the fans higher still is told, never in a burst', () => {
  const { rise, model, t } = settled();
  assert.equal(run(rise, model, t, t + 30, 'heat-gpu', 25, 45).length, 1);
  assert.deepEqual(run(rise, model, t + 31, t + 60, 'impossible', 45, 75), [], 'within the gap');
  const late = run(rise, model, t + 61, t + GAP_MS / S + 40, 'impossible', 75);
  assert.equal(late.length, 1, 'still true once the gap passed: told then');
  assert.equal(late[0].reason, 'impossible');
  assert.equal(late[0].from, 25, 'from where the climb began');
  const after = t + GAP_MS / S + 41;
  assert.deepEqual(run(rise, model, after, after + 30, 'heat-gpu', 75, 95), [], 'a less urgent reason is not news');
});

test('rise: something too hot is told at once, even right after another notice', () => {
  const { rise, model, t } = settled();
  assert.equal(run(rise, model, t, t + 30, 'heat-cpu', 25, 55).length, 1);
  const hot = rise.step(status((t + 40) * S, 'hot', 55), model);
  assert.deepEqual(hot, { reason: 'hot', from: 25, to: 100, at: (t + 40) * S });
  assert.deepEqual(run(rise, model, t + 41, t + 80, 'hot', 55), [], 'once while it lasts');
  run(rise, model, t + 81, t + 100, 'heat-cpu', 55);
  assert.equal(rise.step(status((t + 101) * S, 'hot', 55), model), null, 'hot again within minutes');
  run(rise, model, t + 102, t + 400, 'heat-cpu', 55);
  assert.equal(rise.step(status((t + 401) * S, 'hot', 55), model)?.reason, 'hot');
});

test('rise: something hot before the fans were ever read still ends once they are quiet', () => {
  const rise = createRise();
  const model = { options: {} };
  assert.equal(rise.step(status(0, 'hot', 30), model)?.from, null);
  run(rise, model, 1, SETTLE_MS / S + 10, 'idle', 30, 25);
  const t = SETTLE_MS / S + GAP_MS / S + 20;
  run(rise, model, SETTLE_MS / S + 11, t, 'idle', 25);
  assert.equal(run(rise, model, t + 1, t + 30, 'heat-cpu', 25, 55).length, 1);
});

test('rise: the level is the loudest fan Xenon drives, pumps and the PC\'s fans aside', () => {
  assert.equal(levelOf([{ xenon: true, kind: 'pump', planned: 100 }]), null);
  assert.equal(levelOf([{ xenon: false, kind: 'case', planned: 90 }, { xenon: true, kind: 'case', planned: 30 }]), 30);
  assert.equal(levelOf([{ xenon: true, kind: 'case', planned: null }]), null);
  assert.equal(levelOf([{ xenon: true, kind: 'gpu', planned: 40 }, { xenon: true, kind: 'case', planned: 30 }]), 40);
  assert.equal(levelOf(undefined), null);
});

// The notice waits for the program behind it (a read of a couple of seconds at most).
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('rise: the notice reaches every screen unless the person switched it off', async () => {
  const sent = [];
  const notices = createRiseNotices({ broadcast: (event, data) => sent.push([event, data]) });
  const on = { options: { riseAlert: true } };
  for (let t = 0; t <= SETTLE_MS / S + 10; t += 1) notices.push(status(t * S, 'idle', 25), on);
  const off = { options: { riseAlert: false } };
  for (let t = 0; t <= SETTLE_MS / S + 10; t += 1) notices.push(status((200 + t) * S, 'idle', 25), off);
  for (let t = 0; t <= 30; t += 1) notices.push(status((400 + t) * S, 'heat-cpu', 25 + t), off);
  await settle();
  assert.deepEqual(sent, [], 'switched off');
  assert.equal(notices.last()?.reason, 'heat-cpu', 'the climb is still kept for Bit');
  for (let t = 31; t <= 600; t += 1) notices.push(status((400 + t) * S, 'heat-cpu', 55), on);
  await settle();
  assert.deepEqual(sent, [], 'switching it back on never tells an old climb');
  const fresh = createRiseNotices({ broadcast: (event, data) => sent.push([event, data]) });
  const saved = { options: { riseAlert: true } };
  for (let t = 0; t <= SETTLE_MS / S + 10; t += 1) fresh.push(status(t * S, 'idle', 25), saved);
  for (let t = 0; t <= 30; t += 1) fresh.push(status((200 + t) * S, 'heat-gpu', 25 + t), saved);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'airflow_rise');
  assert.equal(sent[0][1].reason, 'heat-gpu');
});

// The real brain and safety layer on the pretend PC (tools/airflow-sim), its status as
// the engine publishes it: what a person would be told over a whole session.
test('rise: on the pretend PC, nothing at the desktop and one notice when a game starts', async () => {
  const { runScenario } = await import('../../tools/airflow-sim/run.mjs');
  const { statusOf } = require('../airflow/loop-status.js');
  const Model = require('../js/airflow/airflow-model.js');
  const model = Model.normalize({ drive: 'on', mode: 'balanced' });
  const none = { report: () => null };
  const told = (name) => {
    const rise = createRise();
    const out = [];
    runScenario(name, 'xenon', {
      trace: (t, row) => {
        if (!row.out) return;
        const channels = row.channels.map((c) => ({ ...c, rpm: row.rpm[c.id] }));
        const s = statusOf({ at: (t + 1) * S, model, channels, verdict: row.verdict, out: row.out, driving: true, answering: true, unavailable: {}, shadow: none, health: none });
        const r = rise.step(s, model);
        if (r) out.push({ t, ...r });
      },
    });
    return out;
  };
  assert.deepEqual(told('idle-spikes'), [], 'Ryzen bursts at the desktop are never news');
  const game = told('game-known');
  assert.equal(game.length, 1, JSON.stringify(game));
  assert.equal(game[0].reason, 'game-prepare', 'a known game: the fans get ready, and that is what is said');
  assert.ok(game[0].t >= 180 && game[0].t < 240, 'told as the game starts');
});
