// notes-ai.js: Bit's edit_note on the notes widget. Pinned here: "write a note"
// makes a new note and never overwrites the open one, a note is found by words
// from its title (accents and case ignored), the other notes stay as they were,
// and the server wires the tool with an undo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Notes = require('../notes-ai.js');

let n = 0;
const opts = () => ({ newId: () => `id${++n}`, now: 1000, bodyMax: 100, notesMax: 3 });
const state = () => ({
  v: 1, activeId: 'a',
  notes: [
    { id: 'a', body: 'Lavoro\nfinire il report', pinned: false, updatedAt: 1 },
    { id: 'b', body: 'Spesa\nlatte', pinned: true, updatedAt: 1 },
  ],
});

test('"write a note" adds a new note in front and opens it; the open one is untouched', () => {
  const s = state();
  const { next, result } = Notes.planNoteAction(s, { text: 'Comprare il pane' }, opts());
  assert.deepEqual(result, { ok: true, title: 'Comprare il pane' });
  assert.equal(next.notes.length, 3);
  assert.equal(next.notes[0].body, 'Comprare il pane');
  assert.equal(next.activeId, next.notes[0].id);
  assert.equal(next.notes[1].body, 'Lavoro\nfinire il report');
  assert.equal(s.notes.length, 2, 'the input state is not changed');
});

test('append adds a line to the note named by its title, accents and case ignored', () => {
  const { next, result } = Notes.planNoteAction(state(), { action: 'append', note: 'SPESA', text: 'uova' }, opts());
  assert.equal(result.ok, true);
  assert.equal(next.notes.find((x) => x.id === 'b').body, 'Spesa\nlatte\nuova');
  assert.equal(next.notes.find((x) => x.id === 'a').body, 'Lavoro\nfinire il report');
  assert.equal(next.activeId, 'b');
  const { next: n2 } = Notes.planNoteAction({ v: 1, activeId: 'c', notes: [{ id: 'c', body: 'Città', pinned: false }] },
    { action: 'append', note: 'citta', text: 'x' }, opts());
  assert.equal(n2.notes[0].body, 'Città\nx');
});

test('no name = the open note; replace, pin, open and delete do only that', () => {
  assert.equal(Notes.planNoteAction(state(), { action: 'replace', text: 'nuovo' }, opts()).next.notes[0].body, 'nuovo');
  assert.equal(Notes.planNoteAction(state(), { action: 'pin', note: 'lavoro' }, opts()).next.notes[0].pinned, true);
  assert.equal(Notes.planNoteAction(state(), { action: 'unpin', note: 'spesa' }, opts()).next.notes[1].pinned, false);
  assert.equal(Notes.planNoteAction(state(), { action: 'open', note: 'spesa' }, opts()).next.activeId, 'b');
  const del = Notes.planNoteAction(state(), { action: 'delete', note: 'lavoro' }, opts());
  assert.deepEqual(del.result, { ok: true, deleted: 'Lavoro' });
  assert.deepEqual(del.next.notes.map((x) => x.id), ['b']);
  assert.equal(del.next.activeId, 'b');
});

test('refusals name what is wrong and write nothing', () => {
  const miss = Notes.planNoteAction(state(), { action: 'append', note: 'ricette', text: 'x' }, opts());
  assert.deepEqual(miss, { next: null, result: { ok: false, error: 'not_found', notes: ['Lavoro', 'Spesa'] } });
  assert.deepEqual(Notes.planNoteAction(state(), { text: '  ' }, opts()).result, { ok: false, error: 'empty_text' });
  assert.deepEqual(Notes.planNoteAction(state(), { action: 'append', text: '' }, opts()).result, { ok: false, error: 'empty_text' });
  const full = { v: 1, activeId: 'a', notes: [1, 2, 3].map((i) => ({ id: String(i), body: 'n' + i })) };
  assert.deepEqual(Notes.planNoteAction(full, { text: 'x' }, opts()).result, { ok: false, error: 'too_many_notes', max: 3 });
  assert.equal(Notes.planNoteAction(state(), { action: 'append', note: 'spesa', text: 'y'.repeat(500) }, opts()).next.notes[1].body.length, 100);
});

test('read_notes lists titles only; the server wires edit_note with an undo', () => {
  assert.deepEqual(Notes.listNotes(state()), [
    { title: 'Lavoro', pinned: false, open: true },
    { title: 'Spesa', pinned: true, open: false },
  ]);
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /name: 'edit_note'/);
  assert.match(src, /fnName === 'edit_note'[\s\S]{0,600}restore_notes/);
  assert.match(src, /list: NotesAi\.listNotes/);
});
