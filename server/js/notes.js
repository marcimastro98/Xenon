'use strict';

function setNotesStatus(state) {
  document.querySelectorAll('[data-notesf="status"]').forEach(el => {
    el.classList.remove('saving', 'saved', 'error');
    if (state) el.classList.add(state);
  });
}

async function loadNotes() {
  try {
    const res = await fetch('/notes');
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    const text = data.notes || data.text || '';
    document.querySelectorAll('[data-notesf="area"]').forEach(ta => { ta.value = text; });
    notesLoaded = true;
    notesLoadRetryDelay = 1000;
    setNotesStatus(null);
  } catch {
    setNotesStatus('error');
    // The notes live server-side and are never lost; a failed initial load is
    // almost always the page opening while the server is still restarting —
    // e.g. right after a self-update, which is exactly when users reported the
    // notes pane coming up blank. Retry with backoff so it repopulates on its
    // own instead of staying empty until a manual reload. Stop once loaded; the
    // typing/unload guards (notesLoaded) prevent overwriting the file meanwhile.
    if (!notesLoaded) {
      clearTimeout(notesLoadRetryTimer);
      notesLoadRetryTimer = setTimeout(loadNotes, notesLoadRetryDelay);
      notesLoadRetryDelay = Math.min(notesLoadRetryDelay * 2, 15000);
    }
  }
}

// Called by the oninput handler on any notes textarea instance.
// The event target is the textarea that the user is currently typing into.
function onNotesInput(srcEl) {
  if (!notesLoaded) return;
  setNotesStatus('saving');
  // Mirror value to all OTHER textarea instances so copies stay in sync.
  const val = srcEl ? srcEl.value : '';
  document.querySelectorAll('[data-notesf="area"]').forEach(ta => {
    if (ta !== srcEl && ta !== document.activeElement) ta.value = val;
  });
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(() => saveNotes(val), 500);
}

// ── Idle caret guard ─────────────────────────────────────────────
// On some Xeneon Edge GPU/driver setups the blinking caret of the
// focused textarea produces a visible flicker of the panel, even with
// the textarea isolated on its own compositing layer. The iCUE WebView
// keeps the field focused indefinitely (it never loses focus when the
// user returns to their main monitor), so the caret would blink — and
// flicker — forever. If the user stops typing, release focus so the
// caret disappears; tapping the box again resumes editing as usual.
const NOTES_IDLE_BLUR_MS = 20000;

function scheduleNotesIdleBlur() {
  clearTimeout(notesIdleBlurTimer);
  notesIdleBlurTimer = setTimeout(() => {
    const ta = document.getElementById('notes-area');
    if (ta && document.activeElement === ta) ta.blur();
  }, NOTES_IDLE_BLUR_MS);
}

(function initNotesIdleBlur() {
  const ta = document.getElementById('notes-area');
  if (!ta) return;
  ta.addEventListener('focus', scheduleNotesIdleBlur);
  ta.addEventListener('input', scheduleNotesIdleBlur);
  ta.addEventListener('blur', () => clearTimeout(notesIdleBlurTimer));
})();

async function saveNotes(text) {
  // Accept an explicit text value (from onNotesInput) or fall back to the primary
  // textarea for callers that don't pass a value (e.g. legacy call sites).
  let noteText = text;
  if (noteText === undefined) {
    const ta = document.querySelector('[data-notesf="area"]');
    if (!ta) return;
    noteText = ta.value;
  }
  try {
    const res = await fetch('/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: noteText }),
    });
    if (!res.ok) throw new Error('http ' + res.status);
    setNotesStatus('saved');
    clearTimeout(notesStatusTimer);
    notesStatusTimer = setTimeout(() => setNotesStatus(null), 1600);
  } catch {
    setNotesStatus('error');
  }
}
