// Moving between months, loading and saving events with the engine, the outside calendar feeds and
// reminders.
'use strict';

// Swap the copy icon for a check for a moment, so the tap has an answer.
function flashEventNoteCopied(btn) {
  if (btn._resetTimer) clearTimeout(btn._resetTimer);
  if (!btn._icon) btn._icon = btn.innerHTML;
  btn.classList.add('is-copied');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';
  btn.title = t('event_note_copied');
  btn._resetTimer = setTimeout(() => {
    btn.classList.remove('is-copied');
    btn.innerHTML = btn._icon;
    btn.title = t('event_note_copy');
    btn._resetTimer = null;
  }, 1400);
}

function moveCalendarMonth(delta) {
  calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + delta, 1);
  renderCalendar();
}

function jumpCalendarToday() {
  const today = new Date();
  selectedCalendarDate = toDateInputValue(today);
  calendarViewDate = new Date(today.getFullYear(), today.getMonth(), 1);
  renderCalendar();
}

// Each change sends one edit, applied by the server to the events it has
// (js/list-sync.js, server/list-ops.js), and every screen repaints from the
// list the server broadcasts (the `agenda` event).
let _calendarEventsLoaded = false;
let _calendarLoadRetry = null;
let _calendarSyncInst = null;
// The number of the newest list shown (the server's `seq`), and a broadcast
// that arrived while an edit was on its way, held until that edit's answer
// says which of the two is newer (as in tasks.js).
let _calendarSeq = 0;
let _calendarHeld = null;
function _calendarSync() {
  if (!_calendarSyncInst) {
    _calendarSyncInst = window.ListSync.create({
      url: SERVER + '/events',
      listKey: 'events',
      onList: (list, answer) => {
        const held = _calendarHeld;
        _calendarHeld = null;
        if (!list) { loadCalendarEvents(); return; }   // refused: show what is saved
        const seq = (answer && Number(answer.seq)) || 0;
        if (held && held.seq > seq) _showCalendarEvents(held.list, held.seq);
        else _showCalendarEvents(list, seq);
      },
    });
  }
  return _calendarSyncInst;
}

function repaintCalendarEvents() {
  if (calendarMode) renderCalendar();
  const modal = typeof $ === 'function' ? $('day-modal') : null;
  if (modal && modal.classList.contains('open')) renderDayModalEvents();
  renderUpcoming();
}

// Show a list unless a newer one is already on screen. A list without a
// number (an older server) is always shown.
function _showCalendarEvents(list, seq) {
  if (seq && seq < _calendarSeq) return;
  if (seq) _calendarSeq = seq;
  calendarEvents = list;
  _calendarEventsLoaded = true;
  calendarLoaded = true;
  repaintCalendarEvents();
}

async function loadCalendarEvents() {
  try {
    const res = await fetch(SERVER + '/events');
    if (!res.ok) throw new Error('events unavailable');
    const data = await res.json();
    _calendarEventsLoaded = true;
    calendarLoaded = true;
    // An edit still on its way would be undone on screen by this list; its
    // own answer brings the list in a moment.
    if (!(_calendarSyncInst && _calendarSyncInst.busy())) _showCalendarEvents(Array.isArray(data.events) ? data.events : [], Number(data.seq) || 0);
    else repaintCalendarEvents();
  } catch {
    // Keep what is on screen and keep asking. An event added meanwhile is
    // safe: it goes to the list on the PC, never over it.
    calendarLoaded = true;
    repaintCalendarEvents();
    if (!_calendarEventsLoaded && !_calendarLoadRetry) {
      _calendarLoadRetry = setTimeout(() => { _calendarLoadRetry = null; if (!_calendarEventsLoaded) loadCalendarEvents(); }, 5000);
    }
  }
}

// The events another screen, a phone or the assistant just saved (the
// `agenda` event, with its `seq`).
function applyServerEvents(list, seq) {
  if (!Array.isArray(list)) return;
  const n = Number(seq) || 0;
  if (_calendarSyncInst && _calendarSyncInst.busy()) {
    if (!_calendarHeld || n >= _calendarHeld.seq) _calendarHeld = { list, seq: n };
    return;
  }
  _showCalendarEvents(list, n);
}

let externalEvents = [];
let externalFeedsStatus = [];

async function loadExternalEvents() {
  try {
    const res = await fetch(SERVER + '/external-events');
    if (!res.ok) throw new Error('external unavailable');
    const data = await res.json();
    externalEvents = Array.isArray(data.events) ? data.events : [];
    externalFeedsStatus = Array.isArray(data.feeds) ? data.feeds : [];
  } catch {
    // Transient fetch error: drop external events from the view but keep the
    // last-good externalFeedsStatus so reminder gating survives a brief outage.
    externalEvents = [];
  }
  if (calendarMode) renderCalendar();
  renderUpcoming();
}

// Local + external combined, used by every render path.
function allCalendarEvents() {
  return externalEvents.length ? calendarEvents.concat(externalEvents) : calendarEvents;
}

function sendCalendarEdit(op) {
  return _calendarSync().send(op);
}

async function saveCalendarEvent() {
  const title = $('event-title').value.trim();
  const dateValue = modalDateValue || selectedCalendarDate;
  const starts = combineDateTime(dateValue, $('event-time').value);
  if (!title || !starts) { $('event-title').focus(); return; }
  const reminderMinutes = Number($('event-reminder').value);
  const reminderAt = reminderMinutes >= 0 ? toLocalDateTimeValue(new Date(starts.getTime() - reminderMinutes * 60000)) : '';
  // Optional multi-day: an end date later than the start day makes the event
  // span every day in between. Stored as a naive local datetime, mirroring
  // startsAt, so _eventEndDay buckets it to the correct inclusive last day.
  const endDateVal = $('event-end-date') ? $('event-end-date').value : '';
  let endsAt = '';
  if (endDateVal && endDateVal > dateValue) {
    const ends = combineDateTime(endDateVal, $('event-time').value);
    if (ends) endsAt = toLocalDateTimeValue(ends);
  }
  const event = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title,
    notes: $('event-notes').value.trim(),
    startsAt: toLocalDateTimeValue(starts),
    endsAt,
    reminderAt,
    notifiedAt: '',
    createdAt: toLocalDateTimeValue(new Date()),
  };
  calendarEvents.push(event);
  $('event-title').value = '';
  $('event-notes').value = '';
  if ($('event-end-date')) $('event-end-date').value = '';
  selectedCalendarDate = dateValue;
  calendarViewDate = new Date(starts.getFullYear(), starts.getMonth(), 1);
  sendCalendarEdit({ op: 'add', item: event });
  if (calendarMode) renderCalendar();
  renderDayModalEvents();
  renderUpcoming();
  if ('Notification' in window && Notification.permission === 'default') {
    try { Promise.resolve(Notification.requestPermission()).catch(() => {}); } catch {}
  }
}

function deleteCalendarEvent(id) {
  calendarEvents = calendarEvents.filter(event => event.id !== id);
  sendCalendarEdit({ op: 'delete', id });
  if (calendarMode) renderCalendar();
  if ($('day-modal').classList.contains('open')) renderDayModalEvents();
  renderUpcoming();
}

// The server decides when a reminder rings, once for every surface (SSE
// calendar_reminder, server/calendar-reminders.js), and flashes the lights;
// this surface shows it, rings, and keeps its own copy of the event in step.
function showReminder(d) {
  const fmt = new Intl.DateTimeFormat(t('locale'), timeParts({ weekday: 'short' }));
  const toast = window.AlertToasts ? window.AlertToasts.reminder(d, { t }, date => fmt.format(date)) : null;
  if (!toast) return;
  const own = calendarEvents.find(event => event.id === d.id);
  if (own) own.notifiedAt = new Date().toISOString();
  if (window.XenonToast) window.XenonToast.show(toast);
  playReminderSound();
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(t('desktop_title'), { body: toast.message ? `${toast.title} - ${toast.message}` : toast.title, silent: false, requireInteraction: true });
    } catch { }
  }
}
