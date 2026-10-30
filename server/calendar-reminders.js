'use strict';
// Calendar reminders, decided once here for every surface. Each open dashboard
// used to check on its own: two of them (the Edge and a phone) both rang and
// raced to save the same list, and with no dashboard at all (Xenon used only as
// widgets on the screen) nothing rang. Now the server picks what is due and
// broadcasts SSE `calendar_reminder`; the dashboards and the on-screen alerts
// window only show it.
//
// - An event of the user's calendar rings at its reminder time, once: the
//   server writes `notifiedAt`, and a save from a dashboard holding an older
//   copy never clears it (keepNotified).
// - An event of a subscribed feed rings 10 minutes before it starts, when that
//   feed has reminders on. The feed cannot be written back, so what has rung is
//   kept in DATA_DIR/calendar-reminders.json (ids and times only, 2 days).
//
// Checked every 15 s and only while a surface is connected, as before: a
// reminder that comes due with nothing open rings on the next one that opens.

const fs = require('fs');

const CHECK_EVERY_MS = 15 * 1000;
const FEED_LEAD_MS = 10 * 60 * 1000;
const FIRED_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
const FIRED_MAX = 2000;
const TITLE_MAX = 120;

const parseMs = v => { const ms = Date.parse(v); return Number.isFinite(ms) ? ms : null; };

// A save carries the whole list as the surface last saw it. A reminder that has
// already rung stays rung for the same event and the same reminder time; moving
// the reminder makes it ring again.
function keepNotified(incoming, prev) {
  const rung = new Map();
  for (const e of Array.isArray(prev) ? prev : []) {
    if (e && e.id && e.notifiedAt) rung.set(e.id, e);
  }
  return incoming.map((e) => {
    const was = !e.notifiedAt && rung.get(e.id);
    return was && was.reminderAt === e.reminderAt ? { ...e, notifiedAt: was.notifiedAt } : e;
  });
}

// Marks the due events in place and returns them.
function markDueEvents(events, now) {
  const due = [];
  for (const e of events) {
    if (!e.reminderAt || e.notifiedAt) continue;
    const at = parseMs(e.reminderAt);
    if (at == null || at > now) continue;
    e.notifiedAt = new Date(now).toISOString();
    due.push(e);
  }
  return due;
}

function dueFeedEvents(events, feeds, fired, now) {
  const allowed = new Set((feeds || []).filter(f => f && f.reminders !== false).map(f => f.id));
  const due = [];
  for (const e of events || []) {
    if (!e || !allowed.has(e.source) || !e.id || Object.hasOwn(fired, e.id)) continue;
    const start = parseMs(e.startsAt);
    if (start == null || start < now || start - FEED_LEAD_MS > now) continue;
    due.push(e);
  }
  return due;
}

function pruneFired(map, now) {
  const kept = Object.entries(map && typeof map === 'object' ? map : {})
    .filter(([id, at]) => typeof id === 'string' && id.length <= 200 && Number.isFinite(at) && now - at < FIRED_KEEP_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, FIRED_MAX);
  return Object.fromEntries(kept);
}

// What goes on the wire: enough to draw the card, nothing else of the event.
function reminderPayload(e, feed) {
  return {
    id: String(e.id).slice(0, 200),
    title: String(e.title || '').slice(0, TITLE_MAX),
    startsAt: parseMs(e.startsAt) == null ? '' : String(e.startsAt),
    feed: feed === true,
  };
}

function createCalendarReminders({
  markLocal,          // (now) => Promise<event[]>: marks and saves the due events, under the events lock
  feedCache,          // () => { feeds, events }
  firedFile,
  writeFileAtomic,
  hasListeners,
  broadcast,
  onRing = () => {},
  now = Date.now,
  everyMs = CHECK_EVERY_MS,
}) {
  let fired = null;
  let timer = null;
  let checking = false;

  async function loadFired() {
    if (fired) return fired;
    try { fired = pruneFired(JSON.parse(await fs.promises.readFile(firedFile, 'utf8')), now()); }
    catch { fired = {}; }
    return fired;
  }

  function ring(payload) {
    broadcast('calendar_reminder', payload);
    try { onRing(payload); } catch { /* lights are a nicety */ }
  }

  async function check() {
    if (checking || !hasListeners()) return;
    checking = true;
    try {
      const at = now();
      for (const e of await markLocal(at)) ring(reminderPayload(e, false));
      const cache = feedCache() || {};
      if (!Array.isArray(cache.events) || !cache.events.length) return;
      const map = await loadFired();
      const due = dueFeedEvents(cache.events, cache.feeds, map, at);
      if (!due.length) return;
      for (const e of due) map[e.id] = at;
      fired = pruneFired(map, at);
      await writeFileAtomic(firedFile, JSON.stringify(fired));
      for (const e of due) ring(reminderPayload(e, true));
    } catch (e) {
      process.stdout.write(`[reminders] check failed: ${e.message}\n`);
    } finally {
      checking = false;
    }
  }

  return {
    check,
    start() {
      if (timer) return;
      timer = setInterval(check, everyMs);
      if (timer.unref) timer.unref();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = {
  createCalendarReminders, keepNotified, markDueEvents, dueFeedEvents, pruneFired, reminderPayload,
  FEED_LEAD_MS,
};
