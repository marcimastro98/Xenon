// Loads and saves notes with the engine, and typing in, picking, creating, pinning and deleting a
// note.
'use strict';

// Stale-save rebase: merge the server snapshot with this surface's intent
// instead of re-sending the local snapshot wholesale — a blind re-push under
// the new rev would silently delete notes created on another surface, the exact
// lost update the rev guard exists to refuse. Per note the newer updatedAt
// wins; server-only notes survive unless deleted here; local-only notes survive
// only if created here (otherwise they were deleted elsewhere).
function mergeServerNotesForRetry(data) {
  const localById = new Map(notesState.notes.map(n => [n.id, n]));
  const merged = [];
  (Array.isArray(data.notes) ? data.notes : []).forEach(sn => {
    if (!sn || typeof sn.id !== 'string') return;
    if (notesLocalDeleted.has(sn.id)) return;
    const ln = localById.get(sn.id);
    localById.delete(sn.id);
    merged.push(ln && (Number(ln.updatedAt) || 0) >= (Number(sn.updatedAt) || 0) ? ln : sn);
  });
  // Left in localById: notes the server never saw. Keep the ones created here
  // (same front slot notesCreate gave them), drop the rest.
  const createdHere = notesState.notes.filter(n => localById.has(n.id) && notesLocalCreated.has(n.id));
  _applyNotesState({ v: 1, activeId: notesState.activeId, notes: createdHere.concat(merged) });
}

async function loadNotes() {
  try {
    const res = await fetch('/notes/list');
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    const rev = Number(data.rev) || 0;
    // A newer state may have been adopted (live SSE push) while this GET was
    // in flight — never roll the content and notesRev back to an older snapshot.
    if (!rev || rev >= notesRev) {
      adoptServerNotes(data);
      notesRev = Math.max(notesRev, rev);
    }
    notesLoaded = true;
    notesLoadRetryDelay = 1000;
    setNotesStatus(null);
  } catch {
    setNotesStatus('error');
    // Notes live server-side and are never lost; a failed initial load is almost
    // always the page opening while the server is still restarting (e.g. right
    // after a self-update). Retry with backoff so it repopulates on its own.
    if (!notesLoaded) {
      clearTimeout(notesLoadRetryTimer);
      notesLoadRetryTimer = setTimeout(loadNotes, notesLoadRetryDelay);
      notesLoadRetryDelay = Math.min(notesLoadRetryDelay * 2, 15000);
    }
  }
}

// Persist the whole structured store. `immediate` skips the debounce (structural
// edits: create/delete/pin/select); body typing debounces via onNotesInput.
// Carries baseRev (the rev this state was built on) so the server can refuse a
// stale write instead of letting it clobber fresher content from another surface.
// Serialized: a save fired while another is in flight waits for the first
// response (which advances notesRev) — two overlapping saves with the same
// baseRev would otherwise refuse each other as stale.
async function persistNotes() {
  if (notesSaveInflight) { notesSaveQueued = true; return; }
  notesSaveInflight = true;
  setNotesStatus('saving');
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch('/notes/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: notesState.notes, activeId: notesState.activeId, baseRev: notesRev }),
      });
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json().catch(() => null);
      if (data && data.stale) {
        const serverRev = Number(data.rev) || 0;
        if (attempt === 0) {
          // This surface missed another surface's save. The user is actively
          // editing HERE, but their intent covers the notes they touched — not
          // the whole snapshot: merge the server state in, rebase onto the
          // server rev and re-send once. (The guard's real target — the unload
          // beacon of a stale closing page — can't retry: it stays refused,
          // which is the point.)
          if (serverRev > notesRev) notesRev = serverRev;
          mergeServerNotesForRetry(data);
          continue;
        }
        // Still stale after the rebase: another surface is saving right now —
        // stop fighting and adopt its state (deferred if mid-keystroke here).
        onNotesServerPush(data);
        setNotesStatus(null);
        return;
      }
      if (data && Number.isFinite(Number(data.rev))) notesRev = Number(data.rev);
      // The server accepted this snapshot: local structural intent is now durable.
      notesLocalCreated.clear();
      notesLocalDeleted.clear();
      setNotesStatus('saved');
      clearTimeout(notesStatusTimer);
      notesStatusTimer = setTimeout(() => setNotesStatus(null), 1600);
      return;
    }
  } catch {
    setNotesStatus('error');
  } finally {
    notesSaveInflight = false;
    if (notesSaveQueued) { notesSaveQueued = false; persistNotes(); }
  }
}

// ── Live cross-surface sync (SSE `notes`) ────────────────────────
// The server broadcasts the saved store after every write (and seeds it on SSE
// connect). Adopting it here is what keeps every surface — Xeneon Edge, native
// app, browser — showing the same notes (GitHub #72: the widget used to load
// once at startup and never refresh). Coalesced, and deferred while the user is
// mid-edit here so an incoming push never yanks the caret.
function onNotesServerPush(data) {
  if (!data || !Array.isArray(data.notes)) return;
  notesSsePendingPush = data;
  if (!notesSseApplyTimer) notesSseApplyTimer = setTimeout(applyPendingServerNotes, 200);
}

function applyPendingServerNotes() {
  notesSseApplyTimer = null;
  const data = notesSsePendingPush;
  if (!data) return;
  const rev = Number(data.rev) || 0;
  // Our own save echoed back (or older): already reflected locally.
  if (rev && rev <= notesRev) { notesSsePendingPush = null; return; }
  // Mid-edit, save in flight, or a debounced save still pending (typed text
  // not yet POSTed): defer, don't drop. Either our pending save supersedes
  // this push (its echo then no-ops above) or it comes back `stale` and
  // persistNotes rebases/adopts through this same path.
  const ae = document.activeElement;
  if ((ae && ae.matches && ae.matches('[data-notesf="area"]')) || notesSaveInflight || notesSaveTimer) {
    notesSseApplyTimer = setTimeout(applyPendingServerNotes, 1000);
    return;
  }
  notesSsePendingPush = null;
  adoptServerNotes(data);
  if (rev > notesRev) notesRev = rev;
  setNotesStatus(null);
}

// Typing in the active editor: update the model in place, mirror to other
// (non-focused) instances, and debounce the save. No full re-render, so the
// caret is never disturbed.
function onNotesInput(srcEl) {
  if (!notesLoaded) return;
  const note = activeNote();
  if (!note) return;
  const val = srcEl ? srcEl.value : '';
  note.body = val;
  note.updatedAt = Date.now();
  setNotesStatus('saving');
  scheduleNotesIdleBlur();

  // Live-update peripheral UI across all instances without touching the editor
  // the user is typing in.
  notesRoots().forEach(root => {
    const tab = root.querySelector(`.notes-tab[data-note-id="${cssId(note.id)}"] .notes-tab-title`);
    if (tab) tab.textContent = noteTitle(val);
    const count = root.querySelector('[data-notesf="count"]');
    if (count) count.textContent = notesCountLabel(val);
    const ta = root.querySelector('[data-notesf="area"]');
    if (ta && ta !== srcEl && ta !== document.activeElement) ta.value = val;
  });

  clearTimeout(notesSaveTimer);
  // Null the handle when it fires: applyPendingServerNotes reads it to know a
  // debounced save is still pending (a stale non-null id would defer forever).
  notesSaveTimer = setTimeout(() => { notesSaveTimer = null; persistNotes(); }, 500);
}

// ── Structural actions ───────────────────────────────────────────
function notesSelect(id) {
  if (!noteById(id) || notesState.activeId === id) return;
  notesState.activeId = id;
  renderNotes();
  persistNotes();
}

function notesCreate() {
  if (notesState.notes.length >= 50) return;   // server also caps at NOTES_MAX
  const id = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  notesLocalCreated.add(id);
  notesState.notes.unshift({ id, body: '', pinned: false, updatedAt: Date.now() });
  notesState.activeId = id;
  notesLoaded = true;
  renderNotes({ focus: true });
  persistNotes();
}

function notesDeleteActive() {
  const note = activeNote();
  if (!note) return;
  const idx = notesState.notes.findIndex(n => n.id === note.id);
  notesLocalDeleted.add(note.id);
  notesLocalCreated.delete(note.id);
  notesState.notes = notesState.notes.filter(n => n.id !== note.id);
  const next = notesState.notes[idx] || notesState.notes[idx - 1] || notesState.notes[0];
  notesState.activeId = next ? next.id : '';
  renderNotes();
  persistNotes();
}

function notesTogglePin() {
  const note = activeNote();
  if (!note) return;
  note.pinned = !note.pinned;
  note.updatedAt = Date.now();
  renderNotes();
  persistNotes();
}

// ── Idle caret guard ─────────────────────────────────────────────
// On some Xeneon Edge GPU/driver setups the blinking caret of a focused textarea
// flickers the panel. The iCUE WebView keeps the field focused indefinitely, so
// release focus after a period of inactivity; tapping the box resumes editing.
const NOTES_IDLE_BLUR_MS = 20000;

function scheduleNotesIdleBlur() {
  clearTimeout(notesIdleBlurTimer);
  notesIdleBlurTimer = setTimeout(() => {
    const ae = document.activeElement;
    if (ae && ae.matches && ae.matches('[data-notesf="area"]')) ae.blur();
  }, NOTES_IDLE_BLUR_MS);
}
