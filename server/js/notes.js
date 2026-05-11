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
