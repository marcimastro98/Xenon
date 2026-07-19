// SDK widget performance accounting (js/sdk-perf.js) — report validation,
// per-package folding/strikes and the ok/busy/heavy classification behind the
// Installed tab's activity chip and the one-time heavy-widget toast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SdkPerf = require('../js/sdk-perf.js');

const report = (over = {}) => ({ windowMs: 12000, longTaskMs: 0, longTasks: 0, fps: 60, layoutShifts: 0, ...over });

test('validatePerfReport accepts a sane report and rounds counters', () => {
  const r = SdkPerf.validatePerfReport(report({ longTaskMs: 120.6, longTasks: 3.4, fps: 59.7, layoutShifts: 2.9 }));
  assert.ok(r);
  assert.equal(r.longTasks, 3);
  assert.equal(r.fps, 60);
  assert.equal(r.layoutShifts, 3);
});

test('validatePerfReport rejects garbage, out-of-cap and inconsistent reports', () => {
  assert.equal(SdkPerf.validatePerfReport(null), null);
  assert.equal(SdkPerf.validatePerfReport({}), null);
  assert.equal(SdkPerf.validatePerfReport(report({ windowMs: 500 })), null);          // below floor
  assert.equal(SdkPerf.validatePerfReport(report({ windowMs: 120000 })), null);       // above cap
  assert.equal(SdkPerf.validatePerfReport(report({ longTaskMs: NaN })), null);
  assert.equal(SdkPerf.validatePerfReport(report({ fps: Infinity })), null);
  assert.equal(SdkPerf.validatePerfReport(report({ fps: 999 })), null);
  assert.equal(SdkPerf.validatePerfReport(report({ longTaskMs: '400' })), null);      // strings never coerce
  // More blocked time than wall time is a forgery, not a measurement.
  assert.equal(SdkPerf.validatePerfReport(report({ windowMs: 5000, longTaskMs: 6000 })), null);
});

test('classifyPerf: heavy needs sustained strikes, one spike stays busy/ok', () => {
  let agg = null;
  const hot = SdkPerf.validatePerfReport(report({ longTaskMs: 500, longTasks: 5 }));
  const calm = SdkPerf.validatePerfReport(report({ longTaskMs: 10 }));
  agg = SdkPerf.foldPerfReport(agg, hot, true, 1);
  assert.equal(SdkPerf.classifyPerf(agg), 'busy');       // 1 strike ≠ heavy
  agg = SdkPerf.foldPerfReport(agg, hot, true, 2);
  agg = SdkPerf.foldPerfReport(agg, hot, true, 3);
  assert.equal(SdkPerf.classifyPerf(agg), 'heavy');      // 3 consecutive
  agg = SdkPerf.foldPerfReport(agg, calm, true, 4);
  assert.equal(SdkPerf.classifyPerf(agg), 'ok');         // strike streak broken
});

test('classifyPerf: a calm window between spikes resets the streak', () => {
  let agg = null;
  const hot = SdkPerf.validatePerfReport(report({ longTaskMs: 500 }));
  const calm = SdkPerf.validatePerfReport(report({ longTaskMs: 0 }));
  agg = SdkPerf.foldPerfReport(agg, hot, true, 1);
  agg = SdkPerf.foldPerfReport(agg, hot, true, 2);
  agg = SdkPerf.foldPerfReport(agg, calm, true, 3);
  agg = SdkPerf.foldPerfReport(agg, hot, true, 4);
  agg = SdkPerf.foldPerfReport(agg, hot, true, 5);
  assert.equal(SdkPerf.classifyPerf(agg), 'busy');       // never 3 in a row
});

test('low FPS counts only while visible (parked/service frames are throttled by design)', () => {
  let agg = null;
  const slow = SdkPerf.validatePerfReport(report({ fps: 5 }));
  agg = SdkPerf.foldPerfReport(agg, slow, false, 1);
  agg = SdkPerf.foldPerfReport(agg, slow, false, 2);
  agg = SdkPerf.foldPerfReport(agg, slow, false, 3);
  assert.equal(SdkPerf.classifyPerf(agg), 'ok');         // hidden → FPS never strikes
  agg = SdkPerf.foldPerfReport(agg, slow, true, 4);
  agg = SdkPerf.foldPerfReport(agg, slow, true, 5);
  agg = SdkPerf.foldPerfReport(agg, slow, true, 6);
  assert.equal(SdkPerf.classifyPerf(agg), 'heavy');
});

test('fps of 0 never strikes (no rAF ticks = fully throttled, not janky)', () => {
  let agg = null;
  const dead = SdkPerf.validatePerfReport(report({ fps: 0 }));
  for (let i = 0; i < 5; i++) agg = SdkPerf.foldPerfReport(agg, dead, true, i);
  assert.equal(SdkPerf.classifyPerf(agg), 'ok');
});

test('ring stays bounded and longTaskMsPerMin averages over it', () => {
  let agg = null;
  const r = SdkPerf.validatePerfReport(report({ longTaskMs: 600, windowMs: 12000 }));
  for (let i = 0; i < 25; i++) agg = SdkPerf.foldPerfReport(agg, r, true, i);
  assert.equal(agg.ring.length, 10);
  // 600ms per 12s window → 3000ms per minute.
  assert.equal(SdkPerf.longTaskMsPerMin(agg), 3000);
});

test('normalizeSuspended: dedupes, drops bad ids, caps at 32, tolerates non-arrays', () => {
  const re = /^[a-z0-9][a-z0-9-]{1,40}$/;
  assert.deepEqual(SdkPerf.normalizeSuspended(['a-widget', 'a-widget', 'B!', 42, 'ok-two'], re), ['a-widget', 'ok-two']);
  assert.deepEqual(SdkPerf.normalizeSuspended('nope', re), []);
  assert.deepEqual(SdkPerf.normalizeSuspended(null, re), []);
  const many = Array.from({ length: 50 }, (_, i) => 'pkg-' + i);
  assert.equal(SdkPerf.normalizeSuspended(many, re).length, 32);
});
