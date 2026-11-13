// Calendar events as the engine stores them: the check of the saved list, the fields a
// dashboard may edit, and the colours of subscribed calendars.

const CALENDAR_FEED_PALETTE = Object.freeze(['#1ed760', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6']);

function normalizeEvents(value) {
  const source = Array.isArray(value) ? value : (Array.isArray(value && value.events) ? value.events : []);
  return source.slice(0, 250).map(item => {
    const title = String(item && item.title || '').trim().slice(0, 120);
    const notes = String(item && item.notes || '').trim().slice(0, 600);
    const startsAt = String(item && item.startsAt || '').trim();
    const endsAt = String(item && item.endsAt || '').trim();
    const reminderAt = String(item && item.reminderAt || '').trim();
    const id = String(item && item.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 80);
    // endsAt is optional (multi-day events): keep it only when it parses and is
    // not before the start, otherwise drop it so the event stays single-day.
    const endValid = Number.isFinite(Date.parse(endsAt)) &&
      (!Number.isFinite(Date.parse(startsAt)) || Date.parse(endsAt) >= Date.parse(startsAt));
    return {
      id,
      title,
      notes,
      startsAt: Number.isFinite(Date.parse(startsAt)) ? startsAt : '',
      endsAt: endValid ? endsAt : '',
      reminderAt: Number.isFinite(Date.parse(reminderAt)) ? reminderAt : '',
      notifiedAt: item && item.notifiedAt ? String(item.notifiedAt).slice(0, 40) : '',
      createdAt: item && item.createdAt ? String(item.createdAt).slice(0, 40) : new Date().toISOString(),
    };
  }).filter(item => item.title || item.startsAt || item.notes);
}

// What a dashboard may change on one event (list-ops.js). notifiedAt is the
// server's, set when the reminder rings.
const EVENT_EDIT_FIELDS = Object.freeze(['title', 'notes', 'startsAt', 'endsAt', 'reminderAt']);

module.exports = { CALENDAR_FEED_PALETTE, normalizeEvents, EVENT_EDIT_FIELDS };
