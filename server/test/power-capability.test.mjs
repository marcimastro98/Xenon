import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const { nextMode } = require('../capabilities/power.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');

function fakePower(state) {
  const set = [];
  return {
    set,
    available: () => true,
    lastKnown: () => state,
    read: async () => state,
    setMode: async (m) => { set.push(m); return { ok: true, mode: m, changed: true }; },
  };
}

const laptop = { battery: { percent: 50, plugged: false, charging: false, minutesLeft: 90 }, saver: false, mode: 'balanced', modes: ['saver', 'balanced', 'performance'], canSet: true };
const desktopHighPerf = { battery: null, saver: false, mode: null, modes: [], canSet: false, why: 'plan' };

test('probes: status readable anywhere, the key only where the mode can change', () => {
  assert.deepEqual(pick(createCapabilities({ power: fakePower(laptop) }).probes()), { powerStatus: true, powerMode: true });
  assert.deepEqual(pick(createCapabilities({ power: fakePower(desktopHighPerf) }).probes()), { powerStatus: true, powerMode: false });
  assert.deepEqual(pick(createCapabilities({}).probes()), { powerStatus: false, powerMode: false });
  function pick(p) { return { powerStatus: p.powerStatus, powerMode: p.powerMode }; }
});

test('next walks the modes this PC offers, and wraps', () => {
  assert.equal(nextMode(laptop), 'performance');
  assert.equal(nextMode({ ...laptop, mode: 'performance' }), 'saver');
  assert.equal(nextMode({ ...laptop, mode: null }), 'saver');
  assert.equal(nextMode({ ...laptop, mode: 'saver', modes: ['saver', 'balanced'] }), 'balanced');
  assert.equal(nextMode({ ...laptop, modes: [] }), null);
});

test('run: a key sets a mode, next cycles, status reads', async () => {
  const power = fakePower(laptop);
  const caps = createCapabilities({ power });
  assert.deepEqual(await caps.run({ type: 'powerMode', mode: 'saver' }), { ok: true, mode: 'saver', changed: true });
  await caps.run({ type: 'powerMode', mode: 'next' });
  assert.deepEqual(power.set, ['saver', 'performance']);
  const st = await caps.run({ type: 'powerStatus' });
  assert.equal(st.ok, true);
  assert.equal(st.battery.percent, 50);
});

test('run: where the mode cannot change the key is unavailable, status says why', async () => {
  const caps = createCapabilities({ power: fakePower(desktopHighPerf) });
  assert.deepEqual(await caps.run({ type: 'powerMode', mode: 'saver' }), { ok: false, error: 'unavailable' });
  const st = await caps.run({ type: 'powerStatus' });
  assert.equal(st.why, 'plan');
  assert.equal(st.battery, null);
});

test('Bit: set_power_mode only where it can work, get_power_status everywhere it reads', () => {
  const names = (p) => aiFunctions(p).map((f) => f.name);
  const lap = createCapabilities({ power: fakePower(laptop) }).probes();
  const desk = createCapabilities({ power: fakePower(desktopHighPerf) }).probes();
  assert.ok(names(lap).includes('set_power_mode'));
  assert.ok(names(lap).includes('get_power_status'));
  assert.ok(!names(desk).includes('set_power_mode'));
  assert.ok(names(desk).includes('get_power_status'));
  assert.deepEqual(aiAction('set_power_mode', { mode: 'performance', extra: 1 }), { type: 'powerMode', mode: 'performance' });
  const fn = aiFunctions(lap).find((f) => f.name === 'set_power_mode');
  assert.deepEqual(fn.parameters.properties.mode.enum, ['next', 'saver', 'balanced', 'performance']);
});

test('catalog: the key sits in the performance group, the status is hidden', () => {
  const key = CAPABILITIES.find((c) => c.type === 'powerMode');
  const st = CAPABILITIES.find((c) => c.type === 'powerStatus');
  assert.equal(key.group, 'perf');
  assert.equal(key.capability.risk, 'safe');
  assert.equal(st.hidden, true);
});
