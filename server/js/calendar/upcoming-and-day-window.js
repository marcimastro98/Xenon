// The list of what comes next, and the window of one day with its events.
'use strict';

// `allDayLabel` is passed in rather than looked up so this stays a pure function
// of its arguments — the unit tests evaluate it straight out of this file with
// nothing but timeParts injected. Empty for a timed event.
function upcomingWhenLabel(startsAt, now, locale, allDayLabel) {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return '';
  const ref = new Date(now);
  // Calendar days apart, never 24h chunks: at 23:00 an event at 08:00 tomorrow
  // is "1d" to a person and "9h" to a subtraction.
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(start) - midnight(ref)) / 86400000);
  // Today (or the minute just gone — the list keeps events up to 60s old): the
  // time of day is the thing that matters, and it is just as short.
  if (days <= 0) {
    // A whole-day event has no o'clock to report. Printing its 00:00 would say
    // the one thing that is not true about it.
    if (allDayLabel) return allDayLabel;
    return new Intl.DateTimeFormat(locale, timeParts()).format(start);
  }
  const [value, unit] = days < 14 ? [days, 'day']
    : days < 60 ? [Math.round(days / 7), 'week']
      : [Math.round(days / 30), 'month'];
  try {
    return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(value);
  } catch {
    // An engine without the unit style throws RangeError rather than degrading.
    return value + unit.charAt(0);
  }
}

// How many events the Upcoming list shows, and how far ahead it looks.
//
// There was never a rule about "the next two weeks" — the report that asked for
// a custom range had read one off the screen. The list took the next FIVE
// events, wherever they landed, so somebody with a quiet fortnight saw a chip
// eleven days out and concluded there was a fortnight-shaped window. The count
// was the only limit, and it was not adjustable either.
//
// Both are settings now. `upcomingDays` of 0 keeps exactly the old behaviour:
// no horizon, take what comes.
function upcomingLimits() {
  const s = (typeof hubSettings === 'object' && hubSettings) || {};
  const count = [3, 5, 8, 10].includes(Number(s.upcomingCount)) ? Number(s.upcomingCount) : 5;
  const days = [0, 7, 14, 30].includes(Number(s.upcomingDays)) ? Number(s.upcomingDays) : 0;
  return { count, days };
}

// How many columns the list is laid out in. 0 is "as many as fit", which is what
// it always did and still the default; 1 and 2 are the user overriding that.
//
// The automatic answer is a CSS `auto-fit` on a minimum width, and that minimum
// was set to the width of the ITEM rather than of the name inside it. An item
// spends about 70px on its dot, its gaps, its padding and the time on the right,
// so a 130px column left the title around eight characters — which is how a
// Xeneon Edge ended up showing "FC Barcel…" and "Levante - FC…" side by side,
// two columns of one word each. Reported with a screenshot from an Edge, where
// the panel is wide and short and every tile is narrow.
//
// The minimum is now the width at which a title is actually worth reading, so
// the second column appears later and carries something when it does. The manual
// setting is for the case that is nobody's business but the user's: a tile whose
// events all have long names, where one column is right at any width.
function upcomingColumns() {
  const s = (typeof hubSettings === 'object' && hubSettings) || {};
  return [0, 1, 2].includes(Number(s.upcomingColumns)) ? Number(s.upcomingColumns) : 0;
}

function _buildUpcomingInto(list) {
  const now = Date.now();
  const { count, days } = upcomingLimits();
  // Stamped on the list itself rather than on <body>: two Calendar tiles on the
  // same page (a second dashboard instance, the phone view) are laid out by the
  // same rule, and neither can be told apart by a body-level attribute.
  const cols = upcomingColumns();
  if (cols) list.dataset.cols = String(cols);
  else delete list.dataset.cols;
  // The horizon is counted in CALENDAR days, like the chip labels beside it: a
  // "7 days" that hid tomorrow evening because it is 7×24h+1 away would be
  // wrong in the one way a person would notice.
  let until = Infinity;
  if (days > 0) {
    const end = new Date(now);
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + days + 1);
    until = end.getTime();
  }
  const upcoming = allCalendarEvents()
    // Kept while it is still current (see eventActiveUntil — a whole-day event
    // runs to the end of its last day) and it starts inside the horizon.
    .filter(e => {
      const at = Date.parse(e.startsAt);
      return Number.isFinite(at) && eventActiveUntil(e) >= now - 60000 && at < until;
    })
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))
    .slice(0, count);
  list.innerHTML = '';
  if (!upcoming.length) {
    const empty = document.createElement('div');
    empty.className = 'event-empty';
    empty.textContent = t('no_upcoming');
    list.appendChild(empty);
    return;
  }
  const locale = t('locale');
  const fmt = new Intl.DateTimeFormat(locale, timeParts({ day: '2-digit', month: 'short' }));
  upcoming.forEach(e => {
    const item = document.createElement('div');
    item.className = 'upcoming-item';
    item.style.cursor = 'pointer';
    item.onclick = () => openDayModal(String(e.startsAt).slice(0, 10));
    const title = e.title || t('ph_title');
    // The exact date is not lost, it moves where it costs no width: the tooltip
    // carries the full name too, since the chip shows it with an ellipsis when
    // several events share the row. The tap still opens the day, which is the
    // touchscreen's answer to the same question.
    item.title = title + '\n' + fmt.format(new Date(e.startsAt));
    const dot = document.createElement('span');
    dot.className = 'upcoming-dot';
    const dotColor = eventDotColor(e, _calendarFeedsNow());
    if (dotColor) dot.style.setProperty('--dot', dotColor);
    const name = document.createElement('span');
    name.className = 'upcoming-name';
    name.textContent = title;
    const when = document.createElement('span');
    when.className = 'upcoming-when';
    when.textContent = upcomingWhenLabel(e.startsAt, now, locale, e.allDay ? t('event_all_day') : '');
    item.appendChild(dot);
    item.appendChild(name);
    item.appendChild(when);
    list.appendChild(item);
  });
}

function renderUpcoming() {
  document.querySelectorAll('[data-calf="upcoming-list"]').forEach(list => _buildUpcomingInto(list));
}

let dayModalLetGo = null;

function updateDayModalTitle() {
  if (!modalDateValue) return;
  const formatted = new Intl.DateTimeFormat(t('locale'), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(modalDateValue + 'T00:00:00'));
  $('day-modal-title').textContent = formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function openDayModal(dateValue) {
  modalDateValue = dateValue;
  selectedCalendarDate = dateValue;
  updateDayModalTitle();
  renderDayModalEvents();
  $('event-title').value = '';
  $('event-notes').value = '';
  $('event-time').value = '09:00';
  const lbl = $('time-picker-label');
  if (lbl) lbl.textContent = '09:00';
  $('event-reminder').value = '0';
  const endEl = $('event-end-date');
  if (endEl) { endEl.value = ''; endEl.min = dateValue; }
  $('day-modal').classList.add('open');
  holdDayModal();
  if (calendarMode) renderCalendar();
}

// The time list is a step inside the window: Esc takes that back first.
function dayModalEsc() {
  if ($('time-picker-dropdown').classList.contains('open')) toggleTimePicker();
  else closeDayModal();
}

function holdDayModal() {
  if (dayModalLetGo) return;
  if (typeof window.ambientFreeze === 'function') window.ambientFreeze('day-modal', true);
  dayModalLetGo = window.DialogFocus.hold($('day-modal'), { start: $('event-title'), onEsc: dayModalEsc });
}

function closeDayModal() {
  $('day-modal').classList.remove('open');
  modalDateValue = null;
  if (typeof window.ambientFreeze === 'function') window.ambientFreeze('day-modal', false);
  if (dayModalLetGo) dayModalLetGo();
  dayModalLetGo = null;
}

function renderDayModalEvents() {
  const list = $('day-modal-events');
  if (!list) return;
  list.innerHTML = '';
  const events = eventsForDate(modalDateValue || selectedCalendarDate);
  if (!events.length) {
    const empty = document.createElement('div');
    empty.className = 'event-empty';
    empty.textContent = t('no_events');
    list.appendChild(empty);
    return;
  }
  const fmt = new Intl.DateTimeFormat(t('locale'), timeParts());
  events.forEach(event => {
    const item = document.createElement('div');
    item.className = 'event-item';
    const top = document.createElement('div');
    top.className = 'event-item-top';
    const name = document.createElement('div');
    name.className = 'event-name';
    name.textContent = event.title || t('ph_title');
    const time = document.createElement('div');
    time.className = 'event-time';
    time.textContent = fmt.format(new Date(event.startsAt));
    if (event.readOnly) {
      const badge = document.createElement('span');
      badge.className = 'event-source-badge';
      const badgeColor = eventDotColor(event, _calendarFeedsNow());
      if (badgeColor) badge.style.background = badgeColor;
      badge.title = t('external_event');
      top.append(time, name, badge);
    } else {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'event-delete';
      del.title = t('delete_event');
      del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
      del.onclick = () => deleteCalendarEvent(event.id);
      top.append(time, name, del);
    }
    item.appendChild(top);
    if (event.notes) {
      item.appendChild(buildEventNote(event.notes));
    }
    list.appendChild(item);
  });
}

// An event note is the one place the calendar holds text worth taking away —
// meeting links, IDs, passcodes, a room number. Two things were in the way: the
// kiosk body sets `user-select: none` (right for a touchscreen, where dragging a
// tile must not select text), and the note is clamped to one line, so most of it
// could not even be read. So: the text opts back into selection, a tap expands
// the clamp, and a copy button takes the whole note in one go — the only path
// that works on the Edge's touchscreen, where a precise drag-select does not.
function buildEventNote(notes) {
  const meta = document.createElement('div');
  meta.className = 'event-meta';

  const text = document.createElement('div');
  text.className = 'event-note-text';
  text.textContent = notes;                       // untrusted (ICS feeds, AI) — never innerHTML
  text.title = t('event_note_expand');
  text.onclick = () => text.classList.toggle('expanded');

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'event-note-copy';
  copy.title = t('event_note_copy');
  copy.setAttribute('aria-label', t('event_note_copy'));
  copy.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  copy.onclick = async () => {
    if (await copyText(notes)) flashEventNoteCopied(copy);
  };

  meta.append(text, copy);
  return meta;
}
