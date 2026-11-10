'use strict';
// One edit to a list of records that carry an id (the Tasks list, the calendar
// events), applied to the server's own copy.
//
// The dashboard used to save these lists whole: it posted the list it had, and
// the server took it. A screen holding an older list therefore deleted what
// another screen, a phone or the assistant had added in between, and a screen
// whose first load failed held an empty list, so the next thing it saved
// replaced the whole agenda with one event. Sending the edit instead of the
// list makes two edits from two screens both land, whatever each one had on
// screen, and makes a failed load harmless: the server applies the edit to the
// list it really has.
//
// Each edit is safe to send twice (a retry after a lost answer): adding an id
// that is already there, or changing or deleting one that is gone, changes
// nothing.

const LIST_OPS = new Set(['add', 'update', 'delete']);
const ID_MAX = 80;

function isListOp(body) {
  return !!body && typeof body === 'object' && !Array.isArray(body) && LIST_OPS.has(body.op);
}

/**
 * @param list    the current records
 * @param body    { op: 'add', item } | { op: 'update', id, patch } | { op: 'delete', id }
 * @param fields  the fields an update may change (never the id)
 * @returns { list, changed } or { error }
 */
function applyListOp(list, body, fields) {
  const cur = Array.isArray(list) ? list : [];
  if (!isListOp(body)) return { error: 'bad_op' };
  const item = body.item && typeof body.item === 'object' && !Array.isArray(body.item) ? body.item : null;
  const id = String(body.id || (item && item.id) || '').trim().slice(0, ID_MAX);
  if (!id) return { error: 'missing_id' };
  const at = cur.findIndex((x) => x && x.id === id);
  if (body.op === 'add') {
    if (!item) return { error: 'missing_item' };
    if (at >= 0) return { list: cur, changed: false };
    return { list: cur.concat([{ ...item, id }]), changed: true };
  }
  if (at < 0) return { list: cur, changed: false };
  if (body.op === 'delete') return { list: cur.filter((_, i) => i !== at), changed: true };
  const patch = body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch) ? body.patch : {};
  const next = { ...cur[at] };
  let changed = false;
  for (const k of fields || []) {
    if (k === 'id' || !Object.prototype.hasOwnProperty.call(patch, k)) continue;
    next[k] = patch[k];
    changed = true;
  }
  if (!changed) return { list: cur, changed: false };
  return { list: cur.map((x, i) => (i === at ? next : x)), changed: true };
}

// A finished repeating task comes back once its interval has passed since it
// was ticked. This used to run only when a dashboard loaded the list, so on a
// screen that stays on all day a daily task stayed ticked until someone reloaded
// the page. The server now runs it on a clock, for every screen at once.
const DAY_MS = 86_400_000;
function taskRepeatMs(task) {
  if (!task) return 0;
  if (task.recurrence === 'daily') return DAY_MS;
  if (task.recurrence === 'weekly') return 7 * DAY_MS;
  if (task.recurrence === 'custom') return Math.max(1, Number(task.recurrenceDays) || 1) * DAY_MS;
  return 0;
}
function reopenDueTasks(tasks, now = Date.now()) {
  const cur = Array.isArray(tasks) ? tasks : [];
  let changed = false;
  const list = cur.map((t) => {
    if (!t || !t.completed || !t.completedAt) return t;
    const every = taskRepeatMs(t);
    const doneAt = Date.parse(t.completedAt);
    if (!every || !Number.isFinite(doneAt) || now - doneAt < every) return t;
    changed = true;
    return { ...t, completed: false, completedAt: null };
  });
  return { list, changed };
}

module.exports = { LIST_OPS, isListOp, applyListOp, reopenDueTasks, taskRepeatMs };
