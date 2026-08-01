'use strict';
// A Performance Mode session must not outlive the app it was started for —
// and must not end while that app is still running.
//
// Found on a real install: a session started by hand for `planetcoaster2`, still
// active with the game long gone, holding the whole dashboard's animations
// paused. Auto sessions already end themselves when the activity stops; a MANUAL
// one had no end condition at all, and the only visible symptom was that
// everything had stopped moving — which reads as a broken app, not as a setting
// somebody left on.
//
// The first attempt at the fix asked /api/performance/stats whether the process
// was there. That is a TOP-40-BY-RAM RANKING built for the "close these apps"
// sheet, not a process list, and Windows trims a minimised process's working set
// hard: a minimised game drops off the list while still running. Ending the
// session then reverts the power plan and drops the priority boost under a LIVE
// game, with a toast saying it had finished. The oracle is now
// perf-priority.ps1's own Get-Process lookup, whose `not_found` is an exact
// answer. Both halves are pinned below, because the wrong oracle passed a test
// that only checked "absent → end it".
//
// js/performance.js is a browser IIFE with no exports, so the decision is
// re-implemented here from the source: the test owns the TRUTH TABLE, and the
// grep guards at the bottom fail if the real code drifts away from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'js', 'performance.js'), 'utf8');
const PS = fs.readFileSync(path.join(HERE, '..', 'perf-priority.ps1'), 'utf8');
const STATS_PS = fs.readFileSync(path.join(HERE, '..', 'performance.ps1'), 'utf8');

// The probe, modelled: what a setPriority reply means. Mirrors _boostedAlive().
function alive(reply) {
  if (reply && reply.ok) return true;
  if (reply && reply.error === 'not_found') return false;
  return null;                                   // nobody answered
}

// The decision, modelled. Mirrors _checkStale(): a first `false` only schedules
// a recheck; only a second one ends the session.
function decide(replies) {
  const seen = [];
  for (const r of replies) {
    const a = alive(r);
    if (a !== false) { seen.length = 0; continue; }
    seen.push(a);
    if (seen.length >= 2) return 'restore';
  }
  return seen.length ? 'recheck-pending' : 'keep';
}

const GONE = { ok: false, error: 'not_found' };
const RUNNING = { ok: true, count: 1 };

test('a session ends after the app it was started for is gone', () => {
  assert.equal(decide([RUNNING, GONE, GONE]), 'restore');
});

test('one absence is not enough — an app that is restarting keeps its session', () => {
  assert.equal(decide([GONE]), 'recheck-pending');
  assert.equal(decide([GONE, RUNNING]), 'keep', 'coming back cancels it');
  assert.equal(decide([GONE, RUNNING, GONE]), 'recheck-pending', 'and the count starts again');
});

test('a reply that is not an answer never ends a session', () => {
  // Off Windows the script cannot run at all; `unavailable`, a thrown fetch and
  // a malformed body all arrive here. Reading any of them as "the app is gone"
  // would end every session on every non-Windows machine.
  for (const r of [null, undefined, {}, { ok: false }, { ok: false, error: 'unavailable' },
    { ok: false, error: 'protected' }, { ok: false, error: 'priority_failed' }]) {
    assert.equal(alive(r), null, JSON.stringify(r));
    assert.equal(decide([r, r, r]), 'keep', JSON.stringify(r));
  }
});

test('only an explicit not_found counts as gone', () => {
  assert.equal(alive(GONE), false);
  assert.equal(alive(RUNNING), true);
  // ok:false with a count is the script saying it found the process but could
  // not change it — still running.
  assert.equal(alive({ ok: false, count: 0 }), null);
});

// ── the oracle itself has to keep being an oracle ────────────────────────────

test('perf-priority.ps1 really answers not_found from a process lookup', () => {
  assert.match(PS, /Get-Process -Name \$n/, 'it looks the process up by name');
  assert.match(PS, /if \(-not \$procs\) \{ Write-Output '\{"ok":false,"error":"not_found"\}'/,
    'and says not_found when there is none');
  // The probe re-asserts the level the session already applied, so it has to be
  // a no-op on a live process rather than a change.
  assert.match(PS, /if \(\$level -eq 'high'\)/, "'high' is a level it accepts");
});

test('performance.ps1 stats is still a ranking, which is why it is not the oracle', () => {
  // If this ever stops being a top-N, the comment in performance.js explaining
  // why stats cannot answer this question needs revisiting — but until then the
  // trap is real and this pins it.
  assert.match(STATS_PS, /Select-Object -First 40/, 'stats is capped, so absence proves nothing');
});

test('performance.js implements this the way the table above models it', () => {
  assert.match(SRC, /_boostedAlive/, 'the probe exists');
  assert.match(SRC, /error === 'not_found'/, 'and keys on the exact answer');
  assert.match(SRC, /_syncStaleWatch\(\);/, 'the watch is started from applyState()');
  assert.match(SRC, /_staleRecheck = setTimeout/, 'a first absence only schedules a recheck');
  assert.match(SRC, /restore\(\{ auto: true \}\)/, 'ending it goes through the normal restore, which toasts');
  assert.match(SRC, /if \(!document\.hidden\) _checkStale\(false\)/, 'the poll is gated on the tab being visible');

  const fn = SRC.slice(SRC.indexOf('async function _boostedAlive'), SRC.indexOf('function _syncStaleWatch'));
  // The bug this file exists for: the ranking must not come back.
  assert.ok(!/fetchStats/.test(fn), 'the RAM ranking is not the liveness oracle');
  // And the whole point of the feature: a manual session must be ended by this
  // too, unlike _scheduleAutoRestore which is gated on activatedBy === auto.
  assert.ok(!/activatedBy/.test(fn), 'a manual session is ended by this as well');
});
