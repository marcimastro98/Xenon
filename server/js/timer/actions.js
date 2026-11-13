// Adding a timer from the box, pause, resume, restart, stop and delete, and what happens when a
// timer rings.
'use strict';

// ── User actions ─────────────────────────────────────────────────

function addTimerFromInput() {
  const labelEl = document.getElementById('timer-label-input');
  const durEl   = document.getElementById('timer-duration-input');
  if (!durEl) return;

  // An EMPTY duration field means a stopwatch. That is the whole gesture for
  // creating one: this tile is small and already carries two fields, an add
  // button and up to five cards, and a second button to say "count up instead"
  // would cost more room than the feature is worth. Typed-but-unparseable still
  // shakes, because that is a mistake rather than a choice.
  const typed = durEl.value.trim();
  // One more character on a grammar that already exists. The field takes 5,
  // 5:30 and 1:05:00; a LEADING + means "count up and chime every this". So:
  //   (empty) → a silent stopwatch      5 → a five minute countdown
  //   +5      → a stopwatch that chimes every five minutes
  // Asked for on Discord as an "interval timer" for stretching breaks. It is
  // not a third kind of clock, it is the stopwatch with an alarm on the way,
  // which is why it costs a character rather than a control.
  const everyMode = typed.startsWith('+');
  const body = everyMode ? typed.slice(1).trim() : typed;
  const durationSecs = _parseTimerDuration(body);
  const stopwatch = everyMode || body === '';
  const intervalSecs = everyMode ? durationSecs : 0;
  // A bare "+" says count up and chime every nothing, which is not a thing.
  if (everyMode && (!intervalSecs || intervalSecs < 1)) {
    durEl.classList.add('timer-input-error');
    setTimeout(() => durEl.classList.remove('timer-input-error'), 1200);
    return;
  }
  if (!stopwatch && (!durationSecs || durationSecs < 1)) {
    durEl.classList.add('timer-input-error');
    setTimeout(() => durEl.classList.remove('timer-input-error'), 1200);
    return;
  }

  const fallback = stopwatch
    ? ((typeof t === 'function' ? t('timer_stopwatch') : '') || 'Stopwatch')
    : 'Timer';
  const label = ((labelEl?.value || '').trim() || fallback).slice(0, 40);

  // Clear inputs immediately — state sync happens via SSE timer_update broadcast,
  // which the server fires right after creating the timer.  Adding the timer to
  // _timerState here too would cause a duplicate (SSE can arrive before the HTTP
  // response because it uses a persistent connection with no header overhead).
  if (labelEl) labelEl.value = '';
  if (durEl)   durEl.value   = '';

  fetch('/api/timers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stopwatch
      ? { label, kind: 'stopwatch', interval_secs: intervalSecs }
      : { label, duration_secs: durationSecs }),
  })
    .then(r => r.json())
    .then(({ timer, error }) => {
      if (error) {
        // Max timers reached or other server error — show shake feedback
        if (durEl) {
          durEl.classList.add('timer-input-error');
          setTimeout(() => durEl.classList.remove('timer-input-error'), 1200);
        }
      }
      // On success the SSE timer_update will update _timerState and re-render.
    })
    .catch(() => {});
}

function _parseTimerDuration(str) {
  // Accepts: 5  (minutes), 5:00 (min:sec), 1:30:00 (h:min:sec)
  if (!str) return 0;
  const parts = str.split(':').map(s => Number(s.trim()));
  if (parts.some(isNaN)) return 0;
  if (parts.length === 1) return Math.max(0, Math.round(parts[0] * 60));
  if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
  if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  return 0;
}

function timerPause(id) {
  _patchTimer(id, 'pause');
}
function timerResume(id) {
  _patchTimer(id, 'resume');
}
function timerRestart(id) {
  _patchTimer(id, 'reset');
}
// Back to full time and held there, so the timer is kept for later instead of
// being parked half-spent. See the 'stop' action in server.js.
function timerStop(id) {
  _patchTimer(id, 'stop');
}
function timerDelete(id) {
  fetch(`/api/timers/${encodeURIComponent(id)}`, { method: 'DELETE' })
    .then(() => {
      _timerState = _timerState.filter(t => t.id !== id);
      renderTimers();
    })
    .catch(() => {});
}

function _patchTimer(id, action) {
  fetch(`/api/timers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
    .then(r => r.json())
    .then(({ timer }) => {
      if (!timer) return;
      const idx = _timerState.findIndex(t => t.id === id);
      if (idx >= 0) _timerState[idx] = timer;
      renderTimers();
    })
    .catch(() => {});
}

// ── SSE callbacks (called from main.js) ─────────────────────────

// A stopwatch reaching one of its intervals. NOT timer_done: nothing finished,
// the clock keeps running, and marking it done would stop the thing the person
// asked to keep going.
function onTimerChime(id, label, every) {
  if (typeof isLayerPage === 'function' && isLayerPage()) return;   // the main dashboard chimes; a second chime would double it
  fetch('/api/chime', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'wake' }),
  }).catch(() => {});
  if (!window.XenonToast || !window.AlertToasts) return;
  window.XenonToast.show(window.AlertToasts.timerChime(label, every, { t }));
}

function onTimerUpdate(timers) {
  _timerState = timers || [];
  renderTimers();
  _startTimerTick();
}

function onTimerDone(id, label) {
  const t = _timerState.find(t => t.id === id);
  if (t) t.status = 'done';
  renderTimers();
  if (typeof isLayerPage === 'function' && isLayerPage()) return;   // the tile updates here; the chime and toast come from the main dashboard
  // Play chime
  fetch('/api/chime', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'wake' }),
  }).catch(() => {});
  // Toast notification
  _showTimerDoneToast(label || 'Timer');
}

function _showTimerDoneToast(label) {
  if (window.XenonToast && window.AlertToasts) window.XenonToast.show(window.AlertToasts.timerDone(label, { t }));
}

// Enter key in duration input
function onTimerInputKeydown(e) {
  if (e.key === 'Enter') { e.preventDefault(); addTimerFromInput(); }
  // Escape folds the row away without losing what was typed — the same gesture
  // that closes every other transient thing on the dashboard.
  if (e.key === 'Escape') { e.preventDefault(); setTimerAddCollapsed(true); }
}

// ── Collapsing the add row ───────────────────────────────────────
// The add row and its format hint are used once per timer and then sit there.
// Asked for from a Xeneon Edge, where the widget is wide and short and that band
// is a third of it. Collapsed, the section is a slim "+ New timer" strip: the
// way to add one is folded away, never hidden.
//
// There is exactly one add row on the dashboard — a Timer copy is cloned without
// it (stripTimerClone in dashboard-layout.js) — so this is one flag, not one per
// instance, and it rides on dashboardLayout beside topbarHidden.
function _timerAddSection() { return document.querySelector('[data-timerf="add-section"]'); }

function isTimerAddCollapsed() {
  if (typeof getDashboardLayout !== 'function') return false;
  return getDashboardLayout().timerAddCollapsed === true;
}

// Paint the saved state. Called on load, and again by the settings apply pass so
// a change made on another surface lands here too.
function applyTimerAddCollapsed() {
  const section = _timerAddSection();
  if (!section) return;
  section.dataset.collapsed = isTimerAddCollapsed() ? 'true' : 'false';
  const strip = section.querySelector('[data-timerf="add-strip"]');
  if (strip) strip.setAttribute('aria-expanded', section.dataset.collapsed === 'true' ? 'false' : 'true');
}

function setTimerAddCollapsed(collapsed) {
  const want = collapsed === true;
  const section = _timerAddSection();
  if (section) {
    section.dataset.collapsed = want ? 'true' : 'false';
    const strip = section.querySelector('[data-timerf="add-strip"]');
    if (strip) strip.setAttribute('aria-expanded', want ? 'false' : 'true');
    // Opening from the strip should land ready to type: the strip is the thing
    // that was just tapped, so the caret has to be moved deliberately.
    if (!want) {
      const labelEl = section.querySelector('.timer-add-label-input');
      if (labelEl) setTimeout(() => labelEl.focus(), 0);
    } else if (section.contains(document.activeElement)) {
      // Collapsing while a field has focus would leave the caret in a box that
      // is no longer on screen (and keep the on-screen keyboard up on a touch
      // panel), so hand focus back to the strip.
      document.activeElement.blur();
    }
  }
  if (typeof saveDashboardLayout === 'function' && typeof getDashboardLayout === 'function') {
    saveDashboardLayout({ ...getDashboardLayout(), timerAddCollapsed: want }, { status: false });
  }
}
