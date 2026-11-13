// Builds the month grid: which events fall on a day, the dots under it and the roll-over at
// midnight.
'use strict';

// LOCAL calendar day (YYYY-MM-DD) for an event's start, or null if unusable.
// External timed events are stored as UTC ISO ("…Z"); local and all-day events
// are naive. Bucketing via a real Date (not startsAt.slice(0,10)) lands a UTC
// instant near midnight on the correct cell in the user's timezone.
function _eventStartDay(event) {
  if (!event.startsAt) return null;
  const d = new Date(event.startsAt);
  return Number.isNaN(d.getTime()) ? null : toDateInputValue(d);
}

// Inclusive last calendar day an event covers. Multi-day external events carry
// endsAt (see ics-feeds.js); everything else is a single day. Bucketed by the
// LOCAL day, mirroring _eventStartDay.
function _eventEndDay(event, startDay) {
  if (!event.endsAt) return startDay;
  let ms = Date.parse(event.endsAt);
  if (Number.isNaN(ms)) return startDay;
  // Timed ends are exclusive UTC-ISO ("…Z"); an end at exactly local midnight
  // (e.g. a 22:00→00:00 block) must not spill onto the next cell, so step back
  // 1 ms before bucketing. All-day ends are already the inclusive last day
  // (see _occurrenceEnd in ics-feeds.js), so they're left untouched.
  if (/Z$/.test(event.endsAt)) ms -= 1;
  const end = toDateInputValue(new Date(ms));
  return end > startDay ? end : startDay;
}

function eventsForDate(dateValue) {
  return allCalendarEvents()
    .filter(event => {
      const startDay = _eventStartDay(event);
      if (!startDay) return false;
      // A multi-day event appears on every day in [startDay, endDay]; string
      // compare is chronological for the YYYY-MM-DD format.
      return startDay <= dateValue && dateValue <= _eventEndDay(event, startDay);
    })
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
}

// The colour an event's dot wears. An external event belongs to a calendar the
// user gave a colour (Settings → External calendars), and the dot says which one.
// The calendar's live colour comes first, so a colour just changed in Settings
// shows at once instead of when the events are next fetched (up to 5 minutes);
// then the colour the event itself carries; then nothing, which is a local event
// and keeps the accent dot. Pure: `feeds` is hubSettings.calendarFeeds, passed in.
function eventDotColor(event, feeds) {
  if (!event) return '';
  const feed = event.source && Array.isArray(feeds) ? feeds.find((f) => f && f.id === event.source) : null;
  return (feed && feed.color) || event.color || '';
}

// The dots under a day: one per distinct calendar colour among its events, in the
// order they happen, at most `max`. A day with only local events gets the one
// accent dot it always had (an empty colour). Pure.
function dayDotColors(events, feeds, max) {
  const limit = max > 0 ? max : 3;
  const out = [];
  for (const event of Array.isArray(events) ? events : []) {
    const color = eventDotColor(event, feeds);
    if (!out.includes(color)) out.push(color);
    if (out.length >= limit) break;
  }
  return out;
}

function _calendarFeedsNow() {
  return (typeof hubSettings !== 'undefined' && hubSettings && Array.isArray(hubSettings.calendarFeeds)) ? hubSettings.calendarFeeds : [];
}

// First weekday column: 0 = Sunday, 1 = Monday (default). Reads the user's
// preference from hubSettings when present, else keeps the historical Monday.
function calendarWeekStart() {
  return (typeof hubSettings !== 'undefined' && hubSettings && hubSettings.weekStart === 'sun') ? 0 : 1;
}

// One span per length; the card's width picks which one shows (CalendarView.css).
function _monthLabelSpan(locale, format, className) {
  const label = new Intl.DateTimeFormat(locale, format).format(calendarViewDate);
  const span = document.createElement('span');
  span.className = className;
  span.textContent = label.charAt(0).toUpperCase() + label.slice(1);
  return span;
}

function _buildCalendarInto(monthEl, weekdaysEl, daysEl) {
  const locale = t('locale');
  if (monthEl) {
    // The short name drops this year's number: with it "Aujourd'hui" still wrapped.
    const thisYear = calendarViewDate.getFullYear() === new Date().getFullYear();
    monthEl.replaceChildren(
      _monthLabelSpan(locale, { month: 'long', year: 'numeric' }, 'calendar-month-long'),
      _monthLabelSpan(locale, thisYear ? { month: 'short' } : { month: 'short', year: 'numeric' }, 'calendar-month-short'),
    );
  }

  const weekStart = calendarWeekStart();
  if (weekdaysEl) {
    weekdaysEl.innerHTML = '';
    // t('weekdays') is Monday-first; rotate Sunday to the front when requested.
    const wd = t('weekdays');
    const labels = weekStart === 0 ? [wd[6]].concat(wd.slice(0, 6)) : wd;
    labels.forEach(day => {
      const el = document.createElement('span');
      el.textContent = day;
      weekdaysEl.appendChild(el);
    });
  }

  if (!daysEl) return;
  daysEl.innerHTML = '';
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  const first = new Date(year, month, 1);
  const offset = (first.getDay() - weekStart + 7) % 7;
  const totalDays = new Date(year, month + 1, 0).getDate();
  const todayValue = toDateInputValue(new Date());
  daysEl.style.setProperty('--calendar-weeks', String(Math.ceil((offset + totalDays) / 7)));

  for (let i = 0; i < offset; i++) {
    const empty = document.createElement('button');
    empty.className = 'day-cell empty';
    empty.tabIndex = -1;
    daysEl.appendChild(empty);
  }

  for (let day = 1; day <= totalDays; day++) {
    const dateValue = toDateInputValue(new Date(year, month, day));
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'day-cell';
    if (dateValue === todayValue) cell.classList.add('today');
    if (dateValue === selectedCalendarDate) cell.classList.add('selected');
    const dayEvents = eventsForDate(dateValue);
    cell.textContent = day;
    if (dayEvents.length) {
      cell.classList.add('has-events');
      // One dot per calendar colour that day (at most three), side by side.
      const dots = document.createElement('span');
      dots.className = 'day-dots';
      dots.setAttribute('aria-hidden', 'true');
      for (const color of dayDotColors(dayEvents, _calendarFeedsNow(), 3)) {
        const dot = document.createElement('span');
        dot.className = 'day-dot';
        if (color) dot.style.setProperty('--dot', color);
        dots.appendChild(dot);
      }
      cell.appendChild(dots);
    }
    cell.onclick = () => openDayModal(dateValue);
    daysEl.appendChild(cell);
  }
}

function checkCalendarDayRollover() {
  const today = toDateInputValue(new Date());
  if (today === _calendarRenderedDay) return;
  // The `today` highlight is recomputed on render, but `selected` follows its own
  // variable. If the user hadn't manually picked another day (selection was still
  // pinned to the day that was "today" until now), carry the selection forward so
  // the rollover doesn't strand a stale `selected` cell one day behind `today` —
  // the "two highlighted days" a dashboard left open past midnight showed.
  if (selectedCalendarDate === _calendarRenderedDay) selectedCalendarDate = today;
  renderCalendar();       // recomputes `today`; also refreshes _calendarRenderedDay
}

// The "when" on an Upcoming chip is an ANSWER, not a timestamp. Two reasons it
// is not the absolute date it used to be.
//
// The section is called Upcoming, so what a glance wants is how far off the
// event is; "Aug 18, 08:00 AM" makes the reader do that subtraction themselves.
// And the chip is a grid (`auto 1fr auto`, CalendarView.css) in which the name
// is the ONLY flexible cell, so a nowrap absolute date took ~100px of a ~155px
// chip and every title rendered as "K…" — the name, which is the information,
// was the one thing being sacrificed (reported on Discord, Aug 2026).
//
// The unit comes from Intl.NumberFormat's narrow UNIT style, not from
// RelativeTimeFormat: the latter's narrow form is only short in some locales
// ("in 2d" in en-US, but "in 2 days" in en-GB and "in 2 Tagen" in German), which
// would have left the same squeeze in place for most of the 11 languages. The
// unit style is 2-6 characters everywhere, and needs no new strings.
//
// Pure and self-contained on purpose: test/calendar-upcoming.test.mjs evaluates
// this very function out of the source.
// Until when an event still counts as current.
//
// A timed event with an end stays current until that end: a 17:00-23:00 event is
// still on the list at 19:00 (reported on Discord, Oct 2026 — it vanished an hour
// or two in). One with no usable end is its own start, as before. A WHOLE-DAY
// event is not a thing that happens at 00:00 — it
// covers the days it names, so it stays current until the end of the last one.
// Reading its 00:00 start as the moment it expires is what made today's all-day
// events disappear from the list one minute after midnight: at 9am, a day that
// had barely started was already in the past. Reported from a Mac, with Google
// Calendar events, which is where all-day events mostly come from.
//
// Local midnight on purpose: an all-day event is wall-clock, not an instant.
function eventActiveUntil(e) {
  const start = Date.parse(e && e.startsAt);
  if (!e) return start;
  if (!e.allDay) {
    // Local events store a naive local time, feed events a UTC instant; Date.parse
    // reads both correctly. An end before the start is bad data, not a reason to
    // keep the event around.
    const end = Date.parse(e.endsAt);
    return Number.isFinite(end) && end > start ? end : start;
  }
  // endsAt names the LAST day the event covers (ics-feeds.js already turns RFC
  // 5545's exclusive DTEND into an inclusive one); a single-day event has none
  // to speak of, so its start day is its end day.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(e.endsAt || e.startsAt));
  if (!m) return start;
  return new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999).getTime();
}
