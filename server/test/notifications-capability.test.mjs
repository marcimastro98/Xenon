// capabilities/notifications.js: "non disturbare", "togli i suoni delle notifiche".
// Pinned here: Do not disturb takes the Settings modes and toggles always <-> auto,
// the switches change only what was named (none = a read), bad input is refused
// without a write, and the server writes under the lock and restarts the watchers
// only when the master switch moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');

function fakeNotifications(start) {
  let state = { enabled: true, popups: true, sounds: true, quiet: 'auto', onScreen: true, ...start };
  const writes = [];
  return {
    writes,
    get: () => state,
    set: async (change) => { writes.push(change); state = { ...state, ...change }; return state; },
  };
}

test('Do not disturb: a mode, and toggle between always and auto', async () => {
  const n = fakeNotifications({ quiet: 'off' });
  const caps = createCapabilities({ notifications: n });
  assert.equal(caps.probes().notifications, true);
  assert.equal((await caps.run({ type: 'dnd', mode: 'toggle' })).quiet, 'always');
  assert.equal((await caps.run({ type: 'dnd', mode: 'toggle' })).quiet, 'auto');
  const off = await caps.run({ type: 'dnd', mode: 'off' });
  assert.deepEqual(off, { ok: true, enabled: true, popups: true, sounds: true, quiet: 'off' });
  const bad = await caps.run({ type: 'dnd', mode: 'maybe' });
  assert.deepEqual([bad.ok, bad.error, bad.choices], [false, 'bad_mode', ['toggle', 'auto', 'always', 'off']]);
  assert.equal(n.writes.length, 3, 'a refused mode writes nothing');
});

test('switches: only the named ones change; none reads', async () => {
  const n = fakeNotifications();
  const caps = createCapabilities({ notifications: n });
  const read = await caps.run({ type: 'notifications' });
  assert.deepEqual(read, { ok: true, enabled: true, popups: true, sounds: true, quiet: 'auto' });
  assert.equal(n.writes.length, 0);
  const muted = await caps.run({ type: 'notifications', sounds: 'off', popups: 'keep', enabled: 'perhaps' });
  assert.deepEqual(n.writes, [{ sounds: false }]);
  assert.equal(muted.sounds, false);
  assert.equal((await caps.run({ type: 'notifications', enabled: 'off' })).enabled, false);
});

test('without the settings writer both say unavailable and the probe is false', async () => {
  const caps = createCapabilities({});
  assert.equal(caps.probes().notifications, false);
  assert.equal((await caps.run({ type: 'dnd', mode: 'always' })).error, 'unavailable');
  assert.equal((await caps.run({ type: 'notifications' })).error, 'unavailable');
});

test('Bit gets set_do_not_disturb and set_notifications', () => {
  const fns = aiFunctions({ notifications: true });
  const dnd = fns.find((f) => f.name === 'set_do_not_disturb');
  assert.deepEqual(dnd.parameters.properties.mode.enum, ['toggle', 'always', 'auto', 'off']);
  const sw = fns.find((f) => f.name === 'set_notifications');
  assert.deepEqual(Object.keys(sw.parameters.properties), ['enabled', 'popups', 'sounds']);
  assert.equal(aiFunctions({ notifications: false }).some((f) => f.name === 'set_notifications'), false);
  assert.deepEqual(aiAction('set_notifications', { sounds: 'off', path: 'x' }), { type: 'notifications', sounds: 'off' });
});

test('the server writes under the lock and restarts watchers only on the master switch', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /notifications: \{\s+get: \(\) => normalizeNotifications\(/);
  const fn = src.slice(src.indexOf('async function updateNotificationsSetting('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /withHubSettingsLock/);
  assert.match(body, /every\(\(k\) => notifications\[k\] === before\[k\]\)\) return before/, 'no write when nothing changes');
  assert.match(body, /if \(masterChanged\) \{[\s\S]*refreshWinNotifWatch\(\)/);
});
