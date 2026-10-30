'use strict';
// What Bit changes in a task (edit_task) or a calendar event (edit_calendar_event)
// that already exists: found by its id or by words from its text or title
// (accents and case ignored), only the fields named are changed, the others
// stay as they were. Pure: the caller reads, normalizes and writes the store.

const PRIORITIES = Object.freeze(['high', 'medium', 'low']);
const REPEATS = Object.freeze(['never', 'daily', 'weekly', 'custom']);
const CLEAR = 'none'; // "remove the reminder" / "no end"

const fold = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// The item named by `id` or by `words` in `field`: exact text first, then text
// holding the words. Two or more that hold them = ambiguous (Bit asks).
function findItem(list, id, words, field) {
  const byId = id ? list.find((x) => x.id === String(id).trim()) : null;
  if (byId) return { item: byId };
  const w = fold(words);
  if (!w) return { error: 'missing_target' };
  const exact = list.filter((x) => fold(x[field]) === w);
  if (exact.length === 1) return { item: exact[0] };
  const near = list.filter((x) => fold(x[field]).includes(w));
  if (near.length === 1) return { item: near[0] };
  if (near.length > 1) return { error: 'ambiguous', matches: near.slice(0, 8).map((x) => x[field]) };
  return { error: 'not_found' };
}

const has = (args, k) => args[k] != null && String(args[k]).trim() !== '';
const isDate = (s) => Number.isFinite(Date.parse(s));

// → { next, result } (next = the whole list to write, null = nothing to write)
function editTask(tasks, args) {
  const a = args || {};
  const found = findItem(tasks, a.id, a.task, 'text');
  if (!found.item) return { next: null, result: { ok: false, ...found } };
  const patch = {};
  if (has(a, 'text')) patch.text = String(a.text).trim().slice(0, 200);
  if (has(a, 'priority')) {
    if (!PRIORITIES.includes(a.priority)) return { next: null, result: { ok: false, error: 'bad_priority', allowed: PRIORITIES } };
    patch.priority = a.priority;
  }
  if (has(a, 'repeat')) {
    if (!REPEATS.includes(a.repeat)) return { next: null, result: { ok: false, error: 'bad_repeat', allowed: REPEATS } };
    patch.recurrence = a.repeat;
    if (a.repeat === 'custom') patch.recurrenceDays = Math.max(1, Math.min(365, Math.round(Number(a.every_days) || 1)));
  }
  if (!Object.keys(patch).length) return { next: null, result: { ok: false, error: 'nothing_to_change' } };
  const changed = { ...found.item, ...patch };
  return {
    next: tasks.map((t) => (t.id === changed.id ? changed : t)),
    result: { ok: true, task: { id: changed.id, text: changed.text, priority: changed.priority, repeat: changed.recurrence } },
  };
}

function editEvent(events, args) {
  const a = args || {};
  const found = findItem(events, a.id, a.event, 'title');
  if (!found.item) return { next: null, result: { ok: false, ...found } };
  const patch = {};
  if (has(a, 'title')) patch.title = String(a.title).trim().slice(0, 120);
  if (a.notes != null) patch.notes = String(a.notes).trim().slice(0, 600);
  for (const [arg, key] of [['starts_at', 'startsAt'], ['ends_at', 'endsAt'], ['reminder_at', 'reminderAt']]) {
    if (!has(a, arg)) continue;
    const v = String(a[arg]).trim();
    if (v.toLowerCase() === CLEAR && key !== 'startsAt') { patch[key] = ''; continue; }
    if (!isDate(v)) return { next: null, result: { ok: false, error: 'bad_date', field: arg } };
    patch[key] = v;
  }
  if (!Object.keys(patch).length) return { next: null, result: { ok: false, error: 'nothing_to_change' } };
  const changed = { ...found.item, ...patch };
  if (changed.endsAt && isDate(changed.startsAt) && Date.parse(changed.endsAt) < Date.parse(changed.startsAt)) {
    return { next: null, result: { ok: false, error: 'ends_before_start' } };
  }
  // A moved reminder rings again (calendar-reminders keepNotified agrees).
  if ('reminderAt' in patch && patch.reminderAt !== found.item.reminderAt) changed.notifiedAt = '';
  return {
    next: events.map((e) => (e.id === changed.id ? changed : e)),
    result: { ok: true, event: { id: changed.id, title: changed.title, startsAt: changed.startsAt, endsAt: changed.endsAt, reminderAt: changed.reminderAt } },
  };
}

module.exports = { PRIORITIES, REPEATS, findItem, editTask, editEvent };
