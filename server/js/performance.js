'use strict';
// ─────────────────────────────────────────────────────────────────────────
// Performance Mode controller (Phases 1–4 + customization).
//
// Reads hubSettings.performance (settings.js), applies and reverts REVERSIBLE
// optimizations, drives the activity-aware auto-suggest banner, and shows a
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
// Relies on globals from settings.js (shared <script> lexical scope): hubSettings,
// normalizePerformance, normalizeSettings, saveHubSettings, SERVER, t,
// setSettingsStatus, syncPerformanceControls.
// ─────────────────────────────────────────────────────────────────────────

(function () {
  let _bannerEl = null;
  let _sheetEl = null;
  let _suppressBanner = false; // "don't ask again" for this page session
  let _snoozedActivities = new Set(); // activities snoozed via "Ignore" until a settings change
  let _lastActivity = 'other'; // last foreground activity we reacted to (transition tracking)
  let _lastActivityProcess = ''; // bare process name of the last non-'other' activity (priority target)
  let _lastServerActivity = 'other'; // last raw status payload, so onObs can re-classify
  let _lastProcess = '';
  let _obsStreaming = false;   // live OBS streaming/recording flag (via the obs SSE event)
  let _autoRestoreTimer = null; // pending auto-restore once an auto session's activity ends
  let _sheetWindows = [];      // windows listed on the open sheet (for choice learning)
  let _sheetStats = null;      // process stats snapshot behind the open sheet (for impact)

  // Built-in trigger apps per activity (bare process names, lowercase). Gaming is
  // primarily detected full-screen server-side; this list is for windowed titles
  // the user adds. The user can extend or trim each list from Settings.
  const DEFAULT_ACTIVITY_APPS = {
    gaming: [],
    coding: ['code', 'code-insiders', 'cursor', 'devenv', 'idea64', 'pycharm64', 'webstorm64', 'rider64', 'clion64', 'goland64', 'rubymine64', 'phpstorm64', 'datagrip64', 'rustrover64', 'studio64', 'sublime_text', 'atom', 'nvim', 'vim'],
    writing: ['winword', 'notepad', 'notepad++', 'obsidian', 'onenote', 'wps', 'wpsoffice', 'soffice', 'swriter', 'typora', 'scrivener', 'joplin'],
    streaming: ['obs64', 'obs32', 'streamlabs obs', 'xsplit.core', 'vmix64', 'vmix'],
    creating: ['photoshop', 'illustrator', 'afterfx', 'adobe premiere pro', 'blender', 'resolve', 'unity', 'unrealeditor', 'cinema 4d', 'krita', 'gimp', 'figma', 'lightroom', 'capcut'],
    meeting: ['teams', 'ms-teams', 'zoom', 'webex', 'skype'],
  };

  const PERF_BANNER_KEYS = {
    gaming: 'perf_banner_msg',
    coding: 'perf_banner_msg_coding',
    writing: 'perf_banner_msg_writing',
    streaming: 'perf_banner_msg_streaming',
    creating: 'perf_banner_msg_creating',
    meeting: 'perf_banner_msg_meeting',
  };

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

  const tr = (key, fallback) => (typeof t === 'function' && t(key)) || fallback;

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
    return (DEFAULT_ACTIVITY_APPS[activity] || []).slice();
  }

  // Effective trigger list for an activity: defaults minus the user's removals,
  // plus the user's additions.
  function effectiveApps(activity) {
    const cfg = (currentPerf().activityApps || {})[activity] || { add: [], remove: [] };
    const removed = new Set(cfg.remove);
    const set = new Set(defaultApps(activity).filter(n => !removed.has(n)));
    for (const n of cfg.add) set.add(n);
    return [...set];
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

  // Reflect the persisted "active" state onto the DOM. Safe to call repeatedly.
  function applyState() {
    const p = currentPerf();
    document.body.classList.toggle('perf-mode', p.active && p.applied.pauseAnimations);
  }

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
    const provider = hubSettings.aiProvider === 'ollama' ? 'ollama' : 'gemini';
    return provider === 'ollama' || !!String(hubSettings.geminiApiKey || '').trim();
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

  function _procKey(name) {
    return String(name || '').toLowerCase().trim().replace(/\.exe$/, '');
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
          provider: hubSettings.aiProvider === 'ollama' ? 'ollama' : 'gemini',
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
    let appliedPlan = 'none';

    if (eff.powerPlan && eff.powerPlan !== 'none') {
      try {
        const cur = await powerPlan('GET');
        const saved = (cur && cur.ok && cur.guid) ? cur.guid : '';
        const set = await powerPlan('POST', eff.powerPlan);
        if (set && set.ok) { appliedPlan = eff.powerPlan; persist({ active: true, savedPowerPlan: saved, applied: { pauseAnimations: !!eff.pauseAnimations, powerPlan: appliedPlan } }); }
        else { ok = false; persist({ active: true, applied: { pauseAnimations: !!eff.pauseAnimations, powerPlan: 'none' } }); }
      } catch { ok = false; persist({ active: true, applied: { pauseAnimations: !!eff.pauseAnimations, powerPlan: 'none' } }); }
    } else {
      persist({ active: true, applied: { pauseAnimations: !!eff.pauseAnimations, powerPlan: 'none' } });
    }

    // Reversible priority nudge for the detected activity app.
    if (eff.priorityBoost && _lastActivityProcess) {
      try {
        const r = await perfAction({ type: 'setPriority', name: _lastActivityProcess, level: 'high' });
        if (r && r.ok) persist({ applied: { boostedProc: _lastActivityProcess } });
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
    let text = tr(ok ? 'perf_status_optimized' : 'perf_status_failed', ok ? 'Performance optimized' : 'Optimization failed');
    if (ok && by === 'auto' && meta && meta.activity) {
      const label = tr('settings_perf_act_' + meta.activity, meta.activity);
      text = tr('perf_auto_on', 'Auto-optimized for {a}').replace('{a}', label);
    }
    if (ok && freedMB >= 100) {
      text += ' · ' + tr('perf_freed_ram', '~{x} of RAM freed').replace('{x}', _fmtMB(freedMB));
    }
    _perfToastText(text, ok ? 'ok' : 'error');
  }

  // meta: { auto: true } when an ended auto session restores itself.
  async function restore(meta) {
    _cancelAutoRestore();
    const p = currentPerf();
    if (p.savedPowerPlan) {
      try { await powerPlan('POST', p.savedPowerPlan); } catch { /* best effort */ }
    }
    if (p.applied.boostedProc) {
      try { await perfAction({ type: 'setPriority', name: p.applied.boostedProc, level: 'normal' }); } catch { /* best effort */ }
    }
    for (const a of p.closedApps) {
      try { await perfAction({ type: 'launchApp', path: a.path }); } catch { /* ignore */ }
    }
    persist({ active: false, activatedBy: '', autoActivity: '', savedPowerPlan: '', closedApps: [], applied: { pauseAnimations: false, powerPlan: 'none', boostedProc: '' } });
    applyState();
    if (typeof syncPerformanceControls === 'function') syncPerformanceControls();
    if (typeof setSettingsStatus === 'function') setSettingsStatus('perf_status_restored', 'ok');
    _perfToast(meta && meta.auto ? 'perf_auto_off' : 'perf_status_restored', 'ok');
  }

  // ── Auto mode: apply on activity start, restore when it ends ──────
  async function _autoApply(activity) {
    const p = currentPerf();
    // Safe, reversible tweaks only — closing apps always goes through the sheet.
    const effective = {
      pauseAnimations: p.opts.pauseAnimations,
      powerPlan: p.opts.powerPlan,
      priorityBoost: p.opts.priorityBoost && !!_lastActivityProcess,
    };
    await applyOptimizations(effective, [], { by: 'auto', activity });
  }

  function _scheduleAutoRestore() {
    if (_autoRestoreTimer) return;
    _autoRestoreTimer = setTimeout(async () => {
      _autoRestoreTimer = null;
      const p = currentPerf();
      const cur = _lastActivity;
      const stillEnabled = cur !== 'other' && p.autoActivities && p.autoActivities[cur];
      if (p.active && p.activatedBy === 'auto' && !stillEnabled) await restore({ auto: true });
    }, AUTO_RESTORE_DELAY_MS);
  }

  function _cancelAutoRestore() {
    if (_autoRestoreTimer) { clearTimeout(_autoRestoreTimer); _autoRestoreTimer = null; }
  }

  // ── Confirmation sheet ───────────────────────────────────────────
  function buildSheet() {
    const overlay = document.createElement('div');
    overlay.className = 'perf-sheet-overlay';
    overlay.hidden = true;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSheet(); });

    const card = document.createElement('div');
    card.className = 'perf-sheet';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    overlay.appendChild(card);

    const title = document.createElement('h3');
    title.className = 'perf-sheet-title';
    title.textContent = tr('perf_sheet_title', 'Performance optimization');
    card.appendChild(title);

    const intro = document.createElement('p');
    intro.className = 'perf-sheet-intro';
    intro.textContent = tr('perf_sheet_intro', 'Choose what to optimize (everything is reversible):');
    card.appendChild(intro);

    // Per-run optimization toggles (pre-set from the saved options).
    const opts = document.createElement('div');
    opts.className = 'perf-sheet-opts';
    opts.appendChild(_optRow('pauseAnimations', tr('perf_act_pauseanim', 'Pause animations and animated backgrounds'), tr('perf_act_pauseanim_tag', 'Dashboard')));
    opts.appendChild(_optRow('powerPlan', tr('perf_act_powerplan', 'High-performance power plan'), tr('perf_act_powerplan_tag', 'System · reversible')));
    const prio = _optRow('priorityBoost', tr('perf_act_priority', 'Boost the active app’s priority'), tr('perf_act_powerplan_tag', 'System · reversible'));
    prio.classList.add('perf-sheet-opt-priority');
    opts.appendChild(prio);
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

    const hint = document.createElement('p');
    hint.className = 'perf-sheet-hint';
    hint.textContent = tr('perf_sheet_restore_hint', 'You can undo everything from Settings → Performance.');
    card.appendChild(hint);

    const actions = document.createElement('div');
    actions.className = 'perf-sheet-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'perf-btn perf-btn-ghost';
    cancel.textContent = tr('perf_sheet_cancel', 'Cancel');
    cancel.addEventListener('click', closeSheet);
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'perf-btn perf-btn-primary';
    apply.textContent = tr('perf_sheet_apply', 'Apply');
    apply.addEventListener('click', () => {
      const effective = collectEffective();
      const selected = collectSelectedApps();
      _recordChoices(selected); // learn which apps this user keeps vs closes
      closeSheet();
      applyOptimizations(effective, selected, { by: 'manual' });
    });
    actions.appendChild(cancel);
    actions.appendChild(apply);
    card.appendChild(actions);

    document.body.appendChild(overlay);
    return overlay;
  }

  function _optRow(opt, label, tag) {
    const row = document.createElement('label');
    row.className = 'perf-sheet-opt';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.opt = opt;
    const name = document.createElement('span');
    name.className = 'perf-sheet-opt-label';
    name.textContent = label;
    const t2 = document.createElement('span');
    t2.className = 'perf-sheet-item-tag';
    t2.textContent = tag;
    row.appendChild(cb);
    row.appendChild(name);
    row.appendChild(t2);
    return row;
  }

  function closeSheet() { if (_sheetEl) _sheetEl.hidden = true; }

  function collectEffective() {
    const p = currentPerf();
    const pa = _sheetEl && _sheetEl.querySelector('[data-opt="pauseAnimations"]');
    const pp = _sheetEl && _sheetEl.querySelector('[data-opt="powerPlan"]');
    const prioRow = _sheetEl && _sheetEl.querySelector('.perf-sheet-opt-priority');
    const prioCb = _sheetEl && _sheetEl.querySelector('[data-opt="priorityBoost"]');
    const powerPlan = (pp && pp.checked) ? (p.opts.powerPlan !== 'none' ? p.opts.powerPlan : 'high') : 'none';
    const priorityBoost = !!(prioCb && prioCb.checked && prioRow && !prioRow.hidden);
    return { pauseAnimations: !!(pa && pa.checked), powerPlan, priorityBoost };
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
      const s = stats && stats.byProc[proc];
      if (s && s.memMB >= 50) {
        const mem = document.createElement('span');
        mem.className = 'perf-sheet-app-mem';
        mem.textContent = _fmtMB(s.memMB);
        label.appendChild(mem);
      }
      label.appendChild(ttl);
      li.appendChild(label);
      appsList.appendChild(li);
    }
  }

  // Open the chooser. Always available (manual / System-panel / voice): the sheet
  // itself lets the user pick what to apply. When app management is on and AI is
  // available, the AI pre-selects apps and explains the plan.
  async function optimize() {
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
    const [windows, stats] = await Promise.all([
      p.opts.manageApps ? fetchWindows() : Promise.resolve([]),
      p.opts.manageApps ? fetchStats() : Promise.resolve(null),
    ]);
    _sheetWindows = windows;
    _sheetStats = stats;
    let plan = null;
    let activity = 'other';
    if (p.opts.manageApps && windows.length) {
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
    if (prioRow) prioRow.hidden = !_lastActivityProcess;
    if (prioCb) prioCb.checked = p.opts.priorityBoost && !!_lastActivityProcess;

    const intro = _sheetEl.querySelector('.perf-sheet-intro');
    if (intro) {
      intro.textContent = (plan && plan.explanation)
        ? ('✦ ' + plan.explanation)
        : tr('perf_sheet_intro', 'Choose what to optimize (everything is reversible):');
      intro.classList.toggle('perf-sheet-ai', !!(plan && plan.explanation));
    }

    const appsWrap = _sheetEl.querySelector('.perf-sheet-apps');
    const appsList = _sheetEl.querySelector('.perf-sheet-apps-list');
    if (p.opts.manageApps) {
      appsWrap.hidden = false;
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
    _sheetEl.hidden = false;
  }

  // ── Auto-suggest banner ──────────────────────────────────────────
  function buildBanner() {
    const el = document.createElement('div');
    el.className = 'perf-banner';
    el.setAttribute('role', 'status');
    el.hidden = true;

    const msg = document.createElement('span');
    msg.className = 'perf-banner-msg';
    msg.textContent = tr('perf_banner_msg', 'Optimize performance?');
    el.appendChild(msg);

    const mkBtn = (cls, label, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'perf-btn ' + cls;
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    };
    el.appendChild(mkBtn('perf-btn-primary', tr('perf_banner_optimize', 'Optimize'), () => { hideBanner(); optimize(); }));
    el.appendChild(mkBtn('perf-btn-ghost', tr('perf_banner_ignore', 'Ignore'), () => { _snoozedActivities.add(_lastActivity); hideBanner(); }));
    el.appendChild(mkBtn('perf-btn-ghost', tr('perf_banner_never', "Don't ask again"), () => {
      _suppressBanner = true;
      persist({ autoSuggest: false });
      if (typeof syncPerformanceControls === 'function') syncPerformanceControls();
      hideBanner();
    }));

    document.body.appendChild(el);
    return el;
  }

  function _bannerMessageFor(activity) {
    return tr(PERF_BANNER_KEYS[activity] || 'perf_banner_msg', 'Optimize performance?');
  }

  function showBanner(activity) {
    if (!_bannerEl) _bannerEl = buildBanner();
    const msg = _bannerEl.querySelector('.perf-banner-msg');
    if (msg) msg.textContent = _bannerMessageFor(activity);
    _bannerEl.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => _bannerEl.classList.add('visible')));
  }

  function hideBanner() {
    if (!_bannerEl) return;
    _bannerEl.classList.remove('visible');
    setTimeout(() => { if (_bannerEl) _bannerEl.hidden = true; }, 350);
  }

  // Brief completion toast (visible anywhere, not just in the Settings modal) so
  // the user clearly sees that an optimize/restore finished.
  function _perfToast(messageKey, kind) {
    _perfToastText(tr(messageKey, ''), kind);
  }

  function _perfToastText(text, kind) {
    const el = document.createElement('div');
    el.className = 'perf-toast' + (kind === 'error' ? ' error' : '');
    el.setAttribute('role', 'status');
    el.textContent = text;
    document.body.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('visible')));
    setTimeout(() => { el.classList.remove('visible'); setTimeout(() => el.remove(), 400); }, 2600);
  }

  // React to a (classified) activity transition. In 'suggest' mode this shows
  // the banner; in 'auto' mode it applies the safe tweaks directly. Auto
  // sessions also retire themselves: when their activity ends (and no other
  // enabled one took over), everything is restored after a grace period.
  function _react(a) {
    if (a === _lastActivity) return;
    _lastActivity = a;
    const p = currentPerf();
    const suggestible = a !== 'other' && p.autoActivities && p.autoActivities[a];

    if (p.active && p.activatedBy === 'auto') {
      if (suggestible) _cancelAutoRestore();
      else _scheduleAutoRestore();
    }

    if (!suggestible) { hideBanner(); return; }
    if (!p.enabled || p.active || _suppressBanner || _snoozedActivities.has(a)) return;
    if (p.autoMode === 'auto') { _autoApply(a); return; }
    if (!p.autoSuggest) return;
    showBanner(a);
  }

  // Preferred entry: classify the live status (activity + foreground process)
  // through the user's custom lists, then react.
  function onStatus(serverActivity, process) {
    _lastServerActivity = serverActivity;
    _lastProcess = process;
    const a = classify(process, serverActivity);
    const p = String(process || '').toLowerCase().replace(/\.exe$/, '');
    if (a !== 'other' && p) _lastActivityProcess = p; // remember the app to boost
    _react(a);
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
  function refresh() { applyState(); _lastActivity = 'other'; _snoozedActivities.clear(); }
  function init() { applyState(); }

  window.PerfMode = { init, refresh, optimize, restore, onStatus, onActivity, onGaming, onObs, applyState, defaultApps, effectiveApps };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
