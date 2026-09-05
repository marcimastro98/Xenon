'use strict';

// ── Timer module ──────────────────────────────────────────────────
// Countdown timers: create, pause, resume, reset, delete.
// Server stores state; client renders and ticks locally for smooth display.
// AI can create/list/delete timers via function calling (start_timer, list_timers,
// delete_timer → triggers 'refresh_timers' clientAction).

let _timerState = [];          // local mirror of server timer list
let _timerTickId = null;       // rAF loop id

// ── API helpers ──────────────────────────────────────────────────

function loadTimers() {
  fetch('/api/timers')
    .then(r => r.json())
    .then(({ timers }) => {
      _timerState = timers || [];
      renderTimers();
      _startTimerTick();
    })
    .catch(() => {});
}

function _hasRunningTimer() { return _timerState.some(t => t && t.status === 'running'); }

function _startTimerTick() {
  if (_timerTickId !== null) return;
  if (!_hasRunningTimer()) return;   // nothing counting down → don't spin a rAF loop
  let lastSec = -1;
  const tick = () => {
    // Self-stop when no timer is running (paused/done/empty): the previous version
    // ran a rAF callback every frame forever once loadTimers fired, even with zero
    // timers. renderTimers() restarts the loop when a timer becomes active again.
    if (!_hasRunningTimer()) { _timerTickId = null; return; }
    _timerTickId = requestAnimationFrame(tick);
    const nowSec = Math.floor(Date.now() / 250); // ~4 fps, enough for smooth M:SS
    if (nowSec === lastSec) return;
    lastSec = nowSec;
    _updateTimerDisplays();
  };
  _timerTickId = requestAnimationFrame(tick);
}

// Two kinds, one set of controls. A countdown has a duration and ends; a
// STOPWATCH counts up and does not. Pause, resume, reset and stop are shared
// because the underlying clock is: both accumulate pausedElapsed the same way.
const _isStopwatch = (t) => t && t.kind === 'stopwatch';

function _getElapsed(t) {
  if (t.status === 'running') return (t.pausedElapsed || 0) + (Date.now() - t.startedAt) / 1000;
  return t.pausedElapsed || 0;
}

function _getRemaining(t) {
  if (t.status === 'done')   return 0;
  if (t.status === 'paused') return Math.max(0, t.durationSecs - (t.pausedElapsed || 0));
  const elapsed = (t.pausedElapsed || 0) + (Date.now() - t.startedAt) / 1000;
  return Math.max(0, t.durationSecs - elapsed);
}

/** What the card SHOWS: time left on a countdown, time spent on a stopwatch. */
function _getReading(t) {
  return _isStopwatch(t) ? _getElapsed(t) : _getRemaining(t);
}

// A countdown rounds UP, so a timer with 0.4s left still reads 0:01 and never
// shows 0:00 while it is still running. A stopwatch rounds DOWN, or it would
// read 0:01 the instant it was started.
function _formatTime(secs, roundDown) {
  const s = roundDown ? Math.floor(Math.max(0, secs)) : Math.ceil(Math.max(0, secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

function _escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Display update (called every ~250 ms) ───────────────────────

function _updateTimerDisplays() {
  let needDone = false;
  _timerState.forEach(timer => {
    if (timer.status !== 'running') return;
    const sw = _isStopwatch(timer);
    const reading = _getReading(timer);
    // Use data-timer-time / data-timer-arc so updates reach all instances
    // (clones have their IDs stripped by stripCloneFor, but data attrs survive).
    document.querySelectorAll(`[data-timer-time="${timer.id}"]`).forEach(el => {
      el.textContent = _formatTime(reading, sw);
    });
    const r = 20, circ = 2 * Math.PI * r;
    document.querySelectorAll(`[data-timer-arc="${timer.id}"]`).forEach(arc => {
      // A stopwatch has no end to draw a fraction of, so its ring sweeps once a
      // minute: a moving second hand rather than a progress bar with no total.
      const pct = sw ? (1 - (reading % 60) / 60) : (1 - (reading / timer.durationSecs));
      arc.style.strokeDashoffset = String(circ * pct);
    });
    if (!sw && reading <= 0 && timer.status === 'running') needDone = true;
  });
  if (needDone) loadTimers(); // server already set status='done'; reload to sync
}

// ── Render ──────────────────────────────────────────────────────

function _buildTimerCard(timer) {
  const sw   = _isStopwatch(timer);
  const rem  = _getReading(timer);
  const r    = 20;
  const circ = 2 * Math.PI * r;
  const pct  = sw ? (rem % 60) / 60 : (timer.status === 'done' ? 0 : Math.max(0, rem / timer.durationSecs));
  const offset = circ * (1 - pct);
  const isDone   = timer.status === 'done';
  const isPaused = timer.status === 'paused';

  const pauseTip  = (typeof t === 'function' ? t('timer_pause')  : null) || 'Pause';
  const resumeTip = (typeof t === 'function' ? t('timer_resume') : null) || 'Resume';
  const resetTip  = (typeof t === 'function' ? t('timer_reset')  : null) || 'Restart';
  const stopTip   = (typeof t === 'function' ? t('timer_stop')   : null) || 'Stop and keep';
  const delTip    = (typeof t === 'function' ? t('timer_delete') : null) || 'Delete';

  const card = document.createElement('div');
  card.className = `timer-card${isDone ? ' timer-done' : ''}${isPaused ? ' timer-paused' : ''}`;
  // Keep id for primary (stripped from clones by stripCloneFor); data-timer-id
  // is the durable hook used by _updateTimerDisplays across all instances.
  card.id = `timer-card-${timer.id}`;
  card.dataset.timerId = timer.id;

  const tid = _escHtml(timer.id);

  const SVG_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z"/></svg>';
  const SVG_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const SVG_RESTART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.6-6.3"/><path d="M3 4v5h5"/></svg>';
  const SVG_DELETE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  const SVG_STOP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2.2"/></svg>';
  // Stopped, the two kinds are the same card: a name and a time. Moving, the
  // ring tells them apart (one drains, one sweeps), but a paused stopwatch
  // reading 0:34 beside a paused countdown reading 0:34 is genuinely ambiguous.
  // One small mark before the name, and only on the kind that needs explaining.
  // A chiming stopwatch has to say so on its face: the difference between one
  // that will interrupt you every 30 minutes and one that will not is the whole
  // reason somebody set it, and it is invisible otherwise.
  const every = sw && timer.intervalSecs > 0 ? timer.intervalSecs : 0;
  const everyText = every
    ? ((typeof t === 'function' ? t('timer_every') : '') || 'every {n}').replace('{n}', _formatTime(every, true))
    : '';
  const everyMark = every ? `<span class="timer-every">${_escHtml(everyText)}</span>` : '';
  const swMark = sw
    ? `<svg class="timer-kind-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><title>${_escHtml((typeof t === 'function' ? t('timer_stopwatch') : '') || 'Stopwatch')}</title><circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V9M9.5 2.5h5"/></svg>`
    : '';

  let actionBtn = '';
  if (!isDone) {
    if (timer.status === 'running') {
      actionBtn = `<button class="timer-btn timer-pause-btn" onclick="timerPause('${tid}')" title="${pauseTip}">${SVG_PAUSE}</button>`;
    } else {
      actionBtn = `<button class="timer-btn timer-resume-btn" onclick="timerResume('${tid}')" title="${resumeTip}">${SVG_PLAY}</button>`;
    }
  }
  // Stop is offered only where it would change something: never on a finished
  // timer, and never on one already sitting at its full time, where it would be
  // a fourth button that does nothing. A running timer always qualifies, whatever
  // its elapsed reads, because stopping it is the point.
  const atFull = timer.status !== 'running' && (timer.pausedElapsed || 0) < 1;
  const stopBtn = (!isDone && !atFull)
    ? `<button class="timer-btn timer-stop-btn" onclick="timerStop('${tid}')" title="${stopTip}">${SVG_STOP}</button>`
    : '';
  const resetBtn  = `<button class="timer-btn timer-restart-btn" onclick="timerRestart('${tid}')" title="${resetTip}">${SVG_RESTART}</button>`;
  const deleteBtn = `<button class="timer-btn timer-delete-btn" onclick="timerDelete('${tid}')" title="${delTip}">${SVG_DELETE}</button>`;

  // Use data-timer-arc / data-timer-time so _updateTimerDisplays reaches these
  // elements across all instances (ids get stripped from clones).
  card.innerHTML = `
    <div class="timer-ring">
      <svg viewBox="0 0 48 48">
        <circle class="timer-circle-bg" cx="24" cy="24" r="${r}"/>
        <circle class="timer-circle-arc" id="timer-arc-${tid}" data-timer-arc="${tid}" cx="24" cy="24" r="${r}"
          stroke-dasharray="${circ.toFixed(2)}"
          stroke-dashoffset="${offset.toFixed(2)}"
          transform="rotate(-90 24 24)"/>
      </svg>
    </div>
    <div class="timer-info">
      <div class="timer-label">${swMark}${_escHtml(timer.label)}${everyMark}</div>
      <div class="timer-time" id="timer-time-${tid}" data-timer-time="${tid}">${isDone ? '0:00' : _formatTime(rem, sw)}</div>
    </div>
    <div class="timer-actions">
      ${actionBtn}
      ${stopBtn}
      ${resetBtn}
      ${deleteBtn}
    </div>`;

  return card;
}

function renderTimers() {
  // Render into every timer instance (primary widget + clones).
  document.querySelectorAll('[data-timerf="list"]').forEach(list => {
    list.innerHTML = '';

    if (_timerState.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'timer-empty';
      empty.textContent = (typeof t === 'function' ? t('timer_empty') : null) || 'No timers. Add one!';
      list.appendChild(empty);
      return;
    }

    _timerState.forEach(timer => list.appendChild(_buildTimerCard(timer)));
  });
  _startTimerTick();   // (re)start the display loop if any timer is now running
}

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
  fetch('/api/chime', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'wake' }),
  }).catch(() => {});
  if (!window.XenonToast) return;
  const msg = ((typeof t === 'function' ? t('timer_chime_alert') : '') || 'every {n}')
    .replace('{n}', _formatTime(Number(every) || 0, true));
  window.XenonToast.show({
    type: 'timer',
    kicker: (typeof t === 'function' ? t('timer_title') : '') || 'Timer',
    title: label || 'Stopwatch',
    message: msg,
  });
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
  const msg = (typeof t === 'function' ? t('timer_done_alert') : null) || "Time's up!";
  if (window.XenonToast) {
    window.XenonToast.show({
      type: 'timer',
      kicker: (typeof t === 'function' ? t('timer_title') : '') || 'Timer',
      title: label || 'Timer',
      message: msg,
    });
  }
}

// Enter key in duration input
function onTimerInputKeydown(e) {
  if (e.key === 'Enter') { e.preventDefault(); addTimerFromInput(); }
}
