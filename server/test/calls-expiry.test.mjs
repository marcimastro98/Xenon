// A call nobody answers leaves by itself (calls.js): one timer for the whole list drops every
// card that is past its ring time, tells every surface, and waits for the next card. The clock
// and the timer are the test's own, so nothing here waits for real time.

import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const calls = require('../calls.js');

const START = Date.UTC(2026, 0, 15, 10, 0, 0);
const toast = (caller) => ({ app: 'Microsoft Teams', aumid: 'MSTeams_8wekyb3d8bbwe!MSTeams', title: caller, body: 'Incoming call' });

let sent;

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  sent = [];
  calls._resetForTest();
  calls.init({
    platform: 'win32',
    broadcast: (evt, payload) => sent.push({ evt, payload }),
    getSettings: () => ({ enabled: true, allowed: null, apps: [], push: false }),
    hotkeyAvailable: () => true,
    listWindows: async () => ({ windows: [] }),
  });
});

afterEach(() => {
  calls._resetForTest();
  mock.timers.reset();
});

test('a card that rang its whole time is dropped and every surface is told', () => {
  assert.ok(calls.onNotification(toast('Ada Example')));
  assert.equal(sent.length, 1);
  mock.timers.tick(calls.RING_TIMEOUT_MS - 1);
  assert.equal(calls.current().length, 1, 'one millisecond before the end it still rings');
  assert.equal(sent.length, 1);
  mock.timers.tick(1);
  assert.equal(calls.current().length, 0);
  assert.deepEqual(sent.at(-1), { evt: 'calls', payload: { calls: [] } });
  assert.equal(sent.length, 2);
});

test('the timer waits for the next card after the first one left', () => {
  calls.onNotification(toast('Ada Example'));
  mock.timers.tick(10000);
  calls.onNotification(toast('Bo Example'));
  assert.equal(calls.current().length, 2);
  mock.timers.tick(calls.RING_TIMEOUT_MS - 10000);
  assert.deepEqual(calls.current().map((call) => call.caller), ['Bo Example'], 'only the card past its time left');
  mock.timers.tick(10000);
  assert.equal(calls.current().length, 0);
  assert.equal(sent.length, 4, 'two rings and two departures, each told once');
});

test('after stop the timer is gone: nothing is dropped or told later', () => {
  calls.onNotification(toast('Ada Example'));
  calls.stop();
  const told = sent.length;
  mock.timers.tick(calls.RING_TIMEOUT_MS * 2);
  assert.equal(sent.length, told);
  assert.equal(calls.onNotification(toast('Bo Example')), null, 'a stopped relay rings nothing');
});

test('a silenced card still ends with the ring, and an empty list arms no timer', async () => {
  const rec = calls.onNotification(toast('Ada Example'));
  await calls.act(rec.id, 'silence');
  assert.equal(calls.current()[0].silenced, true);
  mock.timers.tick(calls.RING_TIMEOUT_MS);
  assert.equal(calls.current().length, 0, 'a silenced card still ends with the ring');
  const told = sent.length;
  mock.timers.tick(calls.RING_TIMEOUT_MS);
  assert.equal(sent.length, told, 'an empty list arms no timer');
});
