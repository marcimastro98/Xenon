// Loads and saves tasks with the engine, draws the list, and ticking, undoing, deleting and adding
// a task.
'use strict';

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

// ── Persistence ────────────────────────────────────────────────
//
// Each tap sends one edit, applied by the server to the list it has
// (js/list-sync.js, server/list-ops.js), and every screen repaints from the
// list the server broadcasts. Repeating tasks reopen on the server's clock.

let _tasksLoaded = false;
let _tasksLoadRetry = null;
let _tasksSyncInst = null;
// The number of the newest list shown (the server's `seq`, higher for every
// write), and a broadcast that arrived while an edit was on its way, held
// until that edit's answer says which of the two is newer.
let _tasksSeq = 0;
let _tasksHeld = null;
function _tasksSync() {
  if (!_tasksSyncInst) {
    _tasksSyncInst = window.ListSync.create({
      url: '/tasks',
      listKey: 'tasks',
      onList: (list, answer) => {
        const held = _tasksHeld;
        _tasksHeld = null;
        if (!list) { loadTasks(); return; }   // the edit was refused: show what is saved
        const seq = (answer && Number(answer.seq)) || 0;
        if (held && held.seq > seq) _showTasks(held.list, held.seq);
        else _showTasks(list, seq);
      },
    });
  }
  return _tasksSyncInst;
}

// Show a list unless a newer one is already on screen. A list without a
// number (an older server) is always shown.
function _showTasks(list, seq) {
  if (seq && seq < _tasksSeq) return;
  if (seq) _tasksSeq = seq;
  tasksData = list;
  _tasksLoaded = true;
  renderTasks();
}

async function loadTasks() {
  try {
    const res = await fetch('/tasks');
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    _tasksLoaded = true;
    // An edit still on its way would be undone on screen by this list; its
    // own answer brings the list in a moment.
    if (!(_tasksSyncInst && _tasksSyncInst.busy())) _showTasks(Array.isArray(data.tasks) ? data.tasks : [], Number(data.seq) || 0);
    else renderTasks();
  } catch {
    renderTasks();
    // Keep asking until the list arrives. An edit made meanwhile is safe: it
    // goes to the list on the PC, never over it.
    if (!_tasksLoaded && !_tasksLoadRetry) {
      _tasksLoadRetry = setTimeout(() => { _tasksLoadRetry = null; if (!_tasksLoaded) loadTasks(); }, 5000);
    }
  }
  syncTasksWidgetPlacement();
}

// The list another screen, a phone, a Deck key or the assistant just saved
// (the `tasks` event, with its `seq`).
function applyServerTasks(list, seq) {
  if (!Array.isArray(list)) return;
  const n = Number(seq) || 0;
  if (_tasksSyncInst && _tasksSyncInst.busy()) {
    if (!_tasksHeld || n >= _tasksHeld.seq) _tasksHeld = { list, seq: n };
    return;
  }
  _showTasks(list, n);
}

function sendTaskEdit(op) {
  return _tasksSync().send(op);
}

// ── Render ─────────────────────────────────────────────────────

function _buildTasksInto(list, completedSection, completedList, empty) {
  const active = tasksData
    .filter(t => !t.completed)
    .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1));
  const done = tasksData.filter(t => t.completed);

  list.textContent = '';
  active.forEach(t => list.appendChild(createTaskEl(t, false)));

  if (empty) empty.hidden = active.length > 0 || done.length > 0;

  if (completedSection && completedList) {
    completedList.textContent = '';
    done.forEach(t => completedList.appendChild(createTaskEl(t, true)));
    completedSection.hidden = done.length === 0;
  }
}

function renderTasks() {
  // Render into every tasks instance (primary widget + clones).
  // Each instance scopes its sub-elements within the nearest .tasks-scroll ancestor.
  document.querySelectorAll('[data-taskf="list"]').forEach(list => {
    const scope = list.closest('.tasks-scroll') || list.parentElement;
    const completedSection = scope.querySelector('[data-taskf="completed-section"]');
    const completedList = scope.querySelector('[data-taskf="completed-list"]');
    const empty = scope.querySelector('[data-taskf="empty"]');
    _buildTasksInto(list, completedSection, completedList, empty);
  });
}

function createTaskEl(task, isCompleted) {
  const li = document.createElement('li');
  li.className = `task-item task-priority-${task.priority}${isCompleted ? ' task-done' : ''}`;
  li.dataset.id = task.id;

  const dot = document.createElement('span');
  dot.className = 'task-dot';
  dot.setAttribute('aria-hidden', 'true');

  const textSpan = document.createElement('span');
  textSpan.className = 'task-text';
  textSpan.textContent = task.text;

  const meta = document.createElement('span');
  meta.className = 'task-meta';
  const badge = recurrenceBadgeLabel(task);
  if (badge) {
    const badgeEl = document.createElement('span');
    badgeEl.className = 'task-recur-badge';
    badgeEl.textContent = badge;
    meta.appendChild(badgeEl);
  }

  const actions = document.createElement('span');
  actions.className = 'task-actions';

  if (!isCompleted) {
    const tickBtn = document.createElement('button');
    tickBtn.className = 'task-btn task-btn-tick';
    tickBtn.title = t('task_tick');
    tickBtn.setAttribute('aria-label', t('task_tick'));
    tickBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,8 6,12 14,4"/></svg>';
    tickBtn.addEventListener('click', () => tickTask(task.id));
    actions.appendChild(tickBtn);
  } else {
    const undoBtn = document.createElement('button');
    undoBtn.className = 'task-btn task-btn-undo';
    undoBtn.title = t('task_undo');
    undoBtn.setAttribute('aria-label', t('task_undo'));
    undoBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a5 5 0 1 0 1.5-3.5L2 3"/><polyline points="2,3 2,7 6,7"/></svg>';
    undoBtn.addEventListener('click', () => undoTask(task.id));
    actions.appendChild(undoBtn);
  }

  const delBtn = document.createElement('button');
  delBtn.className = 'task-btn task-btn-delete';
  delBtn.title = t('task_delete');
  delBtn.setAttribute('aria-label', t('task_delete'));
  delBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
  delBtn.addEventListener('click', () => deleteTask(task.id));
  actions.appendChild(delBtn);

  li.appendChild(dot);
  li.appendChild(textSpan);
  li.appendChild(meta);
  li.appendChild(actions);
  return li;
}

function recurrenceBadgeLabel(task) {
  if (task.recurrence === 'never') return '';
  if (task.recurrence === 'daily') return t('task_recur_daily');
  if (task.recurrence === 'weekly') return t('task_recur_weekly');
  if (task.recurrence === 'custom') return `${task.recurrenceDays || 1} ${t('tasks_recur_days_label')}`;
  return '';
}

// ── Actions ────────────────────────────────────────────────────

function tickTask(id) {
  const task = tasksData.find(t => t.id === id);
  if (!task) return;
  task.completed = true;
  task.completedAt = new Date().toISOString();
  renderTasks();
  return sendTaskEdit({ op: 'update', id, patch: { completed: true, completedAt: task.completedAt } });
}

function undoTask(id) {
  const task = tasksData.find(t => t.id === id);
  if (!task) return;
  task.completed = false;
  task.completedAt = null;
  renderTasks();
  return sendTaskEdit({ op: 'update', id, patch: { completed: false, completedAt: null } });
}

function deleteTask(id) {
  const idx = tasksData.findIndex(t => t.id === id);
  if (idx === -1) return;
  tasksData.splice(idx, 1);
  renderTasks();
  return sendTaskEdit({ op: 'delete', id });
}

function addTask() {
  const input = document.getElementById('tasks-new-input');
  const prioritySel = document.getElementById('tasks-priority-select');
  const recurSel = document.getElementById('tasks-recur-select');
  const recurDaysInput = document.getElementById('tasks-recur-days');
  if (!input) return;

  const text = input.value.trim();
  if (!text) return;

  const priority = prioritySel ? prioritySel.value : 'medium';
  const recurrence = recurSel ? recurSel.value : 'never';
  const recurrenceDays = (recurrence === 'custom' && recurDaysInput)
    ? Math.max(1, parseInt(recurDaysInput.value, 10) || 1) : 1;

  const task = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    text,
    priority,
    recurrence,
    recurrenceDays,
    completed: false,
    completedAt: null,
    createdAt: new Date().toISOString(),
  };

  tasksData.push(task);
  input.value = '';
  onTaskRecurrenceChange();
  renderTasks();
  return sendTaskEdit({ op: 'add', item: task });
}

// ── Input helpers ──────────────────────────────────────────────

function onTaskInput(e) {
  if (e.key === 'Enter') addTask();
}
