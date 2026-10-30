// js/capture-gallery-model.js: the gallery's pure parts. Pinned here: days
// group in order with Today/Yesterday, clip lengths read like a player,
// the trim handles never cross or leave the clip, a trim that keeps
// everything is not one, and every server error code has words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const M = require('../js/capture-gallery-model.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));

test('groupByDay: today, yesterday, then dates, newest first; bad entries skipped', () => {
  const now = new Date(2026, 9, 27, 12, 0).getTime();
  const at = (d, h) => new Date(2026, 9, d, h, 0).getTime();
  const groups = M.groupByDay([
    { id: 'a', createdAt: at(27, 11) }, { id: 'b', createdAt: at(27, 0) },
    { id: 'c', createdAt: at(26, 23) }, null, { id: 'x' },
    { id: 'd', createdAt: at(20, 9) },
  ], now);
  assert.deepEqual(groups.map(g => [g.when, g.items.map(i => i.id)]), [['today', ['a', 'b']], ['yesterday', ['c']], ['date', ['d']]]);
  assert.equal(groups[2].at, at(20, 9));
  assert.deepEqual(M.groupByDay(null, now), []);
});

test('groupByDay: yesterday is right across a month boundary', () => {
  const now = new Date(2026, 10, 1, 8, 0).getTime();
  const g = M.groupByDay([{ id: 'a', createdAt: new Date(2026, 9, 31, 22, 0).getTime() }], now);
  assert.equal(g[0].when, 'yesterday');
});

test('stamp: m:ss, h:mm:ss, tenths on the trim bar, never negative', () => {
  assert.equal(M.stamp(65), '1:05');
  assert.equal(M.stamp(5.6), '0:06');
  assert.equal(M.stamp(3725), '1:02:05');
  assert.equal(M.stamp(65.47, true), '1:05.4');
  assert.equal(M.stamp(-3), '0:00');
  assert.equal(M.stamp('x', true), '0:00.0');
});

test('clampRange: a handle stays in the clip and pushes the other one back, keeping half a second', () => {
  const r = { start: 2, end: 8 };
  assert.deepEqual(M.clampRange(r, 'start', 3, 10), { start: 3, end: 8 });
  assert.deepEqual(M.clampRange(r, 'start', 9.9, 10), { start: 9.5, end: 10 });
  assert.deepEqual(M.clampRange(r, 'start', -4, 10), { start: 0, end: 8 });
  assert.deepEqual(M.clampRange(r, 'end', 1, 10), { start: 0.5, end: 1 });
  assert.deepEqual(M.clampRange(r, 'end', 0, 10), { start: 0, end: 0.5 });
  assert.deepEqual(M.clampRange(r, 'end', 99, 10), { start: 2, end: 10 });
  // A clip shorter than the minimum: everything, never past its end.
  const tiny = M.clampRange({ start: 0, end: 0.3 }, 'end', 0.1, 0.3);
  assert.ok(tiny.end <= 0.3 && tiny.start >= 0 && tiny.start <= tiny.end);
});

test('trimChanges: the whole clip is not a trim, a tenth off either end is', () => {
  assert.equal(M.trimChanges({ start: 0, end: 10 }, 10), false);
  assert.equal(M.trimChanges({ start: 0.02, end: 9.98 }, 10), false);
  assert.equal(M.trimChanges({ start: 0.1, end: 10 }, 10), true);
  assert.equal(M.trimChanges({ start: 0, end: 9.9 }, 10), true);
});

test('errorText: every code has a key in all 11 languages; unknown codes get the plain one', () => {
  const i18n = readFileSync(path.join(HERE, '..', 'js', 'i18n.js'), 'utf8');
  const codes = ['busy', 'too_short', 'empty', 'disk_full', 'unavailable', 'not_found', 'copy_failed', 'delete_failed', 'weird'];
  for (const code of codes) {
    const [key, fallback] = M.errorText(code);
    assert.ok(fallback && !/—/.test(fallback), code);
    assert.equal((i18n.match(new RegExp(`\\b${key}:`, 'g')) || []).length, 11, key);
  }
  assert.equal(M.errorText('weird')[0], 'capg_err_failed');
});

test('isVideo and gameLabel', () => {
  assert.equal(M.isVideo({ kind: 'replay' }), true);
  assert.equal(M.isVideo({ kind: 'recording' }), true);
  assert.equal(M.isVideo({ kind: 'screenshot' }), false);
  assert.equal(M.isVideo(null), false);
  assert.equal(M.gameLabel('Game.EXE'), 'Game');
  assert.equal(M.gameLabel(null), '');
});

test('export: errors have keys in all 11 languages, a long clip warns before a GIF, sizes read as MB', () => {
  const i18n = readFileSync(path.join(HERE, '..', 'js', 'i18n.js'), 'utf8');
  for (const code of ['busy', 'too_long', 'too_big', 'no_webcam', 'already_small', 'disk_full', 'weird']) {
    const [key, fallback] = M.exportErrorText(code);
    assert.ok(fallback && !/—/.test(fallback), code);
    assert.equal((i18n.match(new RegExp(`\\b${key}:`, 'g')) || []).length, 11, key);
  }
  assert.equal(M.exportErrorText('busy')[0], 'capg_exp_err_busy', 'busy is another copy, not a trim');
  assert.equal(M.gifIsLong({ seconds: 15 }), false);
  assert.equal(M.gifIsLong({ seconds: 15.5 }), true);
  assert.equal(M.gifIsLong(null), false);
  assert.equal(M.megabytes(23100000, 'en'), '23.1 MB');
  assert.equal(M.megabytes(23100000, 'it'), '23,1 MB');
  assert.equal(M.megabytes(-5, 'en'), '0 MB');
  assert.deepEqual(M.EXPORT_SIZES_MB, [10, 25, 50, 100]);
});
