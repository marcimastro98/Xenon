// Reads and writes the notes on disk with the number of their last save, and refuses a save
// made from an older copy.

const fs = require('node:fs');
const { broadcastSSE } = require('../http/sse-clients.js');
const { NOTES_FILE, NOTES_JSON } = require('./store-files.js');
const { normalizeNotesState, textToNotesState, _notesRevOf } = require('./notes-state.js');
const { writeFileAtomic } = require('../atomic-write.js');
const { notesRev } = require('./notes-rev-state.js');

async function _ensureNotesRev() {
  if (notesRev.rev >= 0) return notesRev.rev;
  try {
    notesRev.rev = _notesRevOf(JSON.parse(await fs.promises.readFile(NOTES_JSON, 'utf8')));
  } catch {
    notesRev.rev = 0;
  }
  return notesRev.rev;
}

async function readNotes() {
  try {
    const raw = await fs.promises.readFile(NOTES_JSON, 'utf8');
    const parsed = JSON.parse(raw);
    if (notesRev.rev < 0) notesRev.rev = _notesRevOf(parsed);
    const state = normalizeNotesState(parsed);
    state.rev = notesRev.rev;
    return state;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (notesRev.rev < 0) notesRev.rev = 0;
  // First run after upgrade: promote the legacy single-blob notes.txt to one note.
  try {
    const legacy = await fs.promises.readFile(NOTES_FILE, 'utf8');
    if (legacy && legacy.trim()) {
      return await writeNotes(textToNotesState(legacy));
    }
  } catch (e) {
    if (e.code !== 'ENOENT') { /* unreadable legacy file → start empty rather than fail */ }
  }
  return { v: 1, activeId: '', notes: [], rev: notesRev.rev };
}

async function writeNotes(state) {
  const safe = normalizeNotesState(state);
  await _ensureNotesRev();
  safe.rev = ++notesRev.rev;
  await writeFileAtomic(NOTES_JSON, JSON.stringify(safe));
  // Live-sync: the dashboard notes widgets on every surface + granted SDK streams.
  broadcastSSE('notes', safe);
  return safe;
}

function saveNotesGuarded(body) {
  const run = notesRev.saveChain.then(async () => {
    const baseRev = Number(body && body.baseRev);
    if (Number.isFinite(baseRev) && baseRev < await _ensureNotesRev()) {
      return { ok: false, stale: true, ...(await readNotes()) };
    }
    const saved = await writeNotes({ notes: body.notes, activeId: body.activeId });
    return { ok: true, ...saved };
  });
  notesRev.saveChain = run.catch(() => {}); // a failed save must never wedge the chain
  return run;
}

module.exports = { _ensureNotesRev, readNotes, writeNotes, saveNotesGuarded };
