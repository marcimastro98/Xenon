// What the assistant does when asked about timers and stopwatches: start, pause, resume, list,
// delete.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

const { TIMERS_MAX, _getTimerElapsed, _getTimerRemaining } = require('./timer-values.js');
const { _normalizeTimer } = require('./timer-normalize.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const TimerActions = require('../timer-actions.js');

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'start_timer': async ({ fnArgs, clientActions }, { _saveTimers, timerState }) => {
      let fnResult;
      const stopwatch = fnArgs.kind === 'stopwatch';
      const durSecs = Math.max(1, Math.round(Number(fnArgs.duration_secs) || 60));
      const timerLabel = String(fnArgs.label || (stopwatch ? 'Stopwatch' : 'Timer')).trim().slice(0, 40);
      if (timerState.list.length >= TIMERS_MAX) {
        fnResult = { error: 'Too many timers active' };
      } else if (stopwatch) {
        const newTimer = _normalizeTimer({ label: timerLabel, kind: 'stopwatch', intervalSecs: Number(fnArgs.chime_every_secs) || 0, status: 'running', startedAt: Date.now(), pausedElapsed: 0 });
        timerState.list.push(newTimer);
        await _saveTimers();
        clientActions.push({ action: 'refresh_timers', args: {} });
        broadcastSSE('timer_update', { timers: timerState.list });
        fnResult = { ok: true, id: newTimer.id, label: timerLabel, kind: 'stopwatch', ...(newTimer.intervalSecs ? { chimes_every_secs: newTimer.intervalSecs } : {}) };
      } else {
        const newTimer = _normalizeTimer({ label: timerLabel, durationSecs: durSecs, status: 'running', startedAt: Date.now(), pausedElapsed: 0 });
        timerState.list.push(newTimer);
        await _saveTimers();
        clientActions.push({ action: 'refresh_timers', args: {} });
        broadcastSSE('timer_update', { timers: timerState.list });
        const mins = Math.floor(durSecs / 60), secs = durSecs % 60;
        const durationLabel = mins > 0 ? (secs > 0 ? `${mins}m ${secs}s` : `${mins} min`) : `${secs}s`;
        fnResult = { ok: true, id: newTimer.id, label: timerLabel, duration: durationLabel };
      }
      return fnResult;
  },

  'control_timer': async ({ fnArgs, clientActions }, { _saveTimers, timerState }) => {
      let fnResult;
      const action = String(fnArgs.action || '').trim().toLowerCase();
      const found = TimerActions.ACTIONS.includes(action) ? TimerActions.findTimer(timerState.list, fnArgs.timer, action) : null;
      const next = found && TimerActions.applyTimerAction(found, action, Date.now());
      if (!TimerActions.ACTIONS.includes(action)) {
        fnResult = { ok: false, error: 'bad_action', actions: TimerActions.ACTIONS };
      } else if (!found) {
        fnResult = { ok: false, error: timerState.list.length ? 'which_timer' : 'no_timers', timers: timerState.list.map(t => ({ label: t.label, status: t.status })) };
      } else if (!next) {
        fnResult = { ok: true, label: found.label, status: found.status, unchanged: true };
      } else {
        timerState.list = timerState.list.map(t => (t.id === next.id ? next : t));
        await _saveTimers();
        clientActions.push({ action: 'refresh_timers', args: {} });
        broadcastSSE('timer_update', { timers: timerState.list });
        fnResult = { ok: true, label: next.label, status: next.status };
      }
      return fnResult;
  },

  'list_timers': async (_context, { timerState }) => {
      let fnResult;
      fnResult = {
        // A stopwatch has no remaining time, and reporting Infinity to a model
        // is worse than reporting nothing: it says elapsed instead, which is
        // the only reading it has.
        timers: timerState.list.map(t => (t.kind === 'stopwatch'
          ? { id: t.id, label: t.label, status: t.status, kind: 'stopwatch',
              elapsed_secs: Math.floor(_getTimerElapsed(t)),
              ...(t.intervalSecs > 0 ? { chimes_every_secs: t.intervalSecs } : {}) }
          : { id: t.id, label: t.label, status: t.status, kind: 'countdown',
              remaining_secs: Math.ceil(_getTimerRemaining(t)),
              duration_secs: t.durationSecs })),
      };
      return fnResult;
  },

  'delete_timer': async ({ fnArgs, clientActions }, { _saveTimers, timerState }) => {
      let fnResult;
      const delId = String(fnArgs.id || '').trim();
      const before = timerState.list.length;
      timerState.list = timerState.list.filter(t => t.id !== delId);
      if (timerState.list.length < before) {
        await _saveTimers();
        clientActions.push({ action: 'refresh_timers', args: {} });
        broadcastSSE('timer_update', { timers: timerState.list });
        fnResult = { ok: true };
      } else {
        fnResult = { error: 'timer not found' };
      }
      return fnResult;
  },
};

module.exports = { branches };
