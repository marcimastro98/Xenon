// The shadow run's score (server/airflow/shadow.js): how loud the fans really were
// against what Xenon planned, how many changes you would hear, how long the plan
// would have run warm, kept across restarts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createShadow, CHANGE_SPAN_MS } = require('../airflow/shadow.js');

// Two case fans: 300 rpm at 20 %, 1500 at 100 %, straight in between.
const curve = [[20, 300], [100, 1500]];
const fans = [
  { id: 'a', kind: 'fan', maxRpm: 1500, curve },
  { id: 'b', kind: 'fan', maxRpm: 1500, curve },
];

function run(shadow, seconds, at0, frame) {
  for (let i = 0; i < seconds; i += 1) shadow.observe({ at: at0 + i * 1000, channels: fans, ...frame(i) });
  return at0 + seconds * 1000;
}

test('shadow: a plan that matches the fans scores even', () => {
  const s = createShadow();
  run(s, 120, 0, () => ({ rpm: { a: 900, b: 900 }, duties: { a: 60, b: 60 } }));
  const r = s.report();
  assert.equal(r.minutes, 2);
  assert.equal(r.quieterDb, 0);
  assert.equal(r.changesNow, r.changesXenon);
});

test('shadow: half the speed on every fan reads about 15 dB quieter', () => {
  const s = createShadow();
  // 1500 rpm now; Xenon would ask 50 %: 750 rpm on the curve.
  run(s, 60, 0, () => ({ rpm: { a: 1500, b: 1500 }, duties: { a: 50, b: 50 } }));
  const r = s.report();
  assert.ok(Math.abs(r.quieterDb - 15) < 0.2, `quieter by ${r.quieterDb}`);
  assert.ok(r.dbNow > r.dbXenon);
});

test('shadow: a fan Xenon would leave alone counts the same on both sides', () => {
  const s = createShadow();
  run(s, 60, 0, () => ({ rpm: { a: 1200, b: 1200 }, duties: {} }));
  assert.equal(s.report().quieterDb, 0);
});

test('shadow: every audible swing counts once, a steady plan none', () => {
  const s = createShadow();
  // The PC jumps between two speeds every 10 s; Xenon would hold one.
  run(s, 100, 0, (i) => ({ rpm: { a: Math.floor(i / 10) % 2 ? 1500 : 700, b: 700 }, duties: { a: 50, b: 50 } }));
  const r = s.report();
  assert.equal(r.changesNow, 9);
  assert.equal(r.changesXenon, 0);
  assert.ok(CHANGE_SPAN_MS < 10000, 'each swing settles before the next');
});

test('shadow: seconds the plan would run warm are counted', () => {
  const s = createShadow();
  run(s, 90, 0, () => ({ rpm: { a: 700, b: 700 }, duties: { a: 30, b: 30 }, predicted: { cpu: 80 }, targets: { cpu: 75 } }));
  run(s, 60, 90000, () => ({ rpm: { a: 700, b: 700 }, duties: { a: 30, b: 30 }, predicted: { cpu: 75.5 }, targets: { cpu: 75 } }));
  assert.equal(s.report().warmMinutes, 1);
});

test('shadow: a sleep counts as one short tick, not the hours it lasted', () => {
  const s = createShadow();
  let at = run(s, 30, 0, () => ({ rpm: { a: 700, b: 700 }, duties: { a: 30, b: 30 } }));
  at += 3 * 3600000;
  run(s, 31, at, () => ({ rpm: { a: 700, b: 700 }, duties: { a: 30, b: 30 } }));
  assert.equal(s.report().minutes, 1);
  assert.ok(s.save().seconds < 70);
});

test('shadow: no fan turning yet says nothing rather than a number', () => {
  const s = createShadow();
  run(s, 10, 0, () => ({ rpm: { a: 0, b: null }, duties: { a: 0, b: 0 } }));
  const r = s.report();
  assert.deepEqual([r.dbNow, r.dbXenon, r.quieterDb], [null, null, null]);
});

test('shadow: the score survives a restart, and a broken save starts over', () => {
  const s = createShadow();
  run(s, 120, 0, () => ({ rpm: { a: 1500, b: 1500 }, duties: { a: 50, b: 50 } }));
  const again = createShadow({ saved: JSON.parse(JSON.stringify(s.save())) });
  assert.deepEqual(again.report(), s.report());
  for (const saved of [null, { seconds: -1 }, { seconds: 'x' }, { seconds: 10, now: { energy: -1, changes: 0 } }, { seconds: 10, xenon: { energy: 5, changes: 1.5 } }]) {
    const kept = createShadow({ saved }).save();
    assert.ok(kept.now.energy >= 0 && kept.xenon.energy === 0 && kept.xenon.changes === 0, JSON.stringify(saved));
  }
});

test('shadow: the level does not depend on how often it is told', () => {
  const every = (ms) => {
    const s = createShadow();
    for (let at = 0; at < 120000; at += ms) s.observe({ at, channels: fans, rpm: { a: 1500, b: 1500 }, duties: { a: 50, b: 50 } });
    return s.report();
  };
  assert.equal(every(2000).dbNow, every(1000).dbNow);
});
