'use strict';

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const RECURRENCE_MS = { daily: 86_400_000, weekly: 7 * 86_400_000 };

// ── Persistence ────────────────────────────────────────────────

async function loadTasks() {
  try {
    const res = await fetch('/tasks');
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    tasksData = Array.isArray(data.tasks) ? data.tasks : [];
    if (checkTaskRecurrence()) await saveTasks();
    renderTasks();
  } catch {
    renderTasks();
  }
  syncTasksWidgetPlacement();
}

async function saveTasks() {
  try {
    await fetch('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: tasksData }),
    });
  } catch { /* non-critical — next save will retry */ }
}

// ── Recurrence ────────────────────────────────────────────────

function checkTaskRecurrence() {
  const now = Date.now();
  let changed = false;
  for (const task of tasksData) {
    if (!task.completed || !task.completedAt) continue;
    let interval = 0;
    if (task.recurrence === 'daily') interval = RECURRENCE_MS.daily;
    else if (task.recurrence === 'weekly') interval = RECURRENCE_MS.weekly;
    else if (task.recurrence === 'custom') interval = (task.recurrenceDays || 1) * RECURRENCE_MS.daily;
    if (interval > 0 && now - new Date(task.completedAt).getTime() >= interval) {
      task.completed = false;
      task.completedAt = null;
      changed = true;
    }
  }
  return changed;
}

// ── Render ─────────────────────────────────────────────────────

function renderTasks() {
  const list = document.getElementById('tasks-list');
  const completedSection = document.getElementById('tasks-completed-section');
  const completedList = document.getElementById('tasks-completed-list');
  const empty = document.getElementById('tasks-empty');
  if (!list) return;

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

async function tickTask(id) {
  const task = tasksData.find(t => t.id === id);
  if (!task) return;
  task.completed = true;
  task.completedAt = new Date().toISOString();
  renderTasks();
  await saveTasks();
}

async function undoTask(id) {
  const task = tasksData.find(t => t.id === id);
  if (!task) return;
  task.completed = false;
  task.completedAt = null;
  renderTasks();
  await saveTasks();
}

async function deleteTask(id) {
  const idx = tasksData.findIndex(t => t.id === id);
  if (idx === -1) return;
  tasksData.splice(idx, 1);
  renderTasks();
  await saveTasks();
}

async function addTask() {
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
  await saveTasks();
}

// ── Input helpers ──────────────────────────────────────────────

function onTaskInput(e) {
  if (e.key === 'Enter') addTask();
}

/**
 * Moves tasks UI between the embedded calendar pane and the standalone widget section.
 * Called by applyDashboardLayout() and after loadTasks().
 */
function syncTasksWidgetPlacement() {
  const layout = typeof getDashboardLayout === 'function' ? getDashboardLayout() : null;
  const visible = layout && layout.widgets.tasks ? layout.widgets.tasks.visible : false;

  const calPane = document.getElementById('cal-pane-tasks');
  const standalone = document.querySelector('[data-dashboard-widget="tasks"]');
  const toggleBtn = document.getElementById('toggle-tasks');

  if (!calPane || !standalone) return;

  if (visible) {
    // Move tasks UI into the standalone section (it had been in cal-pane-tasks).
    while (calPane.firstChild) standalone.appendChild(calPane.firstChild);
    if (toggleBtn) toggleBtn.hidden = true;
    switchCalendarTaskView('calendar', { persist: false });
  } else {
    // Move tasks UI back into the calendar pane.
    while (standalone.firstChild) calPane.appendChild(standalone.firstChild);
    if (toggleBtn) toggleBtn.hidden = false;
  }
}

function switchCalendarTaskView(view, { persist = true } = {}) {
  const panes = {
    calendar: document.getElementById('cal-pane-calendar'),
    tasks:    document.getElementById('cal-pane-tasks'),
    timer:    document.getElementById('cal-pane-timer'),
  };
  const btns = {
    calendar: document.getElementById('toggle-cal'),
    tasks:    document.getElementById('toggle-tasks'),
    timer:    document.getElementById('toggle-timer'),
  };

  // Hide all panes, then show the active one
  for (const [key, pane] of Object.entries(panes)) {
    if (!pane) continue;
    pane.hidden = key !== view;
  }
  // Update button active state
  for (const [key, btn] of Object.entries(btns)) {
    if (!btn) continue;
    const active = key === view;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }

  if (persist && typeof persistDashboardCalendarTab === 'function') persistDashboardCalendarTab(view);
}

function onTaskRecurrenceChange() {
  const recurSel = document.getElementById('tasks-recur-select');
  const daysRow = document.getElementById('tasks-recur-days-row');
  if (!recurSel || !daysRow) return;
  daysRow.hidden = recurSel.value !== 'custom';
}
