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
      // The chosen one of each column is the Tab stop: Tab goes hour, then minutes.
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(i === selectedVal));
      item.tabIndex = i === selectedVal ? 0 : -1;
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

  // Anchor the dropdown to the trigger with position:fixed so the modal card's
  // `overflow: auto` can't clip it, clamp it to the viewport, and flip it above
  // the trigger when there isn't enough room below (the form sits near the
  // modal's bottom edge, so downward-only would overlap the Add button).
  function _positionTp() {
    const dd = $('time-picker-dropdown');
    const btn = $('time-picker-btn');
    if (!dd || !btn) return;
    const r = btn.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight, m = 8, gap = 6;
    dd.style.position = 'fixed';
    dd.style.margin = '0';
    dd.style.left = '0';
    dd.style.top = '0';
    const w = dd.offsetWidth, h = dd.offsetHeight;
    const spaceBelow = vh - r.bottom - gap - m;
    const placeBelow = h <= spaceBelow || spaceBelow >= r.top - gap - m;
    dd.style.left = Math.max(m, Math.min(r.left, vw - m - w)) + 'px';
    dd.style.top = (placeBelow ? r.bottom + gap : r.top - gap - h) + 'px';
  }

  function _labelTp() {
    $('tp-hours').setAttribute('aria-label', t('tp_hours'));
    $('tp-minutes').setAttribute('aria-label', t('deck_param_minutes'));
  }

  function _focusSelected(colId) {
    const sel = $(colId).querySelector('.tp-item.selected');
    if (sel) sel.focus({ preventScroll: true });
  }

  function toggleTimePicker() {
    _tpOpen = !_tpOpen;
    const dd = $('time-picker-dropdown');
    const btn = $('time-picker-btn');
    if (_tpOpen) {
      _rebuild();
      _labelTp();
      dd.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      _positionTp();   // measured after .open makes the dropdown displayable
      _focusSelected('tp-hours');
    } else {
      const hadFocus = dd.contains(document.activeElement);
      dd.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      if (hadFocus) btn.focus();   // a closed list must not keep the focus
    }
  }

  // The keyboard inside the list: up and down change the value (and go round), Home and
  // End jump to the ends, Enter or Space close it on the value shown. Esc is the day
  // window's: it closes the list first (dayModalEsc).
  function _tpStep(key, cur, count) {
    if (key === 'ArrowDown') return (cur + 1) % count;
    if (key === 'ArrowUp') return (cur - 1 + count) % count;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    return null;
  }

  function _onTpKey(e) {
    const item = e.target.closest && e.target.closest('.tp-item');
    if (!item) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTimePicker(); return; }
    const col = item.parentNode;
    const next = _tpStep(e.key, Number(item.dataset.val), col.children.length);
    if (next === null) return;
    e.preventDefault();
    const colId = col.id;
    col.children[next].click();   // the same path as a tap
    _focusSelected(colId);
  }

  // Tab past the minutes leaves the list: it closes behind the focus.
  function _onTpFocusOut(e) {
    const wrap = $('time-picker-wrap');
    if (!_tpOpen || !e.relatedTarget || wrap.contains(e.relatedTarget)) return;
    toggleTimePicker();
  }

  const _tpDropdown = $('time-picker-dropdown');
  if (_tpDropdown) {
    _tpDropdown.addEventListener('keydown', _onTpKey);
    _tpDropdown.addEventListener('focusout', _onTpFocusOut);
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

function renderCalendar() {
  // Render into every calendar instance (primary widget + clones).
  // Each instance has a .calendar-card ancestor scoping its month/weekdays/days.
  document.querySelectorAll('[data-calf="days"]').forEach(daysEl => {
    const card = daysEl.closest('.calendar-card');
    const monthEl = card ? card.querySelector('[data-calf="month"]') : null;
    const weekdaysEl = card ? card.querySelector('[data-calf="weekdays"]') : null;
    _buildCalendarInto(monthEl, weekdaysEl, daysEl);
  });

  _calendarRenderedDay = toDateInputValue(new Date());
  renderUpcoming();
}

// Re-render when the local calendar day rolls over — e.g. the dashboard is left
// open past midnight. The `today` highlight is computed only at render time, so
// without this it stays pinned to the day the grid was last drawn until the user
// taps a cell (which was the reported workaround, and also left a stray `selected`
// cell behind). Cheap: a string compare on each clock tick, a full render only on
// the once-a-day rollover.
let _calendarRenderedDay = toDateInputValue(new Date());

// Feed reminders used to be remembered here; the server keeps them now.
try { localStorage.removeItem('xeneonedge.extReminders.notified'); } catch { }
