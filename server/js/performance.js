'use strict';
// ─────────────────────────────────────────────────────────────────────────
// Performance Mode controller (Phases 1–4 + customization).
//
// Reads hubSettings.performance (settings.js), applies and reverts REVERSIBLE
// optimizations, asks on Bit's card when an activity starts, and shows a
// confirmation sheet where the user picks exactly what to optimize before
// anything touches the system.
//
// Reversible actions:
//   • pause dashboard animations / background FX  (body.perf-mode, zero risk)
//   • switch the Windows power plan to High        (prior scheme GUID saved,
//     restored on exit)
//   • guided close of chosen background apps        (opt-in; the executable path
//     is remembered so Restore can reopen them)
//
// The AI planner (when enabled + a provider is configured) curates which open
// apps to close for the current activity and explains the plan; everything still
// goes through the confirmation sheet + allowlisted runner. Nothing here depends
// on AI. See docs/superpowers/specs/performance-mode.md.
//
// Relies on globals (shared <script> lexical scope): hubSettings, normalizeSettings,
// saveHubSettings, setSettingsStatus, syncPerformanceControls (settings.js),
// normalizePerformance (perf-settings.js), SERVER, t.
//
// "Widgets only" has no dashboard: its hidden driver page runs this same file
// (js/driver-perf.js) and sets window.PerfModeSurface, which takes over what
// the dashboard draws itself. The suggestion and the result become cards in the
// on-screen alerts window, and Optimize applies the safe tweaks without the
// sheet (closing apps is a choice only the sheet offers).
// ─────────────────────────────────────────────────────────────────────────

(function () {
  let _closeBanner = null;
  let _sheetEl = null;
  let _sheetLetGo = null;
  let _suppressBanner = false; // "don't ask again" for this page session
  let _snoozedActivities = new Set(); // already asked: not again until the game closes or a settings change
  let _lastActivity = 'other'; // last foreground activity we reacted to (transition tracking)
  let _reevaluate = true;      // weigh the next activity even if it did not change (load, refresh())
  let _lastActivityProcess = ''; // bare process name of the last non-'other' activity (priority target)
  let _lastServerActivity = 'other'; // last raw status payload, so onObs can re-classify
  let _lastProcess = '';
  let _gameRunning = false;    // server-side PID liveness: false = the game truly exited
  let _gameProcess = '';       // the running game's bare process name, from the server
  let _obsStreaming = false;   // live OBS streaming/recording flag (via the obs SSE event)
  let _autoRestoreTimer = null; // pending auto-restore once an auto session's activity ends
  let _sheetWindows = [];      // windows listed on the open sheet (for choice learning)
  let _sheetStats = null;      // process stats snapshot behind the open sheet (for impact)
  let _sheetMeta = { by: 'manual' }; // how the open sheet was triggered: manual, or auto (then it auto-restores)

  // Conservative no-AI preselection: per activity, only categories that are
  // never the activity itself, and only when the app actually costs real RAM.
  // Deliberately narrow — Discord stays untouched while gaming, music stays
  // untouched while coding; the learning counters adapt the rest over time.
  const PERF_SAFE_CLOSE = {
    music: ['spotify', 'itunes', 'musicbee', 'aimp', 'winamp', 'tidal', 'deezer'],
    launchers: ['steam', 'epicgameslauncher', 'battle.net', 'galaxyclient', 'ubisoftconnect', 'riotclientux', 'playnite', 'eadesktop'],
    office: ['winword', 'excel', 'powerpnt', 'outlook', 'thunderbird', 'onenote'],
  };
  const ACTIVITY_SAFE_CATEGORIES = {
    gaming: ['office'],
    coding: ['launchers'],
    writing: ['launchers', 'music'],
    streaming: ['office'],
    creating: ['launchers'],
    meeting: ['launchers', 'music'],
  };
  const PRESELECT_MIN_MB = 200;       // ignore lightweight apps — not worth closing
  const AUTO_RESTORE_DELAY_MS = 45000; // grace before an auto session restores (alt-tab safe)
  const AUTO_RESTORE_QUICK_MS = 4000;  // the game actually CLOSED — restore promptly

  const tr = (key, fallback) => (typeof t === 'function' && t(key)) || fallback;

  // The page that shows this mode when it is not a dashboard (driver-perf.js).
  const surface = () => window.PerfModeSurface || null;
  // Periodic checks run on the surface someone looks at. The driver page is
  // hidden by design and is the only owner while there is no dashboard.
  const nobodyLooking = () => !surface() && document.hidden;

  function currentPerf() {
    return normalizePerformance(hubSettings.performance);
  }

  // Persist a runtime patch WITHOUT calling refresh() (would recurse). Merges the
  // nested `opts`/`applied`/`activityApps` shallowly so callers can patch one key.
  function persist(patch) {
    const cur = currentPerf();
    const next = {
      ...cur, ...patch,
      opts: { ...cur.opts, ...(patch.opts || {}) },
      applied: { ...cur.applied, ...(patch.applied || {}) },
      activityApps: patch.activityApps || cur.activityApps,
    };
    hubSettings = normalizeSettings({ ...hubSettings, performance: next });
    saveHubSettings();
  }

  // ── Activity classification (defaults + user customization) ───────
  function defaultApps(activity) {
    return (PERF_DEFAULT_APPS[activity] || []).slice();
  }

  function effectiveApps(activity) {
    return perfActivityApps(currentPerf(), activity);
  }

  // Map a foreground process (+ the server's full-screen verdict) to an activity,
  // honouring the user's custom lists. A user-listed game always wins; otherwise
  // the server's full-screen detection drives 'gaming'. A live OBS stream counts
  // as 'streaming' even when the focus is on an untracked window.
  function classify(process, serverActivity) {
    const p = String(process || '').toLowerCase().replace(/\.exe$/, '');
    if (p && effectiveApps('gaming').includes(p)) return 'gaming';
    if (serverActivity === 'gaming') return 'gaming';
    for (const act of ['streaming', 'meeting', 'creating', 'coding', 'writing']) {
      if (p && effectiveApps(act).includes(p)) return act;
    }
    if (_obsStreaming) return 'streaming';
    return 'other';
  }

  let _stateSig = '';
  // Reflect the persisted "active" state onto the DOM. Safe to call repeatedly.
  function applyState() {
    const p = currentPerf();
    // perf-mode drives the animation/FX pause CSS, so it's gated on that action.
    document.body.classList.toggle('perf-mode', p.active && p.applied.pauseAnimations);
    // perf-active = a performance/optimization session is running at all (manual or
    // auto), regardless of which actions it applied. Heavy live tiles (Browser,
    // Second screen) read this so "pause heavy tiles while … optimizing" works even
    // when the session didn't also pause animations.
    document.body.classList.toggle('perf-active', !!p.active);
    _syncStaleWatch();
    _syncIdleWatch();
    _syncSystemButtons(p);
    // The top bar marker (js/perf-marker.js) and the Settings lines that a
    // session changes listen for this. applyState runs on every settings apply,
    // so it is told only when something they show has changed.
    const sig = [!!p.active, document.body.classList.contains('perf-mode'), p.barAlways].join('|');
    if (sig === _stateSig) return;
    _stateSig = sig;
    // Guarded: the widgets-only driver page and the tests run this without one.
    if (typeof CustomEvent === 'function' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('xenon:perf-change', { detail: { active: !!p.active } }));
    }
  }

  // The System tile's button is "Migliora" while nothing runs and "Ripristina"
  // while a session does. body.perf-active changes nothing you can see, so this
  // button was the only place a running session could have shown itself. The
  // i18n attributes move with the text so a language switch keeps the right label.
  function _syncSystemButtons(p) {
    const on = !!p.active;
    document.querySelectorAll('.sys-optimize-btn').forEach((btn) => {
      if (btn.classList.contains('is-active') === on && btn.dataset.perfSynced) return;
      btn.dataset.perfSynced = '1';
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      const titleKey = on ? 'settings_perf_restore_title' : 'sys_optimize';
      btn.setAttribute('data-i18n-title', titleKey);
      btn.title = on ? tr(titleKey, 'Performance Mode is on. Tap to restore') : tr(titleKey, 'Optimize performance');
      const label = btn.querySelector('span');
      if (label) {
        const key = on ? 'settings_perf_restore' : 'sys_optimize_short';
        label.setAttribute('data-i18n', key);
        label.textContent = on ? tr(key, 'Restore') : tr(key, 'Optimize');
      }
    });
  }

  // The power plan, process priority and the background app list exist only on
  // Windows. Anything else would only come back as a failure. XenonPlatform is ''
  // until the server has said.
  const windowsLevers = () => !window.XenonPlatform || window.XenonPlatform === 'win32';
  const closesApps = (p) => p.opts.manageApps && windowsLevers();

  // ── Server helpers ────────────────────────────────────────────────
  async function powerPlan(method, value) {
    const opts = { method };
    if (value != null) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify({ value });
    }
    const res = await fetch(SERVER + '/api/performance/powerplan', opts);
    return res.json().catch(() => ({ ok: false }));
  }

  async function perfAction(action) {
    const res = await fetch(SERVER + '/actions/perf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    });
    return res.json().catch(() => ({ ok: false }));
  }

  function aiAvailable(p) {
    if (!p.useAi || !hubSettings) return false;
    const provider = hubSettings.aiProvider;
    if (provider === 'ollama' || provider === 'localapi') return true;
    if (provider === 'claudecode' || provider === 'codex' || provider === 'xenon') return true;
    if (provider === 'openai') return !!hubSettings.openaiApiKeySet;
    if (provider === 'anthropic') return !!hubSettings.anthropicApiKeySet;
    return geminiKeyReady(hubSettings);
  }

  async function fetchWindows() {
    try {
      const res = await fetch(SERVER + '/windows');
      const data = await res.json();
      const list = Array.isArray(data && data.windows) ? data.windows : [];
      return list.filter(w => w && w.id && !w.active && typeof w.app === 'string');
    } catch { return []; }
  }

  // Real measurements: system memory pressure + per-process RAM/CPU, keyed by
  // bare lowercase process name. Null when the probe fails (graceful fallback).
  async function fetchStats() {
    try {
      const res = await fetch(SERVER + '/api/performance/stats');
      const d = await res.json();
      if (!d || !d.ok) return null;
      const byProc = {};
      for (const a of (Array.isArray(d.apps) ? d.apps : [])) {
        byProc[String(a.proc || '').toLowerCase()] = { memMB: Number(a.memMB) || 0, cpuPct: Number(a.cpuPct) || 0 };
      }
      return { byProc, totalMB: Number(d.totalMB) || 0, freeMB: Number(d.freeMB) || 0 };
    } catch { return null; }
  }

  // What Core Shield can do on this PC and what it did this session. It runs on the
  // server, which sees the game and the busy apps. Null when the server did not say.
  async function fetchShield() {
    try {
      const res = await fetch(SERVER + '/api/performance/shield');
      const d = await res.json();
      return d && d.ok ? d : null;
    } catch { return null; }
  }

  function _procKey(name) {
    return String(name || '').toLowerCase().trim().replace(/\.exe$/, '');
  }

  // The game while one runs: the last activity app may be the editor someone Alt-Tabbed to.
  const _boostTarget = () => (_gameRunning && _gameProcess) || _lastActivityProcess;

  // The tweaks that need no choice, for a session with no sheet: what the user saved.
  function savedEffective(p) {
    return {
      pauseAnimations: p.opts.pauseAnimations,
      powerPlan: p.opts.powerPlan,
      priorityBoost: p.opts.priorityBoost && !!_boostTarget(),
      shield: p.opts.shield,
    };
  }

  function _fmtMB(mb) {
    return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
  }

  // No-AI preselection: safe category for this activity + costs real RAM.
  function deterministicPreselect(activity, windows, stats) {
    const cats = ACTIVITY_SAFE_CATEGORIES[activity] || [];
    const safe = new Set(cats.flatMap(c => PERF_SAFE_CLOSE[c] || []));
    const out = [];
    for (const w of windows) {
      const proc = _procKey(w.app);
      if (!safe.has(proc)) continue;
      const mem = stats && stats.byProc[proc] ? stats.byProc[proc].memMB : 0;
      if (mem >= PRESELECT_MIN_MB) out.push(w.app);
    }
    return out;
  }

  // Learning bias from past sheet choices: 1 = user reliably closes this app,
  // -1 = user reliably keeps it (overrides any preselection), 0 = no signal.
  function learnedBias(proc, perf) {
    const c = (perf.appChoices || {})[proc];
    if (!c) return 0;
    if (c.closed >= 2 && c.closed > c.kept) return 1;
    if (c.kept >= 2 && c.kept >= c.closed) return -1;
    return 0;
  }

  // Update the keep/close counters from what the user actually applied.
  function _recordChoices(selected) {
    if (!_sheetWindows.length) return;
    const chosen = new Set(selected.map(a => _procKey(a.name)));
    const next = { ...currentPerf().appChoices };
    for (const w of _sheetWindows) {
      const proc = _procKey(w.app);
      if (!proc) continue;
      const c = next[proc] || { kept: 0, closed: 0 };
      next[proc] = chosen.has(proc)
        ? { kept: c.kept, closed: Math.min(99, c.closed + 1) }
        : { kept: Math.min(99, c.kept + 1), closed: c.closed };
    }
    persist({ appChoices: next });
  }

  async function fetchActivity() {
    try { const res = await fetch(SERVER + '/api/gamemode/status'); const d = await res.json(); return classify(d && d.foreground && d.foreground.process, d && d.activity); }
    catch { return 'other'; }
  }

  async function fetchPlan(p, activity, appNames) {
    try {
      const res = await fetch(SERVER + '/api/performance/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activity,
          apps: appNames,
          opts: p.opts,
          provider: ['ollama', 'localapi', 'openai', 'anthropic', 'claudecode', 'codex', 'xenon'].includes(hubSettings.aiProvider) ? hubSettings.aiProvider : 'gemini',
          key: String(hubSettings.geminiApiKey || ''),
          model: hubSettings.ollamaModel,
          ollamaUrl: hubSettings.ollamaUrl,
          lang: (typeof lang !== 'undefined' && lang) || 'en',
        }),
      });
      const d = await res.json();
      return (d && d.ok && d.plan) ? d.plan : null;
    } catch { return null; }
  }

  // ── Apply / restore ──────────────────────────────────────────────
  // meta: { by: 'manual'|'auto', activity } — auto sessions restore themselves
  // when their activity ends; manual ones wait for the user.
  async function applyOptimizations(effective, selectedApps, meta) {
    const eff = effective || { pauseAnimations: false, powerPlan: 'none' };
    const by = (meta && meta.by) === 'auto' ? 'auto' : 'manual';
    let ok = true;
    const applied = { pauseAnimations: !!eff.pauseAnimations, powerPlan: 'none', shield: !!eff.shield };

    if (eff.powerPlan && eff.powerPlan !== 'none' && windowsLevers()) {
      try {
        const cur = await powerPlan('GET');
        const saved = (cur && cur.ok && cur.guid) ? cur.guid : '';
        const set = await powerPlan('POST', eff.powerPlan);
        // A plan that was already on has nothing to go back to.
        if (set && set.ok) persist({ active: true, savedPowerPlan: set.unchanged ? '' : saved, applied: { ...applied, powerPlan: eff.powerPlan } });
        else { ok = false; persist({ active: true, applied }); }
      } catch { ok = false; persist({ active: true, applied }); }
    } else {
      persist({ active: true, applied });
    }

    // Reversible priority nudge for the detected activity app. An app that refuses
    // (anti-cheat, elevated) is within its rights, and the session is still for it.
    const target = _boostTarget();
    if (eff.priorityBoost && target && windowsLevers()) {
      try {
        const r = await perfAction({ type: 'setPriority', name: target, level: 'high' });
        if (r && (r.ok || r.error === 'denied')) persist({ applied: { boostedProc: target } });
        else ok = false;
      } catch { ok = false; }
    }

    const apps = Array.isArray(selectedApps) ? selectedApps : [];
    let freedMB = 0;
    if (apps.length) {
      const closed = [];
      for (const a of apps) {
        try {
          const r = await perfAction({ type: 'closeApp', id: a.id });
          if (r && r.ok && r.path) {
            closed.push({ name: r.app || a.name || '', path: r.path });
            // Measured impact: the RAM this app held when the sheet was opened.
            const s = _sheetStats && _sheetStats.byProc[_procKey(r.app || a.name)];
            if (s) freedMB += s.memMB;
          } else if (!r || !r.ok) ok = false;
        } catch { ok = false; }
      }
      if (closed.length) {
        const existing = currentPerf().closedApps;
        const byPath = new Map(existing.map(x => [x.path.toLowerCase(), x]));
        for (const c of closed) byPath.set(c.path.toLowerCase(), c);
        persist({ closedApps: [...byPath.values()] });
      }
    }

    persist({ activatedBy: by, autoActivity: by === 'auto' ? String((meta && meta.activity) || '') : '' });
    applyState();
    hideBanner();
    if (typeof syncPerformanceControls === 'function') syncPerformanceControls();
    if (typeof setSettingsStatus === 'function') {
      setSettingsStatus(ok ? 'perf_status_optimized' : 'perf_status_failed', ok ? 'ok' : 'error');
    }
    // Tell the user what it was worth: freed RAM (measured), and for auto
    // sessions which activity triggered them.
    _perfNote({
      key: !ok ? 'perf_status_failed' : (by === 'auto' && meta && meta.activity ? 'perf_auto_on' : 'perf_status_optimized'),
      activity: ok && by === 'auto' && meta && meta.activity ? String(meta.activity) : '',
      freed: ok && freedMB >= 100 ? _fmtMB(freedMB) : '',
    }, ok ? 'ok' : 'error');
  }

  // meta: { auto: true } when an ended auto session restores itself.
  async function restore(meta) {
    _cancelAutoRestore();
    const p = currentPerf();
    // Asked first: the server forgets the session's apps when the session ends.
    const shield = p.applied.shield ? await fetchShield() : null;
    const moved = shield && Array.isArray(shield.moved) ? shield.moved.length : 0;
    if (p.savedPowerPlan) {
      try { await powerPlan('POST', p.savedPowerPlan); } catch { /* best effort */ }
    }
    if (p.applied.boostedProc) {
      try { await perfAction({ type: 'setPriority', name: p.applied.boostedProc, level: 'normal' }); } catch { /* best effort */ }
    }
    for (const a of p.closedApps) {
      try { await perfAction({ type: 'launchApp', path: a.path }); } catch { /* ignore */ }
    }
    persist({ active: false, activatedBy: '', autoActivity: '', savedPowerPlan: '', closedApps: [], applied: { pauseAnimations: false, powerPlan: 'none', boostedProc: '', shield: false } });
    applyState();
    if (typeof syncPerformanceControls === 'function') syncPerformanceControls();
    if (typeof setSettingsStatus === 'function') setSettingsStatus('perf_status_restored', 'ok');
    _perfNote({ key: meta && meta.auto ? 'perf_auto_off' : 'perf_status_restored', moved }, 'ok');
  }

  // ── Auto mode: apply on activity start, restore when it ends ──────
  async function _autoApply(activity) {
    // Safe, reversible tweaks only — closing apps always goes through the sheet.
    await applyOptimizations(savedEffective(currentPerf()), [], { by: 'auto', activity });
  }

  function _scheduleAutoRestore(delayMs = AUTO_RESTORE_DELAY_MS) {
    if (_autoRestoreTimer) return;
    _autoRestoreTimer = setTimeout(async () => {
      _autoRestoreTimer = null;
      const p = currentPerf();
      const cur = _lastActivity;
      const stillEnabled = cur !== 'other' && p.autoActivities && p.autoActivities[cur];
      if (p.active && p.activatedBy === 'auto' && !stillEnabled) await restore({ auto: true });
    }, delayMs);
  }

  // The long restore grace exists for Alt-Tab: the game is still alive and the
  // user is probably coming back. When the game process is actually GONE,
  // sitting out the rest of it just leaves Performance Mode on for no reason —
  // reschedule the pending restore to fire promptly instead.
  function _expediteAutoRestore() {
    if (!_autoRestoreTimer) return;
    clearTimeout(_autoRestoreTimer);
    _autoRestoreTimer = null;
    _scheduleAutoRestore(AUTO_RESTORE_QUICK_MS);
  }

  function _cancelAutoRestore() {
    if (_autoRestoreTimer) { clearTimeout(_autoRestoreTimer); _autoRestoreTimer = null; }
  }

  // ── a session must not outlive the app it was started for ─────────
  // An AUTO session already ends itself: _react() schedules a restore as soon as
  // the activity stops being one the user opted into. A MANUAL one had no end
  // condition at all. You press the button for a game, the game exits, and
  // Performance Mode is still on hours later — animations paused across the
  // whole dashboard, power plan swapped, and nothing on screen saying why.
  //
  // Found on a real install: a session started for `planetcoaster2`, still
  // active with the game long gone. What it looked like from the outside was a
  // broken dashboard, because the only visible symptom is that everything
  // stopped moving. Nobody goes looking in Performance settings for that.
  //
  // The end condition is the one the session itself wrote down: `boostedProc` is
  // the app it was started for. When that app is gone, the reason is gone —
  // whoever started it.
  const STALE_POLL_MS = 5 * 60 * 1000;   // the slow sweep, for a session already stale at load
  const STALE_FIRST_MS = 15000;          // …but ask soon after the dashboard settles
  const STALE_RECHECK_MS = 30000;        // an app that is merely restarting gets a second chance
  let _stalePoll = null;
  let _staleRecheck = null;

  // Is the app the session was started for still running?
  //
  // NOT /api/performance/stats. That is a top-40-by-RAM ranking built for the
  // "close these apps" sheet, and absent from it does not mean gone: Windows
  // trims a minimised process's working set hard, so a minimised game drops off
  // the list while still running — and ending the session then would revert the
  // power plan and drop the priority boost UNDER A LIVE GAME, announcing that it
  // had finished. A ranking is not a process list.
  //
  // `isRunning` looks the name up in the whole process table, which is an exact
  // answer, changes nothing and starts no process.
  //
  // Three-valued on purpose. `null` is NOBODY ANSWERED, when the table cannot be
  // read, and must never be read as the app being gone.
  async function _boostedAlive(name) {
    let r = null;
    try { r = await perfAction({ type: 'isRunning', name }); } catch { return null; }
    return r && r.ok ? !!r.running : null;
  }

  async function _checkStale(isRecheck) {
    const p = currentPerf();
    const proc = (p.active && p.applied) ? _procKey(p.applied.boostedProc) : '';
    if (!proc) return;
    const alive = await _boostedAlive(proc);
    if (alive !== false) return;                    // running, or no answer at all
    if (!isRecheck) {
      // Ask once more in a moment: an app that is restarting is briefly absent,
      // and ending somebody's session by mistake is worse than ending it late.
      if (_staleRecheck) return;
      _staleRecheck = setTimeout(() => { _staleRecheck = null; _checkStale(true); }, STALE_RECHECK_MS);
      return;
    }
    // The session may have been ended, or re-pointed at another app, while we
    // were waiting out the recheck.
    const now = currentPerf();
    if (!now.active || _procKey(now.applied && now.applied.boostedProc) !== proc) return;
    await restore({ auto: true });      // toasts, so it is never a silent change
  }

  // Started and stopped from applyState(), which already runs on every settings
  // change and after restore() — so the watch exists only while there is a
  // session with an app to outlive, and stops the moment there is not. Slow on
  // purpose: the game-death signal in onStatus() catches the common case
  // immediately, and this only has to catch a session that was already stale when
  // the dashboard opened.
  function _syncStaleWatch() {
    const p = currentPerf();
    const want = !!(p.active && p.applied && p.applied.boostedProc);
    if (want && !_stalePoll) {
      // Gated on the tab being visible, like every other periodic client work:
      // with nobody looking, a session ending a few minutes later costs nothing.
      const tick = () => { if (!nobodyLooking()) _checkStale(false); };
      setTimeout(tick, STALE_FIRST_MS);
      _stalePoll = setInterval(tick, STALE_POLL_MS);
    } else if (!want && _stalePoll) {
      clearInterval(_stalePoll);
      _stalePoll = null;
      if (_staleRecheck) { clearTimeout(_staleRecheck); _staleRecheck = null; }
    }
  }

  // ── …and a session started for no app ends when nothing needs it ──
  // The stale check above needs `boostedProc`, and a session started with no game
  // or opted-in activity in the foreground ("Migliora" on the System tile, while
  // just using the desktop) never records one. That session had no end at all.
  // Found on a real install: on for days, with the Browser tile paused and the
  // power plan on High the whole time. So it ends after IDLE_END_MS in which no
  // game ran and no activity the user opted into was in front. Anything that
  // counts as busy restarts the count, so it never ends under a game.
  const IDLE_END_MS = 20 * 60 * 1000;
  const IDLE_TICK_MS = 60 * 1000;
  let _idleSince = 0;
  let _idleTimer = null;

  function _idleEligible(p) {
    return !!(p.active && p.activatedBy === 'manual' && !(p.applied && p.applied.boostedProc));
  }

  function _busyNow(p) {
    if (_gameRunning) return true;
    return _lastActivity !== 'other' && !!(p.autoActivities && p.autoActivities[_lastActivity]);
  }

  async function _idleTick() {
    const p = currentPerf();
    if (!_idleEligible(p)) return;
    if (_busyNow(p)) { _idleSince = 0; return; }
    const now = Date.now();
    if (!_idleSince) { _idleSince = now; return; }
    // A surface nobody is looking at leaves this to the one that is: restore()
    // relaunches closed apps, and two surfaces doing it at once would do it twice.
    if (nobodyLooking()) return;
    if (now - _idleSince < IDLE_END_MS) return;
    _idleSince = 0;
    await restore({ auto: true });   // toasts, so it is never a silent change
  }

  function _syncIdleWatch() {
    const want = _idleEligible(currentPerf());
    if (want && !_idleTimer) {
      _idleSince = 0;
      _idleTimer = setInterval(() => { _idleTick().catch(() => {}); }, IDLE_TICK_MS);
      _idleTick().catch(() => {});
    } else if (!want && _idleTimer) {
      clearInterval(_idleTimer);
      _idleTimer = null;
      _idleSince = 0;
    }
  }

  // ── Confirmation sheet ───────────────────────────────────────────
  function buildSheet() {
    const overlay = document.createElement('div');
    overlay.className = 'perf-sheet-overlay';
    overlay.hidden = true;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismissSheet(); });

    const card = document.createElement('div');
    card.className = 'perf-sheet';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    overlay.appendChild(card);

    const head = document.createElement('div');
    head.className = 'perf-sheet-head';
    const bit = document.createElement('div');
    bit.className = 'perf-sheet-bit';
    if (window.BitApp) bit.innerHTML = window.BitApp.icon('idle');   // static, trusted markup
    const words = document.createElement('div');
    const title = document.createElement('h3');
    title.className = 'perf-sheet-title';
    title.textContent = tr('perf_sheet_title', 'Performance optimization');
    const hint = document.createElement('p');
    hint.className = 'perf-sheet-hint';
    hint.textContent = tr('perf_sheet_restore_hint', 'You can undo everything from Settings → Performance.');
    words.append(title, hint);
    head.append(bit, words);
    card.setAttribute('aria-label', title.textContent);
    card.appendChild(head);

    // What Bit planned, when it planned something.
    const intro = document.createElement('p');
    intro.className = 'perf-sheet-intro';
    intro.hidden = true;
    card.appendChild(intro);

    // Per-run optimization toggles (pre-set from the saved options).
    const opts = document.createElement('div');
    opts.className = 'perf-sheet-opts';
    opts.appendChild(_optRow('pauseAnimations', tr('perf_act_pauseanim', 'Pause animations and animated backgrounds')));
    if (windowsLevers()) {
      opts.appendChild(_optRow('powerPlan', tr('perf_act_powerplan', 'High-performance power plan')));
      const prio = _optRow('priorityBoost', tr('perf_act_priority', 'Boost the active app’s priority'));
      prio.classList.add('perf-sheet-opt-priority');
      opts.appendChild(prio);
    }
    const shield = _optRow('shield', tr('perf_act_shield', "Keep busy apps out of the game's way"));
    shield.classList.add('perf-sheet-opt-shield');
    opts.appendChild(shield);
    card.appendChild(opts);

    // Background-apps picker (populated lazily when the option is on).
    const appsWrap = document.createElement('div');
    appsWrap.className = 'perf-sheet-apps';
    appsWrap.hidden = true;
    const appsHead = document.createElement('p');
    appsHead.className = 'perf-sheet-apps-head';
    appsHead.textContent = tr('perf_sheet_apps_head', 'Background apps to close:');
    const appsList = document.createElement('ul');
    appsList.className = 'perf-sheet-apps-list';
    appsWrap.appendChild(appsHead);
    appsWrap.appendChild(appsList);
    card.appendChild(appsWrap);

    const actions = document.createElement('div');
    actions.className = 'perf-sheet-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'perf-btn perf-btn-ghost';
    cancel.textContent = tr('perf_sheet_cancel', 'Cancel');
    cancel.addEventListener('click', dismissSheet);
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'perf-btn perf-btn-primary';
    apply.textContent = tr('perf_sheet_apply', 'Apply');
    apply.addEventListener('click', () => {
      const effective = collectEffective();
      const selected = collectSelectedApps();
      _recordChoices(selected); // learn which apps this user keeps vs closes
      closeSheet();
      applyOptimizations(effective, selected, _sheetMeta);
    });
    actions.appendChild(cancel);
    actions.appendChild(apply);
    card.appendChild(actions);

    document.body.appendChild(overlay);
    return overlay;
  }

  function _optRow(opt, label) {
    const row = document.createElement('label');
    row.className = 'perf-sheet-opt';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.opt = opt;
    const name = document.createElement('span');
    name.className = 'perf-sheet-opt-label';
    name.textContent = label;
    row.appendChild(cb);
    row.appendChild(name);
    return row;
  }

  function openSheet() {
    if (_sheetLetGo) return;
    _sheetEl.hidden = false;
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('perf-sheet', true);
    _sheetLetGo = window.DialogFocus.hold(_sheetEl, { start: _sheetEl.querySelector('.perf-btn-primary'), onEsc: dismissSheet });
  }

  function closeSheet() {
    if (!_sheetEl || _sheetEl.hidden) return;
    _sheetEl.hidden = true;
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('perf-sheet', false);
    _sheetLetGo();
    _sheetLetGo = null;
  }

  // Dismissing an auto-opened sheet (Cancel / click-outside) means "not now" for
  // this activity: snooze it for the session so re-focusing the same app/game
  // doesn't keep re-opening the sheet. Applying instead goes through closeSheet
  // (no snooze), so auto mode still re-optimizes on the next, fresh session.
  function dismissSheet() {
    if (_sheetMeta && _sheetMeta.by === 'auto' && _sheetMeta.activity) {
      _snoozedActivities.add(_sheetMeta.activity);
    }
    closeSheet();
  }

  function collectEffective() {
    const p = currentPerf();
    const pa = _sheetEl && _sheetEl.querySelector('[data-opt="pauseAnimations"]');
    const pp = _sheetEl && _sheetEl.querySelector('[data-opt="powerPlan"]');
    const prioRow = _sheetEl && _sheetEl.querySelector('.perf-sheet-opt-priority');
    const prioCb = _sheetEl && _sheetEl.querySelector('[data-opt="priorityBoost"]');
    const shieldRow = _sheetEl && _sheetEl.querySelector('.perf-sheet-opt-shield');
    const shieldCb = _sheetEl && _sheetEl.querySelector('[data-opt="shield"]');
    const powerPlan = (pp && pp.checked) ? (p.opts.powerPlan !== 'none' ? p.opts.powerPlan : 'high') : 'none';
    const priorityBoost = !!(prioCb && prioCb.checked && prioRow && !prioRow.hidden);
    const shield = !!(shieldCb && shieldCb.checked && shieldRow && !shieldRow.hidden);
    return { pauseAnimations: !!(pa && pa.checked), powerPlan, priorityBoost, shield };
  }

  function collectSelectedApps() {
    if (!_sheetEl) return [];
    const checks = _sheetEl.querySelectorAll('.perf-sheet-apps-list input[type="checkbox"]:checked');
    return Array.from(checks).map(c => ({ id: c.dataset.id, name: c.dataset.name }));
  }

  // Render the closable-app checklist. Pre-checked: the AI's picks when
  // available, else the conservative deterministic preselect — in both cases
  // corrected by what this user has reliably kept/closed before. Each row shows
  // the app's measured RAM so the choice is informed.
  function renderApps(appsList, windows, preselect, stats, perf) {
    appsList.textContent = '';
    const pre = new Set((Array.isArray(preselect) ? preselect : []).map(n => String(n).toLowerCase()));
    if (!windows.length) {
      const li = document.createElement('li');
      li.className = 'perf-sheet-apps-empty';
      li.textContent = tr('perf_sheet_apps_empty', 'No background apps to close.');
      appsList.appendChild(li);
      return;
    }
    for (const w of windows) {
      const proc = _procKey(w.app);
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'perf-sheet-app';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.id = String(w.id);
      cb.dataset.name = String(w.app || '');
      cb.checked = pre.has(String(w.app || '').toLowerCase());
      const bias = learnedBias(proc, perf || currentPerf());
      if (bias === 1) cb.checked = true;
      else if (bias === -1) cb.checked = false; // the user's own habit beats any suggestion
      const name = document.createElement('span');
      name.className = 'perf-sheet-app-name';
      name.textContent = w.app || w.title || '—';
      const ttl = document.createElement('span');
      ttl.className = 'perf-sheet-app-title';
      ttl.textContent = w.title || '';
      label.appendChild(cb);
      label.appendChild(name);
      label.appendChild(ttl);
      const s = stats && stats.byProc[proc];
      if (s && s.memMB >= 50) {
        const mem = document.createElement('span');
        mem.className = 'perf-sheet-app-mem';
        mem.textContent = _fmtMB(s.memMB);
        label.appendChild(mem);
      }
      li.appendChild(label);
      appsList.appendChild(li);
    }
  }

  // Open the chooser. Always available (manual / System-panel / voice): the sheet
  // itself lets the user pick what to apply. When app management is on and AI is
  // available, the AI pre-selects apps and explains the plan.
  // meta: undefined / { by:'manual' } for user-triggered runs, or { by:'auto',
  // activity } when an automatic-mode session opens the sheet so its Apply still
  // tags the session 'auto' (and it auto-restores when the activity ends).
  async function optimize(meta) {
    _sheetMeta = (meta && meta.by === 'auto') ? { by: 'auto', activity: meta.activity || 'other' } : { by: 'manual' };
    // No dashboard, no sheet: the safe, reversible tweaks the user saved.
    if (surface()) {
      const p = currentPerf();
      if (p.active) return;
      await applyOptimizations(savedEffective(p), [], _sheetMeta);
      return;
    }
    // Loading state on the System-panel button while we fetch apps + ask the AI
    // (which can take a moment) — so the click gives immediate feedback.
    const trigger = document.getElementById('sys-optimize-btn');
    if (trigger) { trigger.classList.add('is-loading'); trigger.disabled = true; }
    try {
      await _runOptimize();
    } finally {
      if (trigger) { trigger.classList.remove('is-loading'); trigger.disabled = false; }
    }
  }

  async function _runOptimize() {
    const p = currentPerf();
    const [windows, stats, shield] = await Promise.all([
      closesApps(p) ? fetchWindows() : Promise.resolve([]),
      closesApps(p) ? fetchStats() : Promise.resolve(null),
      fetchShield(),
    ]);
    _sheetWindows = windows;
    _sheetStats = stats;
    let plan = null;
    let activity = 'other';
    if (closesApps(p) && windows.length) {
      activity = await fetchActivity();
      if (aiAvailable(p)) {
        if (typeof setSettingsStatus === 'function') setSettingsStatus('perf_status_planning', 'ok');
        plan = await fetchPlan(p, activity, windows.map(w => w.app));
      }
    }

    if (!_sheetEl) _sheetEl = buildSheet();

    // Pre-set the option toggles from the saved defaults.
    const pa = _sheetEl.querySelector('[data-opt="pauseAnimations"]');
    const pp = _sheetEl.querySelector('[data-opt="powerPlan"]');
    if (pa) pa.checked = p.opts.pauseAnimations;
    if (pp) pp.checked = p.opts.powerPlan !== 'none';
    // Priority boost only makes sense when we know which app to boost; show that
    // row only when an activity app has been detected this session.
    const prioRow = _sheetEl.querySelector('.perf-sheet-opt-priority');
    const prioCb = _sheetEl.querySelector('[data-opt="priorityBoost"]');
    if (prioRow) prioRow.hidden = !_boostTarget();
    if (prioCb) prioCb.checked = p.opts.priorityBoost && !!_boostTarget();
    // Core Shield needs enough cores and the OS tool for it, so the server says.
    const canShield = !!(shield && shield.available);
    const shieldRow = _sheetEl.querySelector('.perf-sheet-opt-shield');
    const shieldCb = _sheetEl.querySelector('[data-opt="shield"]');
    if (shieldRow) shieldRow.hidden = !canShield;
    if (shieldCb) shieldCb.checked = p.opts.shield && canShield;

    const intro = _sheetEl.querySelector('.perf-sheet-intro');
    intro.textContent = (plan && plan.explanation) || '';
    intro.hidden = !intro.textContent;

    const appsWrap = _sheetEl.querySelector('.perf-sheet-apps');
    const appsList = _sheetEl.querySelector('.perf-sheet-apps-list');
    if (closesApps(p)) {
      appsWrap.hidden = false;
      appsWrap.querySelector('.perf-sheet-apps-head').hidden = !windows.length;
      // AI picks when available; otherwise the conservative measured preselect.
      const preselect = (plan && Array.isArray(plan.closeApps) && plan.closeApps.length)
        ? plan.closeApps
        : deterministicPreselect(activity, windows, stats);
      renderApps(appsList, windows, preselect, stats, p);
    } else {
      appsWrap.hidden = true;
      appsList.textContent = '';
    }

    if (typeof setSettingsStatus === 'function') setSettingsStatus('', 'ok');
    openSheet();
  }

  // ── Auto-suggest ─────────────────────────────────────────────────
  // The answer to a suggestion: the keys of Bit's card, here or in the alerts window
  // (driver-perf.js), and Bit when it runs there. 'restore' ends a session.
  function answer(choice) {
    if (choice === 'optimize') { hideBanner(); return optimize(); }
    if (choice === 'restore') { hideBanner(); return currentPerf().active ? restore() : undefined; }
    if (choice === 'ignore') { _snoozedActivities.add(_lastActivity); hideBanner(); return undefined; }
    if (choice === 'never') {
      _suppressBanner = true;
      persist({ autoSuggest: false });
      if (typeof syncPerformanceControls === 'function') syncPerformanceControls();
      hideBanner();
    }
    return undefined;
  }

  let _suggesting = false;
  function showBanner(activity) {
    const s = surface();
    if (s) { _suggesting = true; s.suggest(activity); return; }
    hideBanner();
    const parts = window.AlertToasts.perfPrompt(activity, { t: tr }, answer);
    if (parts) _closeBanner = window.XenonBitCard.ask(parts, { bit: window.XenonReleaseNotes.bit });
  }

  function hideBanner() {
    const s = surface();
    if (s) { if (_suggesting) { _suggesting = false; s.hide(); } return; }
    if (!_closeBanner) return;
    _closeBanner();
    _closeBanner = null;
  }

  // The notice that an optimize or restore finished, the same one the alerts window
  // shows. `note` is { key, activity, freed, moved }.
  function _perfNote(note, kind) {
    const s = surface();
    if (s) { s.toast(note, kind); return; }
    window.XenonToast.show(window.AlertToasts.perfNote(note, kind, { t: tr }));
  }

  // React to a (classified) activity transition. In 'suggest' mode this shows
  // the question; in 'auto' mode it applies the safe tweaks directly, or opens the
  // confirmation sheet when app-closing is enabled (a real choice to make). Auto
  // sessions also retire themselves: when their activity ends (and no other
  // enabled one took over), everything is restored after a grace period.
  // Subscribers notified on every CLASSIFIED activity transition, regardless of
  // whether the optimizer itself acts (Smart context profiles hooks in here so
  // there is a single activity concept). Kept lightweight; listeners must not throw.
  const _activityListeners = [];
  function onActivityChange(fn) { if (typeof fn === 'function') _activityListeners.push(fn); }
  function activity() { return _lastActivity; }

  function _react(a) {
    const changed = a !== _lastActivity;
    if (!changed && !_reevaluate) return;
    _reevaluate = false;
    _lastActivity = a;
    if (changed) {
      for (let i = 0; i < _activityListeners.length; i++) {
        try { _activityListeners[i](a); } catch (e) { /* a listener must never break detection */ }
      }
    }
    const p = currentPerf();
    const suggestible = a !== 'other' && p.autoActivities && p.autoActivities[a];

    if (p.active && p.activatedBy === 'auto') {
      if (suggestible) _cancelAutoRestore();
      else _scheduleAutoRestore();
    }

    if (!suggestible) { hideBanner(); return; }
    if (!p.enabled || p.active || _suppressBanner || _snoozedActivities.has(a)) return;
    if (p.autoMode === 'auto') {
      // Auto mode applies the safe reversible tweaks by itself. But when app
      // closing is enabled there's a real choice to make (which apps, plus the
      // AI plan when configured), so surface the confirmation sheet instead —
      // still tagged 'auto' so it restores itself when the activity ends.
      if (closesApps(p)) optimize({ by: 'auto', activity: a });
      else _autoApply(a);
      return;
    }
    if (!p.autoSuggest) return;
    // One question per game: Alt-Tab out and back is the same game, whatever
    // became of the card (answered, closed, timed out).
    _snoozedActivities.add(a);
    showBanner(a);
  }

  // Preferred entry: classify the live status (activity + foreground process)
  // through the user's custom lists, then react.
  function onStatus(serverActivity, process, gameRunning, gameProcess) {
    _lastServerActivity = serverActivity;
    _lastProcess = process;
    const wasGameRunning = _gameRunning;
    if (typeof gameRunning === 'boolean') _gameRunning = gameRunning;
    _gameProcess = _procKey(gameProcess);
    const a = classify(process, serverActivity);
    const p = String(process || '').toLowerCase().replace(/\.exe$/, '');
    if (a !== 'other' && p) _lastActivityProcess = p; // remember the app to boost
    _react(a);
    // Game process died (as opposed to just losing focus): any pending
    // auto-restore can stop waiting out the Alt-Tab grace, and a session that
    // was started FOR that app — including a manual one, which has no other way
    // to end — starts counting its way out.
    if (wasGameRunning && !_gameRunning) { _snoozedActivities.delete('gaming'); _expediteAutoRestore(); _checkStale(false); }
    // A game or opted-in activity between two idle ticks still counts as busy.
    if (_idleTimer && _busyNow(currentPerf())) _idleSince = 0;
  }

  // Live OBS state (obs SSE event): going on-air counts as a streaming session
  // even when the focus sits on an untracked window, so re-classify on change.
  function onObs(d) {
    const now = !!(d && (d.obsStreaming || d.obsRecording));
    if (now === _obsStreaming) return;
    _obsStreaming = now;
    _react(classify(_lastProcess, _lastServerActivity));
  }

  // Compat shims for callers without the process name.
  function onActivity(activity) { _react(['gaming', 'coding', 'writing'].includes(activity) ? activity : 'other'); }
  function onGaming(gaming) { _react(gaming ? 'gaming' : 'other'); }

  // ── Lifecycle ────────────────────────────────────────────────────
  // Called after any Performance settings change. Besides re-applying the DOM
  // state, reset the activity tracker so the auto-suggest is re-evaluated on the
  // next status tick — e.g. the user just enabled "coding" while already in VS
  // Code, which otherwise wouldn't re-trigger (same activity, no transition).
  // A settings change starts the suggestion over: a suggestion still showing goes
  // (the next status tick asks again if it still applies), or it outlived the
  // activity. That tick is always weighed, even when it reads 'other': otherwise
  // an automatic session running across the change never scheduled its restore.
  function refresh() { applyState(); hideBanner(); _lastActivity = 'other'; _reevaluate = true; _snoozedActivities.clear(); }
  function init() { applyState(); }

  window.PerfMode = { init, refresh, optimize, restore, answer, onStatus, onActivity, onActivityChange, activity, onGaming, onObs, applyState, defaultApps, effectiveApps };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
