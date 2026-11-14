// The saved Performance Mode settings, which activity a process counts as, and which open apps are
// ticked for closing when no AI plan says so.
'use strict';

(() => {
  const { state, _procKey } = window.PerformanceSessionState;

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
    if (state._obsStreaming) return 'streaming';
    return 'other';
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
    if (!state._sheetWindows.length) return;
    const chosen = new Set(selected.map(a => _procKey(a.name)));
    const next = { ...currentPerf().appChoices };
    for (const w of state._sheetWindows) {
      const proc = _procKey(w.app);
      if (!proc) continue;
      const c = next[proc] || { kept: 0, closed: 0 };
      next[proc] = chosen.has(proc)
        ? { kept: c.kept, closed: Math.min(99, c.closed + 1) }
        : { kept: Math.min(99, c.kept + 1), closed: c.closed };
    }
    persist({ appChoices: next });
  }

  window.PerformanceAppChoice = {
    currentPerf, persist, defaultApps, effectiveApps, classify, deterministicPreselect, learnedBias,
    _recordChoices,
  };
})();
