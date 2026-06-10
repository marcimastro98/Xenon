'use strict';

function setNotesStatus(state) {
  const el = document.getElementById('notes-status');
  if (!el) return;
  el.classList.remove('saving', 'saved', 'error');
  if (state) el.classList.add(state);
}

async function loadNotes() {
  try {
    const res = await fetch('/notes');
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    const ta = document.getElementById('notes-area');
    if (ta) ta.value = data.notes || data.text || '';
    notesLoaded = true;
    setNotesStatus(null);
  } catch {
    setNotesStatus('error');
  }
}

function onNotesInput() {
  if (!notesLoaded) return;
  setNotesStatus('saving');
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(saveNotes, 500);
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

async function saveNotes() {
  const ta = document.getElementById('notes-area');
  if (!ta) return;
  try {
    const res = await fetch('/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ta.value })
    });
    if (!res.ok) throw new Error('http ' + res.status);
    setNotesStatus('saved');
    clearTimeout(notesStatusTimer);
    notesStatusTimer = setTimeout(() => setNotesStatus(null), 1600);
  } catch {
    setNotesStatus('error');
  }
}
