// What the assistant does when asked about the tasks: list, add, change, tick off, delete one
// or all.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

const { normalizeTask, TASK_PRIORITIES } = require('./tasks-normalize.js');
const AgendaAi = require('../agenda-ai.js');

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'list_tasks': async (_context, { readTasks }) => {
      let fnResult;
      const tasks = await readTasks();
      fnResult = { tasks: tasks.map(t => ({ id: t.id, text: t.text, priority: t.priority, completed: t.completed })) };
      return fnResult;
  },

  'create_task': async ({ fnArgs, clientActions }, { aiActionLog, updateTasks }) => {
      let fnResult;
      const taskText = String(fnArgs.text || '').trim();
      if (!taskText) { fnResult = { error: 'empty text' }; }
      else {
        const newTask = normalizeTask({
          text: taskText,
          priority: TASK_PRIORITIES.includes(fnArgs.priority) ? fnArgs.priority : 'medium',
          recurrence: 'never',
        });
        await updateTasks((tasks) => ({ next: tasks.concat([newTask]) }));
        clientActions.push({ action: 'refresh_tasks', args: {} });
        aiActionLog.record({ name: 'create_task', label: `Task creato: "${newTask.text}"`, undo: { kind: 'delete_task', id: newTask.id } });
        fnResult = { ok: true, task: { id: newTask.id, text: newTask.text, priority: newTask.priority } };
      }
      return fnResult;
  },

  'delete_task': async ({ fnArgs, clientActions }, { updateTasks }) => {
      let fnResult;
      const delId = String(fnArgs.id || '').trim();
      if (!delId) { fnResult = { error: 'missing id' }; }
      else {
        const r = await updateTasks((tasks) => {
          const remaining = tasks.filter(t => t.id !== delId);
          return remaining.length === tasks.length ? { found: false } : { found: true, next: remaining };
        });
        if (!r.found) { fnResult = { error: 'task not found', id: delId }; }
        else {
          clientActions.push({ action: 'refresh_tasks', args: {} });
          fnResult = { ok: true, deleted: delId };
        }
      }
      return fnResult;
  },

  'clear_all_tasks': async ({ clientActions }, { aiActionLog, updateTasks }) => {
      let fnResult;
      const { prevTasks } = await updateTasks((tasks) => ({ prevTasks: tasks, next: [] }));
      clientActions.push({ action: 'refresh_tasks', args: {} });
      aiActionLog.record({ name: 'clear_all_tasks', label: 'Tutti i task cancellati', undo: { kind: 'restore_tasks', prev: prevTasks } });
      fnResult = { ok: true, deleted: 'all' };
      return fnResult;
  },

  'edit_task': async ({ fnArgs, clientActions }, { aiActionLog, updateTasks }) => {
      let fnResult;
      const r = await updateTasks((tasks) => {
        const { next, result } = AgendaAi.editTask(tasks, fnArgs);
        return next ? { next, result, prev: tasks } : { result };
      });
      if (r.changed) {
        clientActions.push({ action: 'refresh_tasks', args: {} });
        aiActionLog.record({ name: 'edit_task', label: `Task modificato: "${r.result.task.text}"`, undo: { kind: 'restore_tasks', prev: r.prev } });
      }
      fnResult = r.result;
      return fnResult;
  },

  'complete_task': async ({ fnArgs, clientActions }, { updateTasks }) => {
      let fnResult;
      const taskId = String(fnArgs.id || '').trim();
      const makeCompleted = fnArgs.completed !== false; // defaults to true
      if (!taskId) { fnResult = { error: 'missing id' }; }
      else {
        const r = await updateTasks((tasks) => {
          const task = tasks.find(t => t.id === taskId);
          if (!task) return { found: false };
          return { found: true, next: tasks.map(t => (t === task ? { ...t, completed: makeCompleted, completedAt: makeCompleted ? new Date().toISOString() : null } : t)) };
        });
        if (!r.found) { fnResult = { error: 'task not found', id: taskId }; }
        else {
          clientActions.push({ action: 'refresh_tasks', args: {} });
          fnResult = { ok: true, id: taskId, completed: makeCompleted };
        }
      }
      return fnResult;
  },
};

module.exports = { branches };
