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
  const {
    state, tr, surface, nobodyLooking, windowsLevers, closesApps, _procKey, _boostTarget, _fmtMB,
    _cancelAutoRestore, _idleEligible, _busyNow, _activityListeners, onActivityChange, activity,
  } = window.PerformanceSessionState;
  let _sheetLetGo = null;

  const {
    currentPerf, persist, defaultApps, effectiveApps, classify, deterministicPreselect, learnedBias,
    _recordChoices,
  } = window.PerformanceAppChoice;
  const AUTO_RESTORE_DELAY_MS = 45000; // grace before an auto session restores (alt-tab safe)
  const AUTO_RESTORE_QUICK_MS = 4000;  // the game actually CLOSED — restore promptly


  // ── Activity classification (defaults + user customization) ───────
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
    if (sig === state._stateSig) return;
    state._stateSig = sig;
    // Guarded: the widgets-only driver page and the tests run this without one.
    if (typeof CustomEvent === 'function' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('xenon:perf-change', { detail: { active: !!p.active } }));
    }
  }

  const { _syncSystemButtons, _optRow, renderApps, _perfNote } = window.PerformanceDrawn;

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

  const { fetchWindows, fetchStats, fetchShield, fetchActivity } = window.PerformanceReadings;

  // The tweaks that need no choice, for a session with no sheet: what the user saved.
  function savedEffective(p) {
    return {
      pauseAnimations: p.opts.pauseAnimations,
      powerPlan: p.opts.powerPlan,
      priorityBoost: p.opts.priorityBoost && !!_boostTarget(),
      shield: p.opts.shield,
    };
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
            const s = state._sheetStats && state._sheetStats.byProc[_procKey(r.app || a.name)];
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

  // A Deck key, a keyboard shortcut or a widget: the safe tweaks the user saved,
  // with no sheet (closing apps always asks first), or the restore. 'toggle'
  // follows the session's own state, so a second press always undoes the first.
  async function quick(mode) {
    const on = currentPerf().active;
    const want = mode === 'toggle' ? !on : mode === 'on';
    if (want === on) return;
    if (want) await applyOptimizations(savedEffective(currentPerf()), [], { by: 'manual' });
    else await restore();
  }

  // ── Auto mode: apply on activity start, restore when it ends ──────
  async function _autoApply(activity) {
    // Safe, reversible tweaks only — closing apps always goes through the sheet.
    await applyOptimizations(savedEffective(currentPerf()), [], { by: 'auto', activity });
  }

  function _scheduleAutoRestore(delayMs = AUTO_RESTORE_DELAY_MS) {
    if (state._autoRestoreTimer) return;
    state._autoRestoreTimer = setTimeout(async () => {
      state._autoRestoreTimer = null;
      const p = currentPerf();
      const cur = state._lastActivity;
      const stillEnabled = cur !== 'other' && p.autoActivities && p.autoActivities[cur];
      if (p.active && p.activatedBy === 'auto' && !stillEnabled) await restore({ auto: true });
    }, delayMs);
  }

  // The long restore grace exists for Alt-Tab: the game is still alive and the
  // user is probably coming back. When the game process is actually GONE,
  // sitting out the rest of it just leaves Performance Mode on for no reason —
  // reschedule the pending restore to fire promptly instead.
  function _expediteAutoRestore() {
    if (!state._autoRestoreTimer) return;
    clearTimeout(state._autoRestoreTimer);
    state._autoRestoreTimer = null;
    _scheduleAutoRestore(AUTO_RESTORE_QUICK_MS);
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
      if (state._staleRecheck) return;
      state._staleRecheck = setTimeout(() => { state._staleRecheck = null; _checkStale(true); }, STALE_RECHECK_MS);
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
    if (want && !state._stalePoll) {
      // Gated on the tab being visible, like every other periodic client work:
      // with nobody looking, a session ending a few minutes later costs nothing.
      const tick = () => { if (!nobodyLooking()) _checkStale(false); };
      setTimeout(tick, STALE_FIRST_MS);
      state._stalePoll = setInterval(tick, STALE_POLL_MS);
    } else if (!want && state._stalePoll) {
      clearInterval(state._stalePoll);
      state._stalePoll = null;
      if (state._staleRecheck) { clearTimeout(state._staleRecheck); state._staleRecheck = null; }
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

  async function _idleTick() {
    const p = currentPerf();
    if (!_idleEligible(p)) return;
    if (_busyNow(p)) { state._idleSince = 0; return; }
    const now = Date.now();
    if (!state._idleSince) { state._idleSince = now; return; }
    // A surface nobody is looking at leaves this to the one that is: restore()
    // relaunches closed apps, and two surfaces doing it at once would do it twice.
    if (nobodyLooking()) return;
    if (now - state._idleSince < IDLE_END_MS) return;
    state._idleSince = 0;
    await restore({ auto: true });   // toasts, so it is never a silent change
  }

  function _syncIdleWatch() {
    const want = _idleEligible(currentPerf());
    if (want && !state._idleTimer) {
      state._idleSince = 0;
      state._idleTimer = setInterval(() => { _idleTick().catch(() => {}); }, IDLE_TICK_MS);
      _idleTick().catch(() => {});
    } else if (!want && state._idleTimer) {
      clearInterval(state._idleTimer);
      state._idleTimer = null;
      state._idleSince = 0;
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
      applyOptimizations(effective, selected, state._sheetMeta);
    });
    actions.appendChild(cancel);
    actions.appendChild(apply);
    card.appendChild(actions);

    document.body.appendChild(overlay);
    return overlay;
  }

  function openSheet() {
    if (_sheetLetGo) return;
    state._sheetEl.hidden = false;
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('perf-sheet', true);
    _sheetLetGo = window.DialogFocus.hold(state._sheetEl, { start: state._sheetEl.querySelector('.perf-btn-primary'), onEsc: dismissSheet });
  }

  function closeSheet() {
    if (!state._sheetEl || state._sheetEl.hidden) return;
    state._sheetEl.hidden = true;
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('perf-sheet', false);
    _sheetLetGo();
    _sheetLetGo = null;
  }

  // Dismissing an auto-opened sheet (Cancel / click-outside) means "not now" for
  // this activity: snooze it for the session so re-focusing the same app/game
  // doesn't keep re-opening the sheet. Applying instead goes through closeSheet
  // (no snooze), so auto mode still re-optimizes on the next, fresh session.
  function dismissSheet() {
    if (state._sheetMeta && state._sheetMeta.by === 'auto' && state._sheetMeta.activity) {
      state._snoozedActivities.add(state._sheetMeta.activity);
    }
    closeSheet();
  }

  function collectEffective() {
    const p = currentPerf();
    const pa = state._sheetEl && state._sheetEl.querySelector('[data-opt="pauseAnimations"]');
    const pp = state._sheetEl && state._sheetEl.querySelector('[data-opt="powerPlan"]');
    const prioRow = state._sheetEl && state._sheetEl.querySelector('.perf-sheet-opt-priority');
    const prioCb = state._sheetEl && state._sheetEl.querySelector('[data-opt="priorityBoost"]');
    const shieldRow = state._sheetEl && state._sheetEl.querySelector('.perf-sheet-opt-shield');
    const shieldCb = state._sheetEl && state._sheetEl.querySelector('[data-opt="shield"]');
    const powerPlan = (pp && pp.checked) ? (p.opts.powerPlan !== 'none' ? p.opts.powerPlan : 'high') : 'none';
    const priorityBoost = !!(prioCb && prioCb.checked && prioRow && !prioRow.hidden);
    const shield = !!(shieldCb && shieldCb.checked && shieldRow && !shieldRow.hidden);
    return { pauseAnimations: !!(pa && pa.checked), powerPlan, priorityBoost, shield };
  }

  function collectSelectedApps() {
    if (!state._sheetEl) return [];
    const checks = state._sheetEl.querySelectorAll('.perf-sheet-apps-list input[type="checkbox"]:checked');
    return Array.from(checks).map(c => ({ id: c.dataset.id, name: c.dataset.name }));
  }

  // Open the chooser. Always available (manual / System-panel / voice): the sheet
  // itself lets the user pick what to apply. When app management is on and AI is
  // available, the AI pre-selects apps and explains the plan.
  // meta: undefined / { by:'manual' } for user-triggered runs, or { by:'auto',
  // activity } when an automatic-mode session opens the sheet so its Apply still
  // tags the session 'auto' (and it auto-restores when the activity ends).
  async function optimize(meta) {
    state._sheetMeta = (meta && meta.by === 'auto') ? { by: 'auto', activity: meta.activity || 'other' } : { by: 'manual' };
    // No dashboard, no sheet: the safe, reversible tweaks the user saved.
    if (surface()) {
      const p = currentPerf();
      if (p.active) return;
      await applyOptimizations(savedEffective(p), [], state._sheetMeta);
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
    state._sheetWindows = windows;
    state._sheetStats = stats;
    let plan = null;
    let activity = 'other';
    if (closesApps(p) && windows.length) {
      activity = await fetchActivity();
      if (aiAvailable(p)) {
        if (typeof setSettingsStatus === 'function') setSettingsStatus('perf_status_planning', 'ok');
        plan = await fetchPlan(p, activity, windows.map(w => w.app));
      }
    }

    if (!state._sheetEl) state._sheetEl = buildSheet();

    // Pre-set the option toggles from the saved defaults.
    const pa = state._sheetEl.querySelector('[data-opt="pauseAnimations"]');
    const pp = state._sheetEl.querySelector('[data-opt="powerPlan"]');
    if (pa) pa.checked = p.opts.pauseAnimations;
    if (pp) pp.checked = p.opts.powerPlan !== 'none';
    // Priority boost only makes sense when we know which app to boost; show that
    // row only when an activity app has been detected this session.
    const prioRow = state._sheetEl.querySelector('.perf-sheet-opt-priority');
    const prioCb = state._sheetEl.querySelector('[data-opt="priorityBoost"]');
    if (prioRow) prioRow.hidden = !_boostTarget();
    if (prioCb) prioCb.checked = p.opts.priorityBoost && !!_boostTarget();
    // Core Shield needs enough cores and the OS tool for it, so the server says.
    const canShield = !!(shield && shield.available);
    const shieldRow = state._sheetEl.querySelector('.perf-sheet-opt-shield');
    const shieldCb = state._sheetEl.querySelector('[data-opt="shield"]');
    if (shieldRow) shieldRow.hidden = !canShield;
    if (shieldCb) shieldCb.checked = p.opts.shield && canShield;

    const intro = state._sheetEl.querySelector('.perf-sheet-intro');
    intro.textContent = (plan && plan.explanation) || '';
    intro.hidden = !intro.textContent;

    const appsWrap = state._sheetEl.querySelector('.perf-sheet-apps');
    const appsList = state._sheetEl.querySelector('.perf-sheet-apps-list');
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
    if (choice === 'ignore') { state._snoozedActivities.add(state._lastActivity); hideBanner(); return undefined; }
    if (choice === 'never') {
      state._suppressBanner = true;
      persist({ autoSuggest: false });
      if (typeof syncPerformanceControls === 'function') syncPerformanceControls();
      hideBanner();
    }
    return undefined;
  }

  function showBanner(activity) {
    const s = surface();
    if (s) { state._suggesting = true; s.suggest(activity); return; }
    hideBanner();
    const parts = window.AlertToasts.perfPrompt(activity, { t: tr }, answer);
    if (parts) _closeBanner = window.XenonBitCard.ask(parts, { bit: window.XenonReleaseNotes.bit });
  }

  function hideBanner() {
    const s = surface();
    if (s) { if (state._suggesting) { state._suggesting = false; s.hide(); } return; }
    if (!_closeBanner) return;
    _closeBanner();
    _closeBanner = null;
  }

  function _react(a) {
    const changed = a !== state._lastActivity;
    if (!changed && !state._reevaluate) return;
    state._reevaluate = false;
    state._lastActivity = a;
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
    if (!p.enabled || p.active || state._suppressBanner || state._snoozedActivities.has(a)) return;
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
    state._snoozedActivities.add(a);
    showBanner(a);
  }

  // Preferred entry: classify the live status (activity + foreground process)
  // through the user's custom lists, then react.
  function onStatus(serverActivity, process, gameRunning, gameProcess) {
    state._lastServerActivity = serverActivity;
    state._lastProcess = process;
    const wasGameRunning = state._gameRunning;
    if (typeof gameRunning === 'boolean') state._gameRunning = gameRunning;
    state._gameProcess = _procKey(gameProcess);
    const a = classify(process, serverActivity);
    const p = String(process || '').toLowerCase().replace(/\.exe$/, '');
    if (a !== 'other' && p) state._lastActivityProcess = p; // remember the app to boost
    _react(a);
    // Game process died (as opposed to just losing focus): any pending
    // auto-restore can stop waiting out the Alt-Tab grace, and a session that
    // was started FOR that app — including a manual one, which has no other way
    // to end — starts counting its way out.
    if (wasGameRunning && !state._gameRunning) { state._snoozedActivities.delete('gaming'); _expediteAutoRestore(); _checkStale(false); }
    // A game or opted-in activity between two idle ticks still counts as busy.
    if (state._idleTimer && _busyNow(currentPerf())) state._idleSince = 0;
  }

  // Live OBS state (obs SSE event): going on-air counts as a streaming session
  // even when the focus sits on an untracked window, so re-classify on change.
  function onObs(d) {
    const now = !!(d && (d.obsStreaming || d.obsRecording));
    if (now === state._obsStreaming) return;
    state._obsStreaming = now;
    _react(classify(state._lastProcess, state._lastServerActivity));
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
  function refresh() { applyState(); hideBanner(); state._lastActivity = 'other'; state._reevaluate = true; state._snoozedActivities.clear(); }
  function init() { applyState(); }

  window.PerfMode = { init, refresh, optimize, restore, quick, answer, onStatus, onActivity, onActivityChange, activity, onGaming, onObs, applyState, defaultApps, effectiveApps };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
