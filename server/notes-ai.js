'use strict';
// What Bit does to the notes widget's notes (edit_note). The widget holds up to
// 50 notes; Bit picks one by words from its title (its first line) or works on
// the one open in the widget, and never touches the others. Pure: the caller
// reads and writes the store, this only plans the change.
//   new      a new note with the text, opened in the widget
//   append   the text on a new line at the end of a note
//   replace  the whole text of a note
//   pin / unpin / open / delete   that note

const ACTIONS = Object.freeze(['new', 'append', 'replace', 'pin', 'unpin', 'open', 'delete']);
const TITLE_MAX = 60;

function titleOf(note) {
  const line = String((note && note.body) || '').split('\n').find((l) => l.trim()) || '';
  return line.trim().slice(0, TITLE_MAX);
}

const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// The note named by `which`: '' or 'active' = the one open in the widget;
// otherwise the first whose title holds those words (exact title first).
function findNote(state, which) {
  const notes = state.notes;
  const w = fold(which);
  if (!w || w === 'active' || w === 'current') return notes.find((n) => n.id === state.activeId) || notes[0] || null;
  return notes.find((n) => fold(titleOf(n)) === w)
    || notes.find((n) => fold(titleOf(n)).includes(w))
    || notes.find((n) => fold(n.body).includes(w))
    || null;
}

// What read_notes shows Bit about each note, never more than its title.
function listNotes(state) {
  return state.notes.map((n) => ({ title: titleOf(n) || '(empty)', pinned: !!n.pinned, open: n.id === state.activeId }));
}

// → { next, result } where next is the new state (null = nothing to write).
function planNoteAction(state, args, { newId, now, bodyMax, notesMax }) {
  const a = args || {};
  const action = ACTIONS.includes(a.action) ? a.action : 'new';
  const text = String(a.text == null ? '' : a.text).slice(0, bodyMax);
  const next = { ...state, notes: state.notes.map((n) => ({ ...n })) };
  if (action === 'new') {
    if (!text.trim()) return { next: null, result: { ok: false, error: 'empty_text' } };
    if (next.notes.length >= notesMax) return { next: null, result: { ok: false, error: 'too_many_notes', max: notesMax } };
    const note = { id: newId(), body: text, pinned: false, updatedAt: now };
    next.notes.unshift(note);
    next.activeId = note.id;
    return { next, result: { ok: true, title: titleOf(note) } };
  }
  const found = findNote(next, a.note);
  if (!found) return { next: null, result: { ok: false, error: 'not_found', notes: listNotes(state).map((n) => n.title) } };
  const note = next.notes.find((n) => n.id === found.id);
  if (action === 'delete') {
    next.notes = next.notes.filter((n) => n.id !== note.id);
    if (next.activeId === note.id) next.activeId = next.notes.length ? next.notes[0].id : '';
    return { next, result: { ok: true, deleted: titleOf(note) || '(empty)' } };
  }
  if (action === 'append' || action === 'replace') {
    if (!text.trim()) return { next: null, result: { ok: false, error: 'empty_text' } };
    const body = action === 'replace' ? text : (note.body.trim() ? note.body.replace(/\s+$/, '') + '\n' + text : text);
    note.body = body.slice(0, bodyMax);
  }
  if (action === 'pin' || action === 'unpin') note.pinned = action === 'pin';
  note.updatedAt = now;
  next.activeId = note.id;
  return { next, result: { ok: true, title: titleOf(note) || '(empty)' } };
}

module.exports = { ACTIONS, titleOf, findNote, listNotes, planNoteAction };
