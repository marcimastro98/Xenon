// What each server-pushed alert says in a pop-up, in one place.
//
// The dashboard (main.js, timer.js, perf-widget.js) and the on-screen alerts
// window of "Solo widget" (screen-alerts.js) show the same alerts. Both build
// the toast here, so the two can never say different things. Pure: every
// builder takes the SSE payload and a context { t, hwF } and returns the
// XenonToast.show() options, or null when there is nothing to show.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlertToasts = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // The master Notifiche switch: off, or pop-ups off, means no toast.
  function popupsAllowed(notifications) {
    const n = notifications && typeof notifications === 'object' ? notifications : null;
    return !(n && (n.enabled === false || n.popups === false));
  }

  const tr = (ctx, key, fallback) => {
    const v = ctx && typeof ctx.t === 'function' ? ctx.t(key, fallback) : '';
    return v && v !== key ? v : fallback;
  };

  function stocks(d, ctx) {
    if (!d || typeof d !== 'object') return null;
    const change = Number(d.changePct) || 0;
    const pct = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
    const arrow = d.dir === 'up' ? '▲' : '▼';
    return {
      type: 'notification',
      kicker: tr(ctx, 'stocks_alert_kicker', 'Stocks'),
      title: String(d.name || d.symbol || '') + '  ' + arrow + ' ' + pct,
      message: d.dir === 'up' ? tr(ctx, 'stocks_alert_up', 'Up sharply today') : tr(ctx, 'stocks_alert_down', 'Down sharply today'),
      duration: 6000,
    };
  }

  function football(d, ctx) {
    if (!d || typeof d !== 'object') return null;
    const score = (d.homeScore != null && d.awayScore != null)
      ? d.home + ' ' + d.homeScore + '–' + d.awayScore + ' ' + d.away
      : d.home + ' vs ' + d.away;
    return {
      type: 'notification',
      kicker: tr(ctx, 'football_alert_kicker', 'Football'),
      title: score,
      message: d.status === 'ft' ? tr(ctx, 'football_alert_ft', 'Full time') : tr(ctx, 'football_alert_goal', 'Score update'),
      duration: 6000,
    };
  }

  // Same kinds and keys as NOTIFY_KINDS in unifi-widget.js (a test keeps them equal).
  const UNIFI_KINDS = Object.freeze({
    person: 'Person', vehicle: 'Vehicle', package: 'Package', animal: 'Animal', motion: 'Motion', ring: 'Doorbell',
  });
  function unifiLabel(kind, ctx) {
    const k = String(kind || '');
    return Object.prototype.hasOwnProperty.call(UNIFI_KINDS, k) ? tr(ctx, 'unifi_kind_' + k, UNIFI_KINDS[k]) : k;
  }
  function unifi(d, ctx) {
    if (!d || typeof d !== 'object') return null;
    return {
      type: 'notification',
      kicker: tr(ctx, 'unifi_notify_kicker', 'Cameras'),
      title: unifiLabel(d.kind, ctx),
      message: d.name || d.camId || '',
      duration: 6000,
    };
  }

  function toHw(celsius, fahrenheit) {
    const c = Number(celsius);
    if (!Number.isFinite(c)) return String(celsius);
    return String(Math.round(fahrenheit ? c * 9 / 5 + 32 : c));
  }
  // The RAM alert's {v} is a percentage; only the thermal ones convert.
  function guardianText(d, ctx) {
    if (!d || typeof d !== 'object') return '';
    const key = d.type === 'gpu' ? 'guardian_alert_gpu' : d.type === 'mem' ? 'guardian_alert_mem' : 'guardian_alert_cpu';
    const text = tr(ctx, key, '');
    if (!text) return '';
    if (d.type === 'mem') return text.split('{v}').join(String(d.value));
    const f = !!(ctx && ctx.hwF);
    return text.split('{v}').join(toHw(d.value, f)).split('{u}').join(f ? 'F' : 'C');
  }
  function guardian(d, ctx) {
    const text = guardianText(d, ctx);
    return text ? { type: 'warning', kicker: 'Guardian', title: text, message: '' } : null;
  }

  // Bit's vitals popup where no PowerShell window can draw it (macOS, Linux:
  // server/vitals-nag.js). It stays as long as the server says, never past it.
  const VITALS_MAX_MS = 15000;
  function vitals(d, now = Date.now()) {
    const text = d && typeof d.text === 'string' ? d.text.trim() : '';
    const left = Number(d && d.until) - now;
    if (!text || !Number.isFinite(left) || left <= 0) return null;
    return { type: 'warning', kicker: 'Bit', title: text, message: '', duration: Math.min(left, VITALS_MAX_MS) };
  }

  function clock(secs) {
    const s = Math.floor(Math.max(0, Number(secs) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0') : m + ':' + String(sec).padStart(2, '0');
  }
  function timerDone(label, ctx) {
    return {
      type: 'timer',
      kicker: tr(ctx, 'timer_title', 'Timer'),
      title: label || 'Timer',
      message: tr(ctx, 'timer_done_alert', "Time's up!"),
    };
  }
  function timerChime(label, every, ctx) {
    return {
      type: 'timer',
      kicker: tr(ctx, 'timer_title', 'Timer'),
      title: label || 'Stopwatch',
      message: tr(ctx, 'timer_chime_alert', 'every {n}').replace('{n}', clock(every)),
    };
  }

  // A calendar reminder (SSE calendar_reminder). `when` formats the start in
  // the caller's locale and 12/24h choice; without it the card has no time.
  function reminder(d, ctx, when) {
    if (!d || typeof d !== 'object') return null;
    const at = Date.parse(d.startsAt);
    return {
      type: 'reminder',
      kicker: tr(ctx, 'reminder', 'Reminder'),
      title: String(d.title || '') || tr(ctx, 'ph_title', 'Event'),
      message: Number.isFinite(at) && typeof when === 'function' ? when(new Date(at)) : '',
    };
  }

  // The last minute before an automatic update installs (SSE update_auto,
  // phase countdown, server/auto-update.js). `onLater` puts it off by an hour.
  // Any other phase has no card: the caller closes the countdown one.
  function autoUpdate(d, ctx, onLater) {
    if (!d || typeof d !== 'object' || d.phase !== 'countdown') return null;
    const seconds = Number(d.seconds) > 0 ? Number(d.seconds) : 60;
    const out = {
      type: 'update',
      kicker: 'Xenon',
      title: tr(ctx, 'auto_update_soon', 'Update in a minute'),
      message: tr(ctx, 'auto_update_soon_sub', 'Version {v}. The app restarts on its own.')
        .replace('{v}', String(d.version || '').replace(/^v/i, '')),
      duration: seconds * 1000,
      important: true,
    };
    if (typeof onLater === 'function') out.actions = [{ label: tr(ctx, 'auto_update_later', 'In an hour'), primary: true, onClick: onLater }];
    return out;
  }

  // A newer Xenon is out (GET /update/check), worded like the native app's own
  // card (native-bridge.js showUpdatePrompt). Sticky; `onOpen` installs,
  // `onSkip` (optional) silences this version only.
  function updateAvailable(info, ctx, onOpen, onSkip) {
    if (!info || typeof info !== 'object' || info.updateAvailable !== true) return null;
    const v = String(info.latest || '').replace(/^v/i, '').slice(0, 32);
    const out = {
      type: 'info',
      duration: 0,
      title: tr(ctx, 'native_update_title', 'Update available'),
      message: tr(ctx, 'native_update_tap', 'Tap to install the latest version.') + (v ? ' (v' + v + ')' : ''),
    };
    if (typeof onOpen === 'function') out.onClick = onOpen;
    if (typeof onSkip === 'function') out.actions = [{ label: tr(ctx, 'update_skip', 'Skip this version'), onClick: onSkip }];
    return out;
  }

  // A benchmark started or ended. `onReveal` (optional) is the "Show the file"
  // button; without it the saved toast has no button.
  function benchmark(d, ctx, onReveal) {
    if (!d || typeof d !== 'object' || d.seed) return null;
    const r = d.running ? {} : (d.result || {});
    const num = (v) => (v == null || !Number.isFinite(Number(v)) ? '--' : String(Math.round(Number(v))));
    // The game names the toast; the title already says it is a benchmark.
    const kicker = String((d.running ? d.game : r.game) || '').replace(/\.exe$/i, '') || tr(ctx, 'deck_act_benchmark', 'Benchmark');
    if (d.running) return { type: 'info', kicker, title: tr(ctx, 'bench_running', 'Benchmark running') };
    if (r.ok) {
      let message = tr(ctx, 'bench_saved_msg', '{avg} FPS average, 1% low {low}')
        .replace('{avg}', num(r.avgFps)).replace('{low}', num(r.low1Fps));
      if (r.folderMissing === true) message += ' · ' + tr(ctx, 'bench_folder_missing', 'Your folder is not there, saved in Documents');
      const out = { type: 'success', kicker, title: tr(ctx, 'bench_saved', 'Benchmark saved'), message, important: true };
      if (typeof onReveal === 'function') out.actions = [{ label: tr(ctx, 'bench_show', 'Show the file'), primary: true, onClick: onReveal }];
      return out;
    }
    const title = r.error === 'too_short' ? tr(ctx, 'bench_too_short', 'Benchmark too short, not saved')
      : r.error === 'no_frames' ? tr(ctx, 'bench_no_frames', 'No frames from the game, benchmark not saved')
        : tr(ctx, 'bench_failed', 'Could not save the benchmark');
    return { type: 'error', kicker, title };
  }

  // "Why does it stutter?" (server/stutter-why.js, SSE `stutter_why`): the
  // cause as the title, the next step under it. Ids and numbers arrive, the
  // words are the user's language; temperatures stay out (unit preference).
  const STUTTER_REASONS = Object.freeze(['smooth', 'capped', 'vram_full', 'ram_full', 'gpu_hot', 'cpu_hot', 'gpu_bound', 'cpu_bound', 'mixed', 'no_gpu_reading', 'loading']);
  const STUTTER_FALLBACK = Object.freeze({
    smooth: ['Runs smoothly', '{fps} FPS and no stutter.'],
    capped: ['Capped at {cap} FPS', 'V-Sync or a frame limit holds it there. That is normal.'],
    vram_full: ['Video memory full', 'Lower texture quality or resolution.'],
    ram_full: ['System memory almost full', 'Close browsers and other apps while playing.'],
    gpu_hot: ['Graphics card too hot', 'It slows itself down. Check its fans and the case airflow.'],
    cpu_hot: ['Processor too hot', 'It slows itself down. Check the CPU cooler and the case airflow.'],
    gpu_bound: ['Graphics card at full load', 'Lower resolution or graphics settings, or turn on DLSS, FSR or XeSS.'],
    cpu_bound: ['The graphics card waits', 'The processor or the game itself is the limit. Close apps in the background.'],
    mixed: ['No clear limit', 'Lower the graphics settings one step and close apps in the background.'],
    no_gpu_reading: ['Graphics card load unknown', 'This PC does not report it, so Xenon cannot tell what holds the game back.'],
    loading: ['Loading stutter', 'Nothing is at its limit: the game is loading or compiling shaders. It often calms down after a few minutes.'],
  });
  const fill = (text, d) => text.replace(/\{(fps|cap)\}/g, (_, k) => {
    const v = Number(d[k]);
    return Number.isFinite(v) ? String(Math.round(v)) : '--';
  });
  // The short line for a reason (the perf tile shows it), or '' when unknown.
  function stutterLabel(reason, d, ctx) {
    if (!STUTTER_REASONS.includes(reason)) return '';
    return fill(tr(ctx, 'why_' + reason, STUTTER_FALLBACK[reason][0]), d || {});
  }
  function stutterWhy(d, ctx) {
    if (!d || typeof d !== 'object' || d.ok !== true || !STUTTER_REASONS.includes(d.reason)) return null;
    const fine = d.reason === 'smooth' || d.reason === 'capped';
    return {
      type: fine ? 'success' : 'info',
      kicker: String(d.process || '').replace(/\.exe$/i, '').slice(0, 40) || tr(ctx, 'deck_act_stutterWhy', 'Why does it stutter?'),
      title: stutterLabel(d.reason, d, ctx),
      message: fill(tr(ctx, 'why_' + d.reason + '_tip', STUTTER_FALLBACK[d.reason][1]), d),
      duration: fine ? 6000 : 12000,
    };
  }

  // A game in exclusive full screen hides the widgets over it
  // (server/exclusive-hint.js, SSE `exclusive_hint`): why, and the fix.
  function exclusiveHint(d, ctx) {
    if (!d || typeof d !== 'object') return null;
    return {
      type: 'info',
      kicker: String(d.process || '').replace(/\.exe$/i, '').slice(0, 40) || tr(ctx, 'layout_widget_perf', 'Game performance'),
      title: tr(ctx, 'excl_title', 'Widgets cannot show over this game'),
      message: tr(ctx, 'excl_msg', 'In the game\'s display settings, pick borderless or windowed.'),
      duration: 15000,
    };
  }

  // Performance Mode (js/performance.js). The suggestion's line per activity,
  // as the dashboard's banner says it.
  const PERF_PROMPT_KEYS = Object.freeze({
    gaming: 'perf_banner_msg',
    coding: 'perf_banner_msg_coding',
    writing: 'perf_banner_msg_writing',
    streaming: 'perf_banner_msg_streaming',
    creating: 'perf_banner_msg_creating',
    meeting: 'perf_banner_msg_meeting',
  });
  const PERF_NOTE_KEYS = Object.freeze({
    perf_status_optimized: 'Performance optimized',
    perf_status_failed: 'Optimization failed',
    perf_status_restored: 'Settings restored',
    perf_auto_on: 'Auto-optimized for {a}',
    perf_auto_off: 'Activity ended: performance settings restored',
  });

  // What an optimize or restore did: { key, activity, freed }.
  function perfNoteText(note, ctx) {
    const n = note && typeof note === 'object' ? note : {};
    const key = Object.prototype.hasOwnProperty.call(PERF_NOTE_KEYS, n.key) ? n.key : 'perf_status_optimized';
    let text = tr(ctx, key, PERF_NOTE_KEYS[key]);
    if (key === 'perf_auto_on') {
      const a = String(n.activity || '');
      text = text.replace('{a}', tr(ctx, 'settings_perf_act_' + a, a));
    }
    if (n.freed) text += ' · ' + tr(ctx, 'perf_freed_ram', '~{x} of RAM freed').replace('{x}', String(n.freed));
    return text;
  }

  function perfNote(note, kind, ctx) {
    return { type: kind === 'error' ? 'error' : 'success', kicker: 'Xenon', title: perfNoteText(note, ctx), important: true };
  }

  // The suggestion, with no dashboard to put the banner on. `onAnswer(choice)`
  // gets 'optimize' or 'never'; closing the card is "Ignore". It shows during a
  // game, which is when it is asked, and only to who turned the suggestion on.
  function perfPrompt(activity, ctx, onAnswer) {
    const key = PERF_PROMPT_KEYS[activity];
    if (!key) return null;
    const out = {
      type: 'info',
      kicker: 'Xenon',
      title: tr(ctx, key, 'Optimize performance?'),
      duration: 20000,
      important: true,
    };
    if (typeof onAnswer === 'function') {
      out.actions = [
        { label: tr(ctx, 'perf_banner_optimize', 'Optimize'), primary: true, onClick: () => onAnswer('optimize') },
        { label: tr(ctx, 'perf_banner_never', "Don't ask again"), onClick: () => onAnswer('never') },
      ];
    }
    return out;
  }

  return { popupsAllowed, stocks, football, unifi, unifiLabel, UNIFI_KINDS, guardian, guardianText, vitals, timerDone, timerChime, reminder, autoUpdate, updateAvailable, benchmark, stutterWhy, stutterLabel, exclusiveHint, STUTTER_REASONS, clock, perfNoteText, perfNote, perfPrompt, PERF_PROMPT_KEYS };
});
