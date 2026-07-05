'use strict';

// Multi-note scratchpad. The structured store lives server-side (GET/POST
// /notes/list); `notesState` (state.js) mirrors it and is rendered into every
// notes widget instance — the Agenda "Appunti" tab, an extracted standalone
// panel, and any duplicated copies. Note titles/bodies are user text and are
// always written with textContent/value, never innerHTML.

const NOTES_TAB_TITLE_MAX = 28;

function notesRoots() {
  return Array.from(document.querySelectorAll('[data-notesf="root"]'));
}

function noteById(id) {
  return notesState.notes.find(n => n.id === id) || null;
}

function activeNote() {
  return noteById(notesState.activeId) || notesState.notes[0] || null;
}

// Pinned notes float to the top; order is otherwise preserved.
function notesInDisplayOrder() {
  const pinned = notesState.notes.filter(n => n.pinned);
  const rest = notesState.notes.filter(n => !n.pinned);
  return pinned.concat(rest);
}

function noteTitle(body) {
  const firstLine = String(body || '').split('\n').find(l => l.trim()) || '';
  const trimmed = firstLine.trim();
  if (!trimmed) return t('notes_untitled');
  return trimmed.length > NOTES_TAB_TITLE_MAX ? trimmed.slice(0, NOTES_TAB_TITLE_MAX - 1) + '…' : trimmed;
}

function noteWordCount(body) {
  const s = String(body || '').trim();
  if (!s) return 0;
  return s.split(/\s+/).length;
}

function notesCountLabel(body) {
  const n = noteWordCount(body);
  return n + ' ' + t(n === 1 ? 'notes_word' : 'notes_words');
}

function setNotesStatus(state) {
  document.querySelectorAll('[data-notesf="status"]').forEach(el => {
    el.classList.remove('saving', 'saved', 'error');
    if (state) el.classList.add(state);
  });
  const label = state === 'saving' ? t('notes_saving')
    : state === 'saved' ? t('notes_saved')
    : state === 'error' ? t('notes_error') : '';
  document.querySelectorAll('[data-notesf="status-text"]').forEach(el => { el.textContent = label; });
}

// ── Rendering ────────────────────────────────────────────────────
const _NOTES_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h9l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm8 1.5V9h4.5L13 4.5ZM7 12h10v1.6H7V12Zm0 4h10v1.6H7V16Zm0-8h4v1.6H7V8Z"/></svg>';
const _NOTES_PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3l5 5-3 1-4 4v5l-2 2-3-5-5 3 3-5-5-3 2-2h5l4-4 1-3Z"/></svg>';
const _NOTES_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z"/></svg>';
const _NOTES_ADD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z"/></svg>';

function renderNotesInto(root) {
  const note = activeNote();
  const hasNotes = notesState.notes.length > 0;
  root.textContent = '';

  // Head: title + save status.
  const head = document.createElement('div');
  head.className = 'notes-head';
  const title = document.createElement('div');
  title.className = 'notes-title';
  title.innerHTML = _NOTES_ICON;
  const titleText = document.createElement('span');
  titleText.setAttribute('data-i18n', 'notes_title');
  titleText.textContent = t('notes_title');
  title.appendChild(titleText);
  const status = document.createElement('div');
  status.className = 'notes-status';
  status.setAttribute('data-notesf', 'status');
  const dot = document.createElement('span');
  dot.className = 'dot';
  const statusText = document.createElement('span');
  statusText.className = 'notes-status-text';
  statusText.setAttribute('data-notesf', 'status-text');
  status.appendChild(dot);
  status.appendChild(statusText);
  head.appendChild(title);
  head.appendChild(status);
  root.appendChild(head);

  // Tab strip: one chip per note (pinned first) + an add button.
  const tabs = document.createElement('div');
  tabs.className = 'notes-tabs';
  tabs.setAttribute('data-notesf', 'tabs');
  notesInDisplayOrder().forEach(n => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'notes-tab' + (note && n.id === note.id ? ' active' : '') + (n.pinned ? ' pinned' : '');
    tab.dataset.noteId = n.id;
    tab.setAttribute('onclick', `notesSelect('${n.id}')`);
    if (n.pinned) {
      const pin = document.createElement('span');
      pin.className = 'notes-tab-pin';
      pin.innerHTML = _NOTES_PIN;
      tab.appendChild(pin);
    }
    const label = document.createElement('span');
    label.className = 'notes-tab-title';
    label.textContent = noteTitle(n.body);
    tab.appendChild(label);
    tabs.appendChild(tab);
  });
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'notes-tab-add';
  addBtn.setAttribute('onclick', 'notesCreate()');
  addBtn.setAttribute('data-i18n-title', 'notes_new');
  addBtn.title = t('notes_new');
  addBtn.setAttribute('aria-label', t('notes_new'));
  addBtn.innerHTML = _NOTES_ADD;
  tabs.appendChild(addBtn);
  root.appendChild(tabs);

  // Editor or empty state.
  const editorWrap = document.createElement('div');
  editorWrap.className = 'notes-editor-wrap';
  if (hasNotes && note) {
    const ta = document.createElement('textarea');
    ta.className = 'notes-area';
    ta.setAttribute('data-notesf', 'area');
    ta.spellcheck = false;
    ta.setAttribute('data-i18n-placeholder', 'notes_placeholder');
    ta.placeholder = t('notes_placeholder');
    ta.value = note.body;
    ta.setAttribute('oninput', 'onNotesInput(this)');
    ta.setAttribute('onfocus', 'scheduleNotesIdleBlur()');
    ta.setAttribute('onblur', 'clearTimeout(notesIdleBlurTimer)');
    editorWrap.appendChild(ta);
  } else {
    const empty = document.createElement('div');
    empty.className = 'notes-empty';
    const msg = document.createElement('div');
    msg.className = 'notes-empty-msg';
    msg.setAttribute('data-i18n', 'notes_empty');
    msg.textContent = t('notes_empty');
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'notes-empty-btn';
    create.setAttribute('onclick', 'notesCreate()');
    create.setAttribute('data-i18n', 'notes_empty_hint');
    create.textContent = t('notes_empty_hint');
    empty.appendChild(msg);
    empty.appendChild(create);
    editorWrap.appendChild(empty);
  }
  root.appendChild(editorWrap);

  // Footer: word count + pin/delete for the active note.
  const foot = document.createElement('div');
  foot.className = 'notes-foot';
  const count = document.createElement('span');
  count.className = 'notes-count';
  count.setAttribute('data-notesf', 'count');
  count.textContent = note ? notesCountLabel(note.body) : '';
  foot.appendChild(count);
  const actions = document.createElement('div');
  actions.className = 'notes-foot-actions';
  const pinBtn = document.createElement('button');
  pinBtn.type = 'button';
  pinBtn.className = 'notes-foot-btn' + (note && note.pinned ? ' active' : '');
  pinBtn.setAttribute('onclick', 'notesTogglePin()');
  pinBtn.disabled = !note;
  const pinLabel = note && note.pinned ? t('notes_unpin') : t('notes_pin');
  pinBtn.title = pinLabel;
  pinBtn.setAttribute('aria-label', pinLabel);
  pinBtn.innerHTML = _NOTES_PIN;
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'notes-foot-btn notes-del-btn';
  delBtn.setAttribute('onclick', 'notesDeleteActive()');
  delBtn.disabled = !note;
  delBtn.title = t('notes_delete');
  delBtn.setAttribute('aria-label', t('notes_delete'));
  delBtn.innerHTML = _NOTES_TRASH;
  actions.appendChild(pinBtn);
  actions.appendChild(delBtn);
  foot.appendChild(actions);
  root.appendChild(foot);
}

// Re-render every notes instance from notesState. `focus` puts the caret at the
// end of the active editor in the first visible instance (used after create).
function renderNotes(opts) {
  const roots = notesRoots();
  if (!roots.length) return;
  roots.forEach(renderNotesInto);
  if (opts && opts.focus) {
    const ta = notesRoots()
      .map(r => r.querySelector('[data-notesf="area"]'))
      .find(el => el && el.offsetParent !== null);
    if (ta) {
      ta.focus();
      const end = ta.value.length;
      try { ta.setSelectionRange(end, end); } catch { /* ignore */ }
      scheduleNotesIdleBlur();
    }
  }
}

// ── Load / save ──────────────────────────────────────────────────
async function loadNotes() {
  try {
    const res = await fetch('/notes/list');
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    notesState = {
      v: 1,
      activeId: typeof data.activeId === 'string' ? data.activeId : '',
      notes: Array.isArray(data.notes) ? data.notes : [],
    };
    if (!noteById(notesState.activeId)) notesState.activeId = notesState.notes[0] ? notesState.notes[0].id : '';
    notesLoaded = true;
    notesLoadRetryDelay = 1000;
    renderNotes();
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
async function persistNotes() {
  setNotesStatus('saving');
  try {
    const res = await fetch('/notes/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: notesState.notes, activeId: notesState.activeId }),
    });
    if (!res.ok) throw new Error('http ' + res.status);
    setNotesStatus('saved');
    clearTimeout(notesStatusTimer);
    notesStatusTimer = setTimeout(() => setNotesStatus(null), 1600);
  } catch {
    setNotesStatus('error');
  }
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
    const tab = root.querySelector(`.notes-tab[data-note-id="${note.id}"] .notes-tab-title`);
    if (tab) tab.textContent = noteTitle(val);
    const count = root.querySelector('[data-notesf="count"]');
    if (count) count.textContent = notesCountLabel(val);
    const ta = root.querySelector('[data-notesf="area"]');
    if (ta && ta !== srcEl && ta !== document.activeElement) ta.value = val;
  });

  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(persistNotes, 500);
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
