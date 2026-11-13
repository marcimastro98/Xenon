// Notes as the engine stores them: their limits, the check of saved or received notes, and the
// conversion to and from plain text.

const { SAFE_ITEM_ID_RE } = require('./item-id.js');

const NOTES_MAX = 50;                // max distinct notes
const NOTE_BODY_MAX = 100_000;       // per-note character cap
const NOTES_TOTAL_MAX = 1_000_000;   // aggregate character cap (disk-use bound)
const NOTES_TEXT_SEP = '\n\n───\n\n'; // separator when flattening notes to one text

function _noteId() {
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Rebuild a trusted notes state from arbitrary persisted/wire input — explicit
// known-key copy (never a spread of untrusted data), with caps applied.
function normalizeNotesState(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const notes = [];
  const seen = new Set();
  let total = 0;
  for (const n of Array.isArray(src.notes) ? src.notes : []) {
    if (notes.length >= NOTES_MAX) break;
    if (!n || typeof n !== 'object') continue;
    let body = typeof n.body === 'string' ? n.body : '';
    if (body.length > NOTE_BODY_MAX) body = body.slice(0, NOTE_BODY_MAX);
    total += body.length;
    if (total > NOTES_TOTAL_MAX) break;
    let id = String(n.id || '').slice(0, 64);
    if (!SAFE_ITEM_ID_RE.test(id)) id = _noteId();
    while (seen.has(id)) id = _noteId();
    seen.add(id);
    notes.push({
      id,
      body,
      pinned: !!n.pinned,
      updatedAt: Number.isFinite(Number(n.updatedAt)) ? Number(n.updatedAt) : Date.now(),
    });
  }
  let activeId = String(src.activeId || '').slice(0, 64);
  if (!notes.some((n) => n.id === activeId)) activeId = notes.length ? notes[0].id : '';
  return { v: 1, activeId, notes };
}

// Flatten all notes to a single plain-text document (order preserved).
function notesToText(state) {
  return (state && Array.isArray(state.notes) ? state.notes : [])
    .map((n) => n.body).join(NOTES_TEXT_SEP);
}

// Build a one-note state from a plain-text blob (legacy save / migration / old backup).
function textToNotesState(text) {
  const body = String(text == null ? '' : text);
  if (!body) return { v: 1, activeId: '', notes: [] };
  const id = _noteId();
  return normalizeNotesState({ activeId: id, notes: [{ id, body, pinned: false, updatedAt: Date.now() }] });
}

function _notesRevOf(parsed) {
  const n = Number(parsed && parsed.rev);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

module.exports = {
  NOTES_MAX, NOTE_BODY_MAX, NOTES_TOTAL_MAX, NOTES_TEXT_SEP, _noteId, normalizeNotesState,
  notesToText, textToNotesState, _notesRevOf,
};
