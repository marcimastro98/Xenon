// Tasks as the engine stores them: their limit, the check of one task and of the list, and the
// fields a dashboard may edit.

const TASKS_MAX = 100;

const TASK_PRIORITIES = Object.freeze(['high', 'medium', 'low']);
const TASK_RECURRENCES = Object.freeze(['never', 'daily', 'weekly', 'custom']);

function normalizeTask(item) {
  const text = String(item && item.text || '').trim().slice(0, 200);
  const id = String(item && item.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 80);
  const priority = TASK_PRIORITIES.includes(item && item.priority) ? item.priority : 'medium';
  const recurrence = TASK_RECURRENCES.includes(item && item.recurrence) ? item.recurrence : 'never';
  const recurrenceDays = (recurrence === 'custom' && Number.isFinite(Number(item && item.recurrenceDays)) && Number(item.recurrenceDays) >= 1)
    ? Math.round(Number(item.recurrenceDays)) : 1;
  const completed = Boolean(item && item.completed);
  const completedAt = completed && item.completedAt ? String(item.completedAt).slice(0, 40) : null;
  const createdAt = item && item.createdAt ? String(item.createdAt).slice(0, 40) : new Date().toISOString();
  return { id, text, priority, recurrence, recurrenceDays, completed, completedAt, createdAt };
}

function normalizeTasks(value) {
  const source = Array.isArray(value) ? value : [];
  return source.slice(0, TASKS_MAX).map(normalizeTask).filter(t => t.text.length > 0);
}

// What a dashboard may change on one task (list-ops.js).
const TASK_EDIT_FIELDS = Object.freeze(['text', 'priority', 'recurrence', 'recurrenceDays', 'completed', 'completedAt']);

module.exports = {
  TASKS_MAX, TASK_PRIORITIES, TASK_RECURRENCES, normalizeTask, normalizeTasks, TASK_EDIT_FIELDS,
};
