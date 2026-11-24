// Lights another part of Xenon holds (server/lighting-native/held.js: the LINK hub Airflow
// drives) in the native device list: listed, owned and painted like a board Xenon drives,
// darkened when the lights let go or the PC goes down, and announced when they come or go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const held = require('../lighting-native/held.js');
const native = require('../lighting-native/index.js');

function source(id) {
  const s = { written: [], offs: 0, on: true };
  Object.assign(s, {
    devices: () => (s.on ? [{ id, source: 'native', ledIds: [1, 2] }] : []),
    owns: (x) => s.on && x === id,
    write: (dev, colors) => { if (!s.on || dev.id !== id) return false; s.written.push(colors); return true; },
    off: async () => { s.offs++; },
  });
  return s;
}

test('a held device joins the native list and takes its own frames, none while the PC is down', async () => {
  let changes = 0;
  held.setChangeHook(() => changes++);
  const hub = source('hub');
  const remove = held.addSource(hub);
  assert.deepEqual(native.devices().map((d) => d.id), ['hub']);
  assert.equal(native.hasDevices(), true);
  assert.equal(native.owns('hub'), true);
  assert.equal(native.owns('other'), false);
  native.write({ id: 'hub', ledIds: [1, 2] }, ['a', 'b']);
  assert.deepEqual(hub.written, [['a', 'b']]);
  await native.powerDown();
  assert.equal(hub.offs, 1, 'dark before the PC goes off');
  native.write({ id: 'hub', ledIds: [1, 2] }, ['c', 'd']);
  assert.equal(hub.written.length, 1, 'nothing painted while down');
  native.resume();
  await native.release();
  assert.equal(hub.offs, 2, 'dark when the lights let go: there is no effect of its own to go back to');
  hub.on = false;
  assert.equal(native.hasDevices(), false, 'not held any more: gone from the list');
  remove();
  assert.equal(changes, 1, 'removing a source is announced');
  remove();
  assert.equal(changes, 1);
  held.setChangeHook(null);
});

test('a source that fails to go dark does not hold up the others', async () => {
  const bad = { ...source('a'), off: async () => { throw new Error('unplugged'); } };
  const good = source('b');
  const r1 = held.addSource(bad);
  const r2 = held.addSource(good);
  await held.off();
  assert.equal(good.offs, 1);
  r1(); r2();
});
