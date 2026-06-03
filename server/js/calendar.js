'use strict';

/* ── Custom time picker ─────────────────────────────────────── */
(function initTimePicker() {
  let _tpOpen = false;

  function _pad(n) { return String(n).padStart(2, '0'); }

  function _getSelectedTime() {
    return $('event-time').value || '09:00';
  }

  function _setTime(hh, mm) {
    const val = `${_pad(hh)}:${_pad(mm)}`;
    $('event-time').value = val;
    $('time-picker-label').textContent = val;
  }

  function _buildCol(containerId, count, start, selectedVal, onSelect) {
    const col = $(containerId);
    col.innerHTML = '';
    for (let i = start; i < start + count; i++) {
      const item = document.createElement('div');
      item.className = 'tp-item' + (i === selectedVal ? ' selected' : '');
      item.textContent = _pad(i);
      item.dataset.val = i;
      item.addEventListener('click', function () {
        onSelect(i);
      });
      col.appendChild(item);
    }
    // scroll selected item to top
    const sel = col.querySelector('.tp-item.selected');
    if (sel) col.scrollTop = sel.offsetTop;
  }

  function _rebuild() {
    const parts = _getSelectedTime().split(':');
    const hh = parseInt(parts[0], 10) || 0;
    const mm = parseInt(parts[1], 10) || 0;

    _buildCol('tp-hours', 24, 0, hh, function (h) {
      const cur = _getSelectedTime().split(':');
      _setTime(h, parseInt(cur[1], 10) || 0);
      _rebuild();
    });

    _buildCol('tp-minutes', 60, 0, mm, function (m) {
      const cur = _getSelectedTime().split(':');
      _setTime(parseInt(cur[0], 10) || 0, m);
      _rebuild();
    });
  }

  function toggleTimePicker() {
    _tpOpen = !_tpOpen;
    const dd = $('time-picker-dropdown');
    const btn = $('time-picker-btn');
    if (_tpOpen) {
      _rebuild();
      dd.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    } else {
      dd.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
  }

  // close on outside click
  document.addEventListener('click', function (e) {
    if (!_tpOpen) return;
    const wrap = $('time-picker-wrap');
    if (wrap && !wrap.contains(e.target)) {
      _tpOpen = false;
      $('time-picker-dropdown').classList.remove('open');
      $('time-picker-btn').setAttribute('aria-expanded', 'false');
    }
  }, true);

  // expose globally so onclick in HTML works
  window.toggleTimePicker = toggleTimePicker;

  // init label on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      const lbl = $('time-picker-label');
      if (lbl) lbl.textContent = _getSelectedTime();
    });
  }
})();
/* ── End custom time picker ─────────────────────────────────── */

function showCalendar() {
  // Agenda (calendar/tasks/timer) is now its own always-visible Bento widget.
  // The legacy media↔calendar toggle on the media panel is retired: the
  // calendar is always rendered in the agenda panel. Arguments are ignored
  // (kept so existing call sites stay safe).
  calendarMode = true;
  renderCalendar();
  updateCalendarMiniPlayer();
  if (!showCalendar._notifAsked && 'Notification' in window && Notification.permission === 'default') {
    showCalendar._notifAsked = true;
    try { Promise.resolve(Notification.requestPermission()).catch(() => {}); } catch {}
  }
}

function eventsForDate(dateValue) {
  return calendarEvents
    .filter(event => String(event.startsAt || '').slice(0, 10) === dateValue)
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
}

function _buildCalendarInto(monthEl, weekdaysEl, daysEl) {
  const locale = t('locale');
  const monthLabel = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(calendarViewDate);
  if (monthEl) monthEl.textContent = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);

  if (weekdaysEl) {
    weekdaysEl.innerHTML = '';
    t('weekdays').forEach(day => {
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
  const offset = (first.getDay() + 6) % 7;
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
    if (eventsForDate(dateValue).length) cell.classList.add('has-events');
    cell.textContent = day;
    cell.onclick = () => openDayModal(dateValue);
    daysEl.appendChild(cell);
  }
}

function renderCalendar() {
  // Render into every calendar instance (primary widget + clones).
  // Each instance has a .calendar-card ancestor scoping its month/weekdays/days.
  document.querySelectorAll('[data-calf="days"]').forEach(daysEl => {
    const card = daysEl.closest('.calendar-card');
    const monthEl = card ? card.querySelector('[data-calf="month"]') : null;
    const weekdaysEl = card ? card.querySelector('[data-calf="weekdays"]') : null;
    _buildCalendarInto(monthEl, weekdaysEl, daysEl);
  });

  renderUpcoming();
}

function _buildUpcomingInto(list) {
  const now = Date.now();
  const upcoming = calendarEvents
    .filter(e => Date.parse(e.startsAt) >= now - 60000)
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))
    .slice(0, 5);
  list.innerHTML = '';
  if (!upcoming.length) {
    const empty = document.createElement('div');
    empty.className = 'event-empty';
    empty.textContent = t('no_upcoming');
    list.appendChild(empty);
    return;
  }
  const fmt = new Intl.DateTimeFormat(t('locale'), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  upcoming.forEach(e => {
    const item = document.createElement('div');
    item.className = 'upcoming-item';
    item.style.cursor = 'pointer';
    item.onclick = () => openDayModal(String(e.startsAt).slice(0, 10));
    const dot = document.createElement('span');
    dot.className = 'upcoming-dot';
    const name = document.createElement('span');
    name.className = 'upcoming-name';
    name.textContent = e.title || t('ph_title');
    const when = document.createElement('span');
    when.className = 'upcoming-when';
    when.textContent = fmt.format(new Date(e.startsAt));
    item.appendChild(dot);
    item.appendChild(name);
    item.appendChild(when);
    list.appendChild(item);
  });
}

function renderUpcoming() {
  document.querySelectorAll('[data-calf="upcoming-list"]').forEach(list => _buildUpcomingInto(list));
}

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
  $('day-modal').classList.add('open');
  setTimeout(() => $('event-title').focus(), 80);
  if (calendarMode) renderCalendar();
}

function closeDayModal() {
  $('day-modal').classList.remove('open');
  modalDateValue = null;
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
  const fmt = new Intl.DateTimeFormat(t('locale'), { hour: '2-digit', minute: '2-digit' });
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
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'event-delete';
    del.title = t('delete_event');
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    del.onclick = () => deleteCalendarEvent(event.id);
    top.appendChild(name);
    top.appendChild(time);
    top.appendChild(del);
    item.appendChild(top);
    if (event.notes) {
      const meta = document.createElement('div');
      meta.className = 'event-meta';
      meta.textContent = event.notes;
      item.appendChild(meta);
    }
    list.appendChild(item);
  });
}

function selectCalendarDate(dateValue) {
  selectedCalendarDate = dateValue;
  renderCalendar();
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

async function loadCalendarEvents() {
  try {
    const res = await fetch(SERVER + '/events');
    if (!res.ok) throw new Error('events unavailable');
    const data = await res.json();
    calendarEvents = Array.isArray(data.events) ? data.events : [];
    calendarLoaded = true;
    if (calendarMode) renderCalendar();
    renderUpcoming();
  } catch {
    calendarLoaded = true;
    calendarEvents = [];
    if (calendarMode) renderCalendar();
    renderUpcoming();
  }
}

async function persistCalendarEvents() {
  await fetch(SERVER + '/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: calendarEvents }),
  });
}

async function saveCalendarEvent() {
  const title = $('event-title').value.trim();
  const dateValue = modalDateValue || selectedCalendarDate;
  const starts = combineDateTime(dateValue, $('event-time').value);
  if (!title || !starts) return;
  const reminderMinutes = Number($('event-reminder').value);
  const reminderAt = reminderMinutes >= 0 ? toLocalDateTimeValue(new Date(starts.getTime() - reminderMinutes * 60000)) : '';
  calendarEvents.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title,
    notes: $('event-notes').value.trim(),
    startsAt: toLocalDateTimeValue(starts),
    reminderAt,
    notifiedAt: '',
    createdAt: toLocalDateTimeValue(new Date()),
  });
  $('event-title').value = '';
  $('event-notes').value = '';
  selectedCalendarDate = dateValue;
  calendarViewDate = new Date(starts.getFullYear(), starts.getMonth(), 1);
  await persistCalendarEvents().catch(() => {});
  if (calendarMode) renderCalendar();
  renderDayModalEvents();
  renderUpcoming();
  if ('Notification' in window && Notification.permission === 'default') {
    try { Promise.resolve(Notification.requestPermission()).catch(() => {}); } catch {}
  }
}

async function deleteCalendarEvent(id) {
  calendarEvents = calendarEvents.filter(event => event.id !== id);
  await persistCalendarEvents().catch(() => {});
  if (calendarMode) renderCalendar();
  if ($('day-modal').classList.contains('open')) renderDayModalEvents();
  renderUpcoming();
}

function showReminder(event) {
  const fmt = new Intl.DateTimeFormat(t('locale'), { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const meta = fmt.format(new Date(event.startsAt));
  const toast = $('event-toast');
  $('toast-kicker').textContent = t('reminder');
  $('toast-title').textContent = event.title || t('ph_title');
  $('toast-meta').textContent = meta;
  toast.classList.remove('show');
  void toast.offsetWidth;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(dismissReminderToast, 14000);
  playReminderSound();
  if (window.lightingNotify) window.lightingNotify('reminder');
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(t('desktop_title'), { body: `${event.title || t('ph_title')} - ${meta}`, silent: false, requireInteraction: true });
    } catch { }
  }
}

async function checkReminders() {
  if (!calendarLoaded || !calendarEvents.length) return;
  const now = Date.now();
  let changed = false;
  calendarEvents.forEach(event => {
    if (!event.reminderAt || event.notifiedAt) return;
    const reminderTime = Date.parse(event.reminderAt);
    if (Number.isFinite(reminderTime) && reminderTime <= now) {
      event.notifiedAt = new Date().toISOString();
      changed = true;
      showReminder(event);
    }
  });
  if (changed) await persistCalendarEvents().catch(() => {});
}
