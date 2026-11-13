// What the assistant does when asked to read or to write the notes.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

const {
  notesToText, normalizeNotesState, _noteId, NOTE_BODY_MAX, NOTES_MAX,
} = require('./notes-state.js');
const NotesAi = require('../notes-ai.js');

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'read_notes': async (_context, { readNotes }) => {
      let fnResult;
      const state = await readNotes().catch(() => ({ v: 1, activeId: '', notes: [] }));
      fnResult = { notes: notesToText(state), list: NotesAi.listNotes(normalizeNotesState(state)) };
      return fnResult;
  },

  'edit_note': async ({ fnArgs, clientActions }, { aiActionLog, readNotes, writeNotes }) => {
      let fnResult;
      const prevState = await readNotes();   // unreadable: the tool fails, never writes over the file
      const { next, result } = NotesAi.planNoteAction(normalizeNotesState(prevState), fnArgs,
        { newId: _noteId, now: Date.now(), bodyMax: NOTE_BODY_MAX, notesMax: NOTES_MAX });
      if (next) {
        await writeNotes(next);
        clientActions.push({ action: 'refresh_notes', args: {} });
        aiActionLog.record({ name: 'edit_note', label: 'Note aggiornate', undo: { kind: 'restore_notes', prev: prevState } });
      }
      fnResult = result;
      return fnResult;
  },

  'write_notes': async ({ fnArgs, clientActions }, { aiActionLog, readNotes, writeNotes }) => {
      let fnResult;
      const safe = String(fnArgs.content || '').slice(0, NOTE_BODY_MAX);
      // Guard: never silently erase the notes with an empty string.
      // The model must use clear_all_tasks-style explicit intent for destructive ops.
      if (safe.trim() === '') { fnResult = { error: 'content is empty: to clear notes, send a single space or ask the user to confirm' }; }
      else {
        const prevState = await readNotes();   // unreadable: the tool fails, never writes over the file
        // Write into the active note (preserving the user's other notes); create
        // one if the store is empty. The model's mental model is a single notepad.
        const next = normalizeNotesState(prevState);
        let active = next.notes.find((n) => n.id === next.activeId);
        if (!active) {
          active = { id: _noteId(), body: '', pinned: false, updatedAt: Date.now() };
          next.notes.unshift(active);
          next.activeId = active.id;
        }
        active.body = safe;
        active.updatedAt = Date.now();
        await writeNotes(next);
        clientActions.push({ action: 'refresh_notes', args: {} });
        aiActionLog.record({ name: 'write_notes', label: 'Note aggiornate', undo: { kind: 'restore_notes', prev: prevState } });
        fnResult = { ok: true };
      }
      return fnResult;
  },
};

module.exports = { branches };
