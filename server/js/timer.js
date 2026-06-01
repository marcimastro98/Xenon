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

function _startTimerTick() {
  if (_timerTickId !== null) return;
  let lastSec = -1;
  const tick = () => {
    _timerTickId = requestAnimationFrame(tick);
    const nowSec = Math.floor(Date.now() / 250); // ~4 fps, enough for smooth M:SS
    if (nowSec === lastSec) return;
    lastSec = nowSec;
    _updateTimerDisplays();
  };
  _timerTickId = requestAnimationFrame(tick);
}

function _getRemaining(t) {
  if (t.status === 'done')   return 0;
  if (t.status === 'paused') return Math.max(0, t.durationSecs - (t.pausedElapsed || 0));
  const elapsed = (t.pausedElapsed || 0) + (Date.now() - t.startedAt) / 1000;
  return Math.max(0, t.durationSecs - elapsed);
}

function _formatTime(secs) {
  const s = Math.ceil(Math.max(0, secs));
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
    const rem = _getRemaining(timer);
    const el = document.getElementById(`timer-time-${timer.id}`);
    if (el) el.textContent = _formatTime(rem);
    const arc = document.getElementById(`timer-arc-${timer.id}`);
    if (arc) {
      const r = 20, circ = 2 * Math.PI * r;
      arc.style.strokeDashoffset = String(circ * (1 - (rem / timer.durationSecs)));
    }
    if (rem <= 0 && timer.status === 'running') needDone = true;
  });
  if (needDone) loadTimers(); // server already set status='done'; reload to sync
}

// ── Render ──────────────────────────────────────────────────────

function renderTimers() {
  const list = document.getElementById('timer-list');
  if (!list) return;
  list.innerHTML = '';

  if (_timerState.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'timer-empty';
    empty.textContent = (typeof t === 'function' ? t('timer_empty') : null) || 'No timers. Add one!';
    list.appendChild(empty);
    return;
  }

  _timerState.forEach(timer => {
    const rem  = _getRemaining(timer);
    const r    = 20;
    const circ = 2 * Math.PI * r;
    const pct  = timer.status === 'done' ? 0 : Math.max(0, rem / timer.durationSecs);
    const offset = circ * (1 - pct);
    const isDone   = timer.status === 'done';
    const isPaused = timer.status === 'paused';

    const pauseTip  = (typeof t === 'function' ? t('timer_pause')  : null) || 'Pause';
    const resumeTip = (typeof t === 'function' ? t('timer_resume') : null) || 'Resume';
    const resetTip  = (typeof t === 'function' ? t('timer_reset')  : null) || 'Restart';
    const delTip    = (typeof t === 'function' ? t('timer_delete') : null) || 'Delete';

    const card = document.createElement('div');
    card.className = `timer-card${isDone ? ' timer-done' : ''}${isPaused ? ' timer-paused' : ''}`;
    card.id = `timer-card-${timer.id}`;

    const tid = _escHtml(timer.id);

    const SVG_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z"/></svg>';
    const SVG_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
    const SVG_RESTART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.6-6.3"/><path d="M3 4v5h5"/></svg>';
    const SVG_DELETE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

    let actionBtn = '';
    if (!isDone) {
      if (timer.status === 'running') {
        actionBtn = `<button class="timer-btn timer-pause-btn" onclick="timerPause('${tid}')" title="${pauseTip}">${SVG_PAUSE}</button>`;
      } else {
        actionBtn = `<button class="timer-btn timer-resume-btn" onclick="timerResume('${tid}')" title="${resumeTip}">${SVG_PLAY}</button>`;
      }
    }
    const resetBtn  = `<button class="timer-btn timer-restart-btn" onclick="timerRestart('${tid}')" title="${resetTip}">${SVG_RESTART}</button>`;
    const deleteBtn = `<button class="timer-btn timer-delete-btn" onclick="timerDelete('${tid}')" title="${delTip}">${SVG_DELETE}</button>`;

    card.innerHTML = `
      <div class="timer-ring">
        <svg viewBox="0 0 48 48">
          <circle class="timer-circle-bg" cx="24" cy="24" r="${r}"/>
          <circle class="timer-circle-arc" id="timer-arc-${tid}" cx="24" cy="24" r="${r}"
            stroke-dasharray="${circ.toFixed(2)}"
            stroke-dashoffset="${offset.toFixed(2)}"
            transform="rotate(-90 24 24)"/>
        </svg>
      </div>
      <div class="timer-info">
        <div class="timer-label">${_escHtml(timer.label)}</div>
        <div class="timer-time" id="timer-time-${tid}">${isDone ? '0:00' : _formatTime(rem)}</div>
      </div>
      <div class="timer-actions">
        ${actionBtn}
        ${resetBtn}
        ${deleteBtn}
      </div>`;

    list.appendChild(card);
  });
}

// ── User actions ─────────────────────────────────────────────────

function addTimerFromInput() {
  const labelEl = document.getElementById('timer-label-input');
  const durEl   = document.getElementById('timer-duration-input');
  if (!durEl) return;

  const durationSecs = _parseTimerDuration(durEl.value.trim());
  if (!durationSecs || durationSecs < 1) {
    durEl.classList.add('timer-input-error');
    setTimeout(() => durEl.classList.remove('timer-input-error'), 1200);
    return;
  }

  const label = ((labelEl?.value || '').trim() || 'Timer').slice(0, 40);

  // Clear inputs immediately — state sync happens via SSE timer_update broadcast,
  // which the server fires right after creating the timer.  Adding the timer to
  // _timerState here too would cause a duplicate (SSE can arrive before the HTTP
  // response because it uses a persistent connection with no header overhead).
  if (labelEl) labelEl.value = '';
  if (durEl)   durEl.value   = '';

  fetch('/api/timers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, duration_secs: durationSecs }),
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
  const toast = document.createElement('div');
  toast.className = 'timer-done-toast';
  toast.setAttribute('role', 'alert');
  toast.setAttribute('aria-live', 'assertive');
  toast.textContent = `⏰ ${label} — ${msg}`;
  document.body.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('visible')));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 500);
  }, 4000);
}

// Enter key in duration input
function onTimerInputKeydown(e) {
  if (e.key === 'Enter') { e.preventDefault(); addTimerFromInput(); }
}
