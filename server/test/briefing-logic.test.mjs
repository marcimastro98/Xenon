import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createBriefingEngine } = require('../briefing.js');

// The proactive-moments opportunity engine: sustained-thermal alerts and game
// session recaps, with the anti-nag bounds (cooldown, hysteresis, gap reset,
// per-session once, rolling-hour cap). Driven with an injected clock — the
// engine is passive, so every scenario is just a sequence of fed samples.

const MIN = 60 * 1000;

function makeEngine(opts = {}) {
  const moments = [];
  let t = 0;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const engine = createBriefingEngine({
    emit: (type, data) => moments.push({ type, ...data }),
    isTypeEnabled: opts.isTypeEnabled || (() => true),
    getFps: opts.getFps || (() => null),
    now: clock.now,
  });
  return { engine, moments, clock };
}

// Feed a hot/cool GPU sample every 30s for `ms`.
function heatFor(engine, clock, ms, gpuTemp) {
  for (let i = 0; i < ms / 30000; i++) {
    clock.advance(30000);
    engine.onSystemSample({ gpuTemp });
  }
}

// Run one game session lasting `ms`, ticking status every 30s like the server.
function runSession(engine, clock, ms, opts = {}) {
  engine.onStatusTick({ gameRunning: true, gameProcess: opts.game || 'eldenring' });
  for (let i = 0; i < ms / 30000; i++) {
    clock.advance(30000);
    if (opts.hotGpu) engine.onSystemSample({ gpuTemp: opts.hotGpu });
    if (opts.sys) engine.onSystemSample(opts.sys);
    engine.onStatusTick({ gameRunning: true, gameProcess: opts.game || 'eldenring' });
  }
  engine.onStatusTick({ gameRunning: false });
}

// ── Sustained thermal ─────────────────────────────────────────────────────────

test('thermal fires once the metric has been hot continuously for 15 minutes', () => {
  const { engine, moments, clock } = makeEngine();
  engine.onSystemSample({ gpuTemp: 91 });      // hotSince = 0
  heatFor(engine, clock, 14 * MIN, 91);
  assert.equal(moments.length, 0, 'not sustained yet');
  heatFor(engine, clock, 2 * MIN, 91);
  assert.equal(moments.length, 1);
  assert.equal(moments[0].type, 'thermal');
  assert.equal(moments[0].metric, 'gpu');
  assert.equal(moments[0].value, 91);
  assert.ok(moments[0].minutes >= 15);
});

test('a genuinely cool sample resets the sustained window (with hysteresis)', () => {
  const { engine, moments, clock } = makeEngine();
  engine.onSystemSample({ gpuTemp: 91 });
  heatFor(engine, clock, 10 * MIN, 91);
  clock.advance(30000);
  engine.onSystemSample({ gpuTemp: 80 });      // well below 88-3 → reset
  heatFor(engine, clock, 12 * MIN, 91);
  assert.equal(moments.length, 0, 'window restarted after cooling down');
});

test('a shallow dip inside the hysteresis band does NOT reset the window', () => {
  const { engine, moments, clock } = makeEngine();
  engine.onSystemSample({ gpuTemp: 91 });
  heatFor(engine, clock, 10 * MIN, 91);
  clock.advance(30000);
  engine.onSystemSample({ gpuTemp: 86 });      // between 85 and 88 → still "hot-ish"
  heatFor(engine, clock, 6 * MIN, 91);
  assert.equal(moments.length, 1, 'the dip did not restart the 15-minute window');
});

test('unobserved time never counts as sustained (sampling gap restarts the window)', () => {
  const { engine, moments, clock } = makeEngine();
  engine.onSystemSample({ gpuTemp: 91 });
  clock.advance(16 * MIN);                     // no dashboard connected → no samples
  engine.onSystemSample({ gpuTemp: 91 });      // 16 min later, still hot
  assert.equal(moments.length, 0, 'a 16-minute gap is not 16 minutes of observed heat');
  heatFor(engine, clock, 16 * MIN, 91);        // now actually observed for 15+
  assert.equal(moments.length, 1);
});

test('per-metric cooldown blocks a re-alert for an hour, then re-fires if still hot', () => {
  const { engine, moments, clock } = makeEngine();
  engine.onSystemSample({ gpuTemp: 91 });
  heatFor(engine, clock, 16 * MIN, 91);
  assert.equal(moments.length, 1);
  heatFor(engine, clock, 40 * MIN, 91);        // still hot, inside the cooldown
  assert.equal(moments.length, 1, 'no nagging inside the cooldown');
  heatFor(engine, clock, 25 * MIN, 91);        // cooldown expired, still hot
  assert.equal(moments.length, 2, 'an hour later the alert is worth repeating');
});

test('cpu and gpu are tracked independently', () => {
  const { engine, moments, clock } = makeEngine();
  for (let i = 0; i < (17 * MIN) / 30000; i++) {
    clock.advance(30000);
    engine.onSystemSample({ cpuTemp: 95, gpuTemp: 60 });
  }
  assert.equal(moments.length, 1);
  assert.equal(moments[0].metric, 'cpu');
});

test('a disabled thermal toggle silences the alert', () => {
  const { engine, moments, clock } = makeEngine({ isTypeEnabled: (type) => type !== 'thermal' });
  engine.onSystemSample({ gpuTemp: 91 });
  heatFor(engine, clock, 20 * MIN, 91);
  assert.equal(moments.length, 0);
});

// ── Game-session recap ────────────────────────────────────────────────────────

test('a session shorter than 10 minutes ends silently', () => {
  const { engine, moments, clock } = makeEngine({ getFps: () => 60 });
  runSession(engine, clock, 5 * MIN);
  assert.equal(moments.length, 0);
});

test('a real session emits one recap with duration, avg/max FPS and temp peaks', () => {
  let flip = false;
  const { engine, moments, clock } = makeEngine({ getFps: () => { flip = !flip; return flip ? 60 : 120; } });
  runSession(engine, clock, 12 * MIN, { game: 'eldenring.exe', sys: { cpuTemp: 71, gpuTemp: 79 } });
  assert.equal(moments.length, 1);
  const m = moments[0];
  assert.equal(m.type, 'recap');
  assert.equal(m.game, 'eldenring.exe');
  assert.equal(m.minutes, 12);
  assert.equal(m.avgFps, 89); // 25 samples alternating 60/120 starting at 60
  assert.equal(m.maxFps, 120);
  assert.equal(m.cpuTempMax, 71);
  assert.equal(m.gpuTempMax, 79, 'peaks are recorded even below the alert threshold');
});

test('without PresentMon (fps null) the recap still emits, without FPS fields', () => {
  const { engine, moments, clock } = makeEngine({ getFps: () => null });
  runSession(engine, clock, 15 * MIN);
  assert.equal(moments.length, 1);
  assert.equal(moments[0].avgFps, null);
  assert.equal(moments[0].maxFps, null);
});

test('the session ends at the last moment the game was SEEN running', () => {
  const { engine, moments, clock } = makeEngine();
  engine.onStatusTick({ gameRunning: true, gameProcess: 'game' });
  for (let i = 0; i < (12 * MIN) / 30000; i++) {
    clock.advance(30000);
    engine.onStatusTick({ gameRunning: true, gameProcess: 'game' });
  }
  clock.advance(30 * MIN);                     // every dashboard disconnected
  engine.onStatusTick({ gameRunning: false }); // eventual late end-tick
  assert.equal(moments.length, 1);
  assert.equal(moments[0].minutes, 12, 'the 30 unobserved minutes are not credited');
});

test('two sessions produce two recaps; a disabled toggle produces none', () => {
  const a = makeEngine();
  runSession(a.engine, a.clock, 11 * MIN, { game: 'one' });
  runSession(a.engine, a.clock, 11 * MIN, { game: 'two' });
  assert.deepEqual(a.moments.map(m => m.game), ['one', 'two']);
  const b = makeEngine({ isTypeEnabled: (type) => type !== 'recap' });
  runSession(b.engine, b.clock, 11 * MIN);
  assert.equal(b.moments.length, 0);
});

test('sensor samples between sessions do not leak peaks into the next recap', () => {
  const { engine, moments, clock } = makeEngine();
  engine.onSystemSample({ gpuTemp: 84 });      // hot-ish while NO game runs
  clock.advance(30000);
  runSession(engine, clock, 11 * MIN, { sys: { gpuTemp: 65 } });
  assert.equal(moments[0].gpuTempMax, 65, 'only in-session readings count');
});

// ── Global rolling-hour backstop ──────────────────────────────────────────────

test('the rolling-hour cap suppresses a 7th moment until the window slides', () => {
  const { engine, moments, clock } = makeEngine({ getFps: () => 60 });
  // Four back-to-back 10-min sessions → recaps at 10, 20, 30, 40 min.
  for (let k = 0; k < 4; k++) runSession(engine, clock, 10 * MIN, { game: 'g' + k });
  // Two more with the GPU continuously hot: recap at 50 min, then the sustained
  // thermal matures mid-session-6 (~55.5 min) as the 6th moment of the hour.
  runSession(engine, clock, 10 * MIN, { game: 'g4', hotGpu: 91 });
  runSession(engine, clock, 10 * MIN, { game: 'g5', hotGpu: 91 });
  const types = moments.map(m => m.type);
  assert.equal(types.filter(x => x === 'recap').length, 5, 'session 6 recap hit the cap');
  assert.equal(types.filter(x => x === 'thermal').length, 1);
  // Once the oldest moment ages out of the rolling hour, moments flow again.
  runSession(engine, clock, 10.5 * MIN, { game: 'g6' });
  assert.equal(moments.filter(m => m.type === 'recap').length, 6);
  assert.equal(moments[moments.length - 1].game, 'g6');
});
