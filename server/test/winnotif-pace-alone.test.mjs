// How often the notification reader looks, loaded on its own: the state module and the module
// that changes the pace, never server/notification-open/winnotif.js. The pace used to get its first value from a
// line of winnotif.js, so the state loaded by anything else had none, and the helper would have
// been started with "undefined" as its interval.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { notifWatch } = require('../notification-open/winnotif-state.js');
const atLoad = notifWatch.pollMs;
const { POLL_MS, POLL_GAME_MS, setPace } = require('../notification-open/winnotif-control.js');

test('the pace is loaded without winnotif.js', () => {
  const reader = path.join('server', 'notification-open/winnotif.js');
  assert.deepEqual(Object.keys(require.cache).filter((file) => file.endsWith(reader)), []);
});

test('the pace has its first value where it is declared, and it is the ordinary one', () => {
  assert.equal(atLoad, 2000);
  // The state cannot require the module that names the two paces (that one requires the state),
  // so the number is written twice: this is what keeps the two the same.
  assert.equal(atLoad, POLL_MS);
});

test('through a game the reader is told the slower pace once, and the ordinary one after it', () => {
  const told = [];
  notifWatch.proc = { stdin: { write: (line) => told.push(line) } };
  notifWatch.lastSpawnWasHelper = true;
  try {
    setPace(false);
    assert.deepEqual(told, [], 'already at the ordinary pace: nothing to tell');
    setPace(true);
    setPace(true);
    assert.equal(notifWatch.pollMs, POLL_GAME_MS);
    setPace(false);
    assert.equal(notifWatch.pollMs, POLL_MS);
    assert.deepEqual(told, [`${POLL_GAME_MS}\n`, `${POLL_MS}\n`]);
  } finally {
    notifWatch.proc = null;
    notifWatch.lastSpawnWasHelper = false;
  }
});

test('the fallback that does not listen keeps its pace in mind and is told nothing', () => {
  const told = [];
  notifWatch.proc = { stdin: { write: (line) => told.push(line) } };
  notifWatch.lastSpawnWasHelper = false;
  try {
    setPace(true);
    assert.equal(notifWatch.pollMs, POLL_GAME_MS);
    assert.deepEqual(told, []);
  } finally {
    setPace(false);
    notifWatch.proc = null;
  }
});
