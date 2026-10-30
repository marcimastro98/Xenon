import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createPower } = require('../power/index.js');
const linux = require('../power/linux.js');

function fakeBackend(state, opts = {}) {
  const calls = { read: 0, set: [] };
  return {
    calls,
    available: () => opts.available !== false,
    read: async () => { calls.read++; if (opts.throws) throw new Error('boom'); return { ...state }; },
    setMode: async (m) => { calls.set.push(m); return opts.setResult || { ok: true }; },
  };
}

const balanced = { battery: { percent: 70, plugged: false, charging: false, minutesLeft: 120 }, saver: false, mode: 'balanced', modes: ['saver', 'balanced', 'performance'], canSet: true };

test('read is cached and shared', async () => {
  let t = 0;
  const b = fakeBackend(balanced);
  const p = createPower(b, () => t);
  const [a, c] = await Promise.all([p.read(), p.read()]);
  assert.deepEqual(a, balanced);
  assert.equal(a, c);
  assert.equal(b.calls.read, 1);
  t = 2999; await p.read(); assert.equal(b.calls.read, 1);
  t = 3000; await p.read(); assert.equal(b.calls.read, 2);
});

test('no backend, or a failing one, reads as null', async () => {
  assert.equal(await createPower(null).read(), null);
  assert.equal(createPower(null).available(), false);
  assert.equal(await createPower(fakeBackend(balanced, { available: false })).read(), null);
  assert.equal(await createPower(fakeBackend(balanced, { throws: true })).read(), null);
  assert.deepEqual(await createPower(null).setMode('saver'), { ok: false, error: 'unavailable' });
});

test('setMode checks the mode, what this machine allows, and the current one', async () => {
  const b = fakeBackend(balanced);
  const p = createPower(b, () => 0);
  assert.deepEqual(await p.setMode('turbo'), { ok: false, error: 'bad_mode' });
  assert.deepEqual(await p.setMode('balanced'), { ok: true, mode: 'balanced', changed: false });
  assert.deepEqual(b.calls.set, []);
  assert.deepEqual(await p.setMode('saver'), { ok: true, mode: 'saver', changed: true });
  assert.deepEqual(b.calls.set, ['saver']);
  // The cache was dropped: the next read asks the system again.
  await p.read(); assert.equal(b.calls.read, 2);
});

test('setMode passes the reason a mode cannot be changed', async () => {
  const plan = createPower(fakeBackend({ ...balanced, mode: null, modes: [], canSet: false, why: 'plan' }));
  assert.deepEqual(await plan.setMode('saver'), { ok: false, error: 'plan' });
  const two = createPower(fakeBackend({ ...balanced, modes: ['saver', 'balanced'] }));
  assert.deepEqual(await two.setMode('performance'), { ok: false, error: 'mode_missing' });
  const fails = createPower(fakeBackend(balanced, { setResult: { ok: false, error: 'no_daemon' } }));
  assert.deepEqual(await fails.setMode('saver'), { ok: false, error: 'no_daemon' });
});

test('lastKnown starts a read behind the last answer', async () => {
  let t = 0;
  const b = fakeBackend(balanced);
  const p = createPower(b, () => t);
  assert.equal(p.lastKnown(), null);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(p.lastKnown(), balanced);
  assert.equal(b.calls.read, 1);
});

test('linux backend reads a power_supply tree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-psu-'));
  try {
    const put = (dev, vals) => {
      fs.mkdirSync(path.join(root, dev));
      for (const [k, v] of Object.entries(vals)) fs.writeFileSync(path.join(root, dev, k), `${v}\n`);
    };
    put('AC', { type: 'Mains', online: 1 });
    put('BAT0', { type: 'Battery', capacity: 81, status: 'Charging' });
    put('hidpp_battery_0', { type: 'Battery', scope: 'Device', capacity: 10, status: 'Discharging' });
    const r = await linux.read({ root });
    assert.deepEqual(r.battery, { percent: 81, plugged: true, charging: true, minutesLeft: null });
    // powerprofilesctl is not on this machine (or answers): either way a shape comes back.
    assert.equal(typeof r.canSet, 'boolean');
    const empty = await linux.read({ root: path.join(root, 'missing') });
    assert.equal(empty.battery, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
