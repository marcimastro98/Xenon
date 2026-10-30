// agenda-ai.js: "sposta il dentista a giovedì alle 15", "la spesa ogni giorno".
// Pinned here: the item is found by words (accents and case ignored) or id,
// several matches are listed instead of guessed, only the named fields change,
// bad dates are refused, and the server wires both tools with an undo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { editTask, editEvent, findItem } = require('../agenda-ai.js');

const tasks = () => [
  { id: 't1', text: 'Comprare il caffè', priority: 'medium', recurrence: 'never', recurrenceDays: 1 },
  { id: 't2', text: 'Chiamare il dentista', priority: 'low', recurrence: 'never', recurrenceDays: 1 },
  { id: 't3', text: 'Chiamare la banca', priority: 'low', recurrence: 'never', recurrenceDays: 1 },
];
const events = () => [
  { id: 'e1', title: 'Dentista', startsAt: '2026-11-02T10:00:00', endsAt: '', reminderAt: '2026-11-02T09:00:00', notifiedAt: '2026-11-02T09:00:01Z', notes: 'porta i raggi' },
  { id: 'e2', title: 'Cena da Luca', startsAt: '2026-11-03T20:00:00', endsAt: '', reminderAt: '', notifiedAt: '', notes: '' },
];

test('a task found by words changes only what is named', () => {
  const { next, result } = editTask(tasks(), { task: 'CAFFE', priority: 'high' });
  assert.deepEqual(result, { ok: true, task: { id: 't1', text: 'Comprare il caffè', priority: 'high', repeat: 'never' } });
  assert.equal(next[1].priority, 'low', 'the others stay');
  const daily = editTask(tasks(), { id: 't2', repeat: 'custom', every_days: 3, text: 'Chiamare il dentista per il controllo' });
  assert.deepEqual([daily.next[1].recurrence, daily.next[1].recurrenceDays, daily.next[1].text], ['custom', 3, 'Chiamare il dentista per il controllo']);
});

test('task refusals name what is wrong and write nothing', () => {
  assert.deepEqual(editTask(tasks(), { task: 'chiamare', priority: 'high' }).result,
    { ok: false, error: 'ambiguous', matches: ['Chiamare il dentista', 'Chiamare la banca'] });
  assert.deepEqual(editTask(tasks(), { task: 'palestra', priority: 'high' }), { next: null, result: { ok: false, error: 'not_found' } });
  assert.deepEqual(editTask(tasks(), { priority: 'high' }).result, { ok: false, error: 'missing_target' });
  assert.equal(editTask(tasks(), { task: 'caffe', priority: 'urgent' }).result.error, 'bad_priority');
  assert.equal(editTask(tasks(), { task: 'caffe', repeat: 'monthly' }).result.error, 'bad_repeat');
  assert.deepEqual(editTask(tasks(), { task: 'caffe' }).result, { ok: false, error: 'nothing_to_change' });
});

test('an event moves; a moved reminder rings again; "none" clears', () => {
  const moved = editEvent(events(), { event: 'dentista', starts_at: '2026-11-05T15:00:00', reminder_at: '2026-11-05T14:30:00' });
  assert.equal(moved.result.ok, true);
  const e = moved.next[0];
  assert.deepEqual([e.startsAt, e.reminderAt, e.notifiedAt, e.notes], ['2026-11-05T15:00:00', '2026-11-05T14:30:00', '', 'porta i raggi']);
  assert.equal(moved.next[1].title, 'Cena da Luca');
  const cleared = editEvent(events(), { id: 'e1', reminder_at: 'none' });
  assert.equal(cleared.next[0].reminderAt, '');
  const renamed = editEvent(events(), { event: 'luca', title: 'Cena da Luca e Sara', notes: '' });
  assert.deepEqual([renamed.next[1].title, renamed.next[1].notes], ['Cena da Luca e Sara', '']);
  assert.equal(editEvent(events(), { event: 'dentista', title: 'Dentista!' }).next[0].notifiedAt, '2026-11-02T09:00:01Z', 'reminder untouched = still rung');
});

test('event refusals: bad date, end before start, unknown', () => {
  assert.deepEqual(editEvent(events(), { event: 'dentista', starts_at: 'giovedì' }).result, { ok: false, error: 'bad_date', field: 'starts_at' });
  assert.equal(editEvent(events(), { event: 'dentista', starts_at: 'none' }).result.error, 'bad_date', 'the start cannot be cleared');
  assert.equal(editEvent(events(), { event: 'dentista', ends_at: '2026-11-01T10:00:00' }).result.error, 'ends_before_start');
  assert.equal(editEvent(events(), { event: 'palestra', title: 'x' }).result.error, 'not_found');
  assert.equal(findItem(events(), 'e2', '', 'title').item.id, 'e2');
});

test('the server wires both tools with an undo', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /name: 'edit_task'/);
  assert.match(src, /name: 'edit_calendar_event'/);
  assert.match(src, /fnName === 'edit_task'[\s\S]{0,500}restore_tasks/);
  assert.match(src, /fnName === 'edit_calendar_event'[\s\S]{0,500}restore_events/);
});
