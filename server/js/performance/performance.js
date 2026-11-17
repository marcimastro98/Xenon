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
// saveHubSettings, setSettingsStatus, syncPerformanceControls (settings.js and settings/*.js),
// normalizePerformance (perf-settings.js), SERVER, t.
//
// "Widgets only" has no dashboard: its hidden driver page runs this same file
// (js/performance/driver-perf.js) and sets window.PerfModeSurface, which takes over what
// the dashboard draws itself. The suggestion and the result become cards in the
// on-screen alerts window, and Optimize applies the safe tweaks without the
// sheet (closing apps is a choice only the sheet offers).
// ─────────────────────────────────────────────────────────────────────────

(function () {
  let _closeBanner = null;
  const {
    state, tr, surface, windowsLevers, closesApps, _procKey, _boostTarget, _fmtMB, _cancelAutoRestore,
    _busyNow, _activityListeners, onActivityChange, activity,
  } = window.PerformanceSessionState;
  let _sheetLetGo = null;

  const {
    currentPerf, persist, defaultApps, effectiveApps, classify, deterministicPreselect,
    _recordChoices,
  } = window.PerformanceAppChoice;
  const {
    applyState, restore, _scheduleAutoRestore, _expediteAutoRestore, _checkStale,
  } = window.PerformanceSessionEnd;


  const { _optRow, renderApps, _perfNote } = window.PerformanceDrawn;

  const { powerPlan, perfAction } = window.PerformancePcRequests;

  const { aiAvailable, fetchPlan } = window.PerformanceAiPlan;

  const { fetchWindows, fetchStats, fetchShield, fetchActivity } = window.PerformanceReadings;

  const { savedEffective, collectEffective, collectSelectedApps } = window.PerformanceChosenTweaks;

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
