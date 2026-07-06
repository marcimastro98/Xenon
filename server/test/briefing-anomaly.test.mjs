import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createBriefingEngine } = require('../briefing.js');

// The 'anomaly' proactive moment: a temperature well above its own recent
// per-session baseline while still below the absolute thermal threshold. Driven
// with an injected clock; the engine is passive so every scenario is a sequence
// of fed samples (every 30s, like the server's system tick).

function makeEngine(opts = {}) {
  const moments = [];
  let t = 0;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const engine = createBriefingEngine({
    emit: (type, data) => moments.push({ type, ...data }),
    isTypeEnabled: opts.isTypeEnabled || (() => true),
    getFps: () => null,
    now: clock.now,
  });
  return { engine, moments, clock };
}

// Feed `count` samples of gpuTemp=temp, 30s apart.
function feed(engine, clock, count, temp) {
  for (let i = 0; i < count; i++) { clock.advance(30000); engine.onSystemSample({ gpuTemp: temp }); }
}

test('a sustained spike above the session baseline raises an anomaly', () => {
  const { engine, moments, clock } = makeEngine();
  feed(engine, clock, 45, 60);   // warm up the baseline at 60°C
  feed(engine, clock, 12, 78);   // 6 min at 78°C (baseline+18, below the 88° alarm)
  const anomalies = moments.filter(m => m.type === 'anomaly');
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].metric, 'gpu');
  assert.equal(anomalies[0].value, 78);
  assert.equal(anomalies[0].baseline, 60);
  assert.equal(anomalies[0].delta, 18);
});

test('a spike that stays below the floor does not alert (harmless warm-up)', () => {
  const { engine, moments, clock } = makeEngine();
  feed(engine, clock, 45, 40);   // baseline 40°C
  feed(engine, clock, 12, 55);   // +15 over baseline but only 55° — below the 70° floor
  assert.equal(moments.filter(m => m.type === 'anomaly').length, 0);
});

test('a value at/above the absolute threshold is left to the thermal alert', () => {
  const { engine, moments, clock } = makeEngine();
  feed(engine, clock, 45, 60);
  feed(engine, clock, 12, 90);   // 90 ≥ 88 → thermal territory, never an anomaly
  assert.equal(moments.filter(m => m.type === 'anomaly').length, 0);
});

test('a sampling gap restarts the sustained window', () => {
  const { engine, moments, clock } = makeEngine();
  feed(engine, clock, 45, 60);
  feed(engine, clock, 6, 78);          // 3 min at 78° — not yet sustained
  clock.advance(3 * 60 * 1000);        // a 3-min gap (sleep / no dashboard)
  engine.onSystemSample({ gpuTemp: 78 }); // gap tick — window resets
  feed(engine, clock, 6, 78);          // only 3 more min → still short of 4
  assert.equal(moments.filter(m => m.type === 'anomaly').length, 0);
});

test('anomalies are rate-limited to one per metric per cooldown', () => {
  const { engine, moments, clock } = makeEngine();
  feed(engine, clock, 45, 60);
  feed(engine, clock, 40, 78);   // 20 min hot — would re-trigger without the cooldown
  assert.equal(moments.filter(m => m.type === 'anomaly').length, 1);
});

test('the anomaly type honors its toggle', () => {
  const { engine, moments, clock } = makeEngine({ isTypeEnabled: (type) => type !== 'anomaly' });
  feed(engine, clock, 45, 60);
  feed(engine, clock, 12, 78);
  assert.equal(moments.filter(m => m.type === 'anomaly').length, 0);
});
