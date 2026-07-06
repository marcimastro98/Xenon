import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createAiActionLog, MAX_ENTRIES } = require('../ai-action-log.js');

// The in-memory action log backing the chat's "undo" affordance: records recent
// mutating actions, exposes the latest still-undoable one, and caps its size.

function clock(start = 1000) { let t = start; return () => (t += 1); }

test('record returns an entry with an id and reflects undoability', () => {
  const log = createAiActionLog({ now: clock() });
  const e = log.record({ name: 'write_notes', label: 'Notes updated', undo: { kind: 'restore_notes', prev: 'old' } });
  assert.ok(e.id);
  assert.equal(e.undone, false);
  const listed = log.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].undoable, true);
});

test('a non-undoable action is logged but not undoable', () => {
  const log = createAiActionLog({ now: clock() });
  log.record({ name: 'set_volume', label: 'Volume 50' }); // no undo descriptor
  assert.equal(log.list()[0].undoable, false);
  assert.equal(log.lastUndoable(), null);
});

test('lastUndoable returns the most recent still-undoable entry', () => {
  const log = createAiActionLog({ now: clock() });
  log.record({ name: 'create_task', label: 't1', undo: { kind: 'delete_task', id: '1' } });
  log.record({ name: 'set_volume', label: 'vol' }); // not undoable
  const last = log.lastUndoable();
  assert.equal(last.name, 'create_task');
});

test('markUndone flips undoability off', () => {
  const log = createAiActionLog({ now: clock() });
  const e = log.record({ name: 'clear_all_tasks', label: 'cleared', undo: { kind: 'restore_tasks', prev: [] } });
  log.markUndone(e.id);
  assert.equal(log.get(e.id).undone, true);
  assert.equal(log.list()[0].undoable, false);
  assert.equal(log.lastUndoable(), null);
});

test('the log is capped at MAX_ENTRIES, dropping the oldest', () => {
  const log = createAiActionLog({ now: clock() });
  for (let i = 0; i < MAX_ENTRIES + 10; i++) log.record({ name: 'create_task', label: `t${i}`, undo: { kind: 'delete_task', id: String(i) } });
  const listed = log.list();
  assert.equal(listed.length, MAX_ENTRIES);
  assert.equal(listed[listed.length - 1].label, `t${MAX_ENTRIES + 9}`);
});

test('ids are unique across records', () => {
  const log = createAiActionLog({ now: clock() });
  const ids = new Set();
  for (let i = 0; i < 20; i++) ids.add(log.record({ name: 'x', label: 'y' }).id);
  assert.equal(ids.size, 20);
});
