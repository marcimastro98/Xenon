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
    setNotesStatus(null);
  } catch {
    setNotesStatus('error');
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
