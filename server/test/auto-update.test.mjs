import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// decide() is the whole policy of automatic updates. Every rule gets a test of
// its own, and each blocker is tested alone, so a rule cannot quietly stop
// being enforced because another one happened to cover the same case.
const require = createRequire(import.meta.url);
const { decide, hasNoAutoMarker, inNightWindow, MIN_AGE_MS, IDLE_MIN_SEC } = require('../auto-update.js');

const NOW = Date.parse('2026-10-10T14:00:00Z');
const H = 60 * 60 * 1000;

// A state in which everything allows an install right now.
function ready(over) {
  return {
    enabled: true, supported: true, needsElevation: false,
    current: '4.11.10', latest: '4.12.0',
    publishedAt: new Date(NOW - 48 * H).toISOString(),
    noAuto: false, failedVersion: '', stagedVersion: '4.12.0',
    prepareBlockedUntil: 0, postponedUntil: 0,
    blockers: [], idleSec: IDLE_MIN_SEC + 60, localHour: 14,
    ...over,
  };
}

test('a quiet PC with a verified, day-old release installs it', () => {
  assert.deepEqual(decide(ready(), NOW), { action: 'apply', reason: 'ready' });
});

test('switched off: nothing, whatever else is true', () => {
  assert.equal(decide(ready({ enabled: false }), NOW).reason, 'disabled');
  assert.equal(decide(ready({ enabled: false }), NOW).action, 'hold');
});

test('an install that cannot update itself holds', () => {
  assert.deepEqual(decide(ready({ supported: false }), NOW), { action: 'hold', reason: 'unsupported' });
});

test('no newer version: waits, and never downgrades', () => {
  assert.equal(decide(ready({ latest: '4.11.10' }), NOW).reason, 'up_to_date');
  assert.equal(decide(ready({ latest: '4.11.9' }), NOW).reason, 'up_to_date');
  assert.equal(decide(ready({ latest: '' }), NOW).reason, 'up_to_date');
  assert.equal(decide(ready({ latest: 'garbage' }), NOW).reason, 'up_to_date');
  assert.equal(decide(ready({ latest: 'v4.12.0', current: 'v4.12.0' }), NOW).reason, 'up_to_date');
});

test('the no-auto marker keeps a release manual', () => {
  assert.deepEqual(decide(ready({ noAuto: true }), NOW), { action: 'hold', reason: 'no_auto_release' });
  assert.equal(hasNoAutoMarker('Notes\n<!-- xenon:no-auto -->\nmore'), true);
  assert.equal(hasNoAutoMarker('<!--xenon:NO-AUTO-->'), true);
  assert.equal(hasNoAutoMarker('xenon:no-auto in plain text is not the marker'), false);
  assert.equal(hasNoAutoMarker(''), false);
});

test('a version that failed automatically is never retried automatically', () => {
  assert.deepEqual(decide(ready({ failedVersion: '4.12.0' }), NOW), { action: 'hold', reason: 'failed_before' });
  assert.equal(decide(ready({ failedVersion: 'v4.12.0' }), NOW).reason, 'failed_before');
  // A NEWER release after a failed one is a fresh chance.
  assert.equal(decide(ready({ failedVersion: '4.11.11' }), NOW).action, 'apply');
});

test('a UAC prompt nobody can answer keeps it manual', () => {
  assert.deepEqual(decide(ready({ needsElevation: true }), NOW), { action: 'hold', reason: 'needs_elevation' });
});

test('24 hours after publishing, not a minute before', () => {
  const at = (msOld) => decide(ready({ publishedAt: new Date(NOW - msOld).toISOString() }), NOW);
  assert.equal(at(MIN_AGE_MS - 60000).reason, 'too_new');
  assert.equal(at(MIN_AGE_MS - 60000).eligibleAt, NOW + 60000);
  assert.equal(at(MIN_AGE_MS).action, 'apply');
  assert.equal(at(MIN_AGE_MS + 1).action, 'apply');
  // An unknown publish date cannot prove the day has passed.
  assert.equal(decide(ready({ publishedAt: '' }), NOW).reason, 'too_new');
  assert.equal(decide(ready({ publishedAt: 'not a date' }), NOW).reason, 'too_new');
  // Numbers work as well as ISO strings; the override exists for the E2E run.
  assert.equal(decide(ready({ publishedAt: NOW, minAgeMs: 0 }), NOW).action, 'apply');
});

test('not downloaded yet: download first, then wait out a failed download', () => {
  assert.deepEqual(decide(ready({ stagedVersion: '' }), NOW), { action: 'prepare', reason: 'download' });
  assert.equal(decide(ready({ stagedVersion: '4.11.11' }), NOW).action, 'prepare', 'an older staged build is not this one');
  assert.equal(decide(ready({ stagedVersion: 'v4.12.0' }), NOW).action, 'apply');
  assert.equal(decide(ready({ stagedVersion: '', prepareBlockedUntil: NOW + 1 }), NOW).reason, 'prepare_retry');
  assert.equal(decide(ready({ stagedVersion: '', prepareBlockedUntil: NOW }), NOW).action, 'prepare');
});

test('postponed: waits until the hour is over', () => {
  assert.equal(decide(ready({ postponedUntil: NOW + 1 }), NOW).reason, 'postponed');
  assert.equal(decide(ready({ postponedUntil: NOW }), NOW).action, 'apply');
});

test('each thing in progress blocks the install on its own', () => {
  for (const b of ['game', 'performance', 'transfer', 'disk', 'claude', 'voice', 'call', 'signals_unavailable']) {
    const r = decide(ready({ blockers: [b] }), NOW);
    assert.deepEqual(r, { action: 'wait', reason: 'busy', blockers: [b] }, b);
  }
  assert.equal(decide(ready({ blockers: ['', null] }), NOW).action, 'apply', 'empty entries are not blockers');
});

test('someone at the PC: waits until 10 minutes without input', () => {
  assert.equal(decide(ready({ idleSec: IDLE_MIN_SEC - 1 }), NOW).reason, 'user_active');
  assert.equal(decide(ready({ idleSec: 0 }), NOW).reason, 'user_active');
  assert.equal(decide(ready({ idleSec: IDLE_MIN_SEC }), NOW).action, 'apply');
  assert.equal(decide(ready({ idleSec: 30, idleMinSec: 10 }), NOW).action, 'apply');
});

test('idle time unknown on this platform: only between 03:00 and 05:00', () => {
  for (let h = 0; h < 24; h++) {
    const r = decide(ready({ idleSec: null, localHour: h }), NOW);
    assert.equal(r.action, h >= 3 && h < 5 ? 'apply' : 'wait', 'hour ' + h);
    if (r.action === 'wait') assert.equal(r.reason, 'waiting_night');
  }
  assert.equal(inNightWindow(undefined), false);
  assert.equal(inNightWindow(NaN), false);
});

test('the order of the rules: the cheapest honest answer wins', () => {
  // Off beats everything, including a failed version or a blocker.
  assert.equal(decide(ready({ enabled: false, failedVersion: '4.12.0', blockers: ['game'] }), NOW).reason, 'disabled');
  // A kept-manual release is reported as such even while a game runs.
  assert.equal(decide(ready({ noAuto: true, blockers: ['game'] }), NOW).reason, 'no_auto_release');
  // Downloading is not blocked by a game: it changes nothing on the running install.
  assert.equal(decide(ready({ stagedVersion: '', blockers: ['game'], idleSec: 0 }), NOW).action, 'prepare');
});

test('decide() survives an empty or missing state', () => {
  assert.equal(decide(undefined, NOW).action, 'hold');
  assert.equal(decide({}, NOW).action, 'hold');
});
