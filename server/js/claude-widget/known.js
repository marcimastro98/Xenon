// What the Claude tile knows while the page runs, and the questions the rest of the tile asks of
// it: the sessions and the runs, the one a reply goes to, what is attached, which sections are
// folded.
'use strict';

(() => {
  const { t } = window.ClaudeWidgetWords;

  const widgetState = {
    payload: null,       // { usage, live, budget, tile } — null until seeded
    editing: false,      // budget editor open?
    customOpen: false,   // custom-budget input revealed inside the editor
    linking: false,      // link/unlink request in flight
    linkState: null,     // GET /api/claude/link result
    linkPanel: false,    // link panel open?
    ticker: null,        // 1s interval, only while something counts down
    pressing: false,     // a pointer is down on the widget (see onSSE)
    pressTimer: 0,
    renderDeferred: false,
    payloadAt: undefined, // given its first value further down, where it was declared
    collapsed: null,
    // The dashboard starts a real Claude Code run. Two things make that safe to
    // put behind a button: the project comes from a server-side list (the client
    // sends an id, never a path), and the run uses Claude Code's normal permission
    // mode — so every command and every file write comes back here as a card the
    // user has to approve. Xenon starts the work; it does not grant it anything.
    askProjects: null,      // null = not loaded yet, [] = none found
    askProjectId: '',
    askText: '',
    askBusy: false,
    askError: '',
    askResumeId: '',        // set when continuing an existing session
    askResumeLabel: '',
    askModel: '',           // '' = whatever the project's own config picks
    askRunMode: '',         // '' = the user's own default permission mode
    askEffort: '',          // '' = the model's default effort
    // What this Claude Code accepts for a run, read from its --help on the server.
    askOptions: { effort: false, modes: [] },
    askAttach: [],          // [{ name, path, size }] — server-written files
    askAttachBusy: false,
    lastStates: new Map(),           // session id → last state seen
  };

  function live() { return (widgetState.payload && widgetState.payload.live) || null; }

  function limits() { const l = live(); return (l && l.limits) || null; }

  // Bridge sessions when Claude Code is linked (exact state), transcript-derived
  // sessions otherwise (recency heuristic). Never both — mixing an exact list
  // with a guessed one would double-count the same session.
  function sessions() {
    const l = live();
    if (l && l.sessions && l.sessions.length) return l.sessions;
    const u = widgetState.payload && widgetState.payload.usage;
    if (!u || !u.sessions) return [];
    return u.sessions.map(s => ({ ...s, state: 'running', inferred: true }));
  }

  function aged(msAtSend) { return Math.max(0, (Number(msAtSend) || 0) + (Date.now() - widgetState.payloadAt)); }

  // Has any session posted a statusline yet? With Claude Code linked, the quota
  // arrives on those posts; before the first one there is nothing to show YET,
  // which is different from an API-key account that has no windows at all.
  function statusSeen() {
    return sessions().some((s) => typeof s.contextPct === 'number' || typeof s.cost === 'number');
  }

  // The 30-day chart and the project bars are reference, not live state: useful
  // to open, not worth the vertical space all the time. Collapsing one hands its
  // height to the session list, which is the part that actually changes and the
  // part that runs out of room first. The choice is per-surface and survives a
  // reload; it is a view preference, so it lives in localStorage rather than
  // adding another writer to the settings store.
  const COLLAPSE_KEY = 'xeneonedge.claude.collapsed.v1';
  const COLLAPSE_KEYS = ['spark', 'projects', 'finished', 'rail', 'aside'];
  // Sections that start closed. Finished sessions are kept so they can be
  // reopened later, which is the opposite of wanting them in the way: the
  // heading says how many there are, and one tap unfolds them.
  const COLLAPSED_BY_DEFAULT = { finished: true };

  function readCollapsed() {
    if (widgetState.collapsed) return widgetState.collapsed;
    widgetState.collapsed = { ...COLLAPSED_BY_DEFAULT };
    try {
      const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
      if (raw && typeof raw === 'object') {
        // An explicit stored value wins in BOTH directions, so a section opened
        // by hand does not snap shut on the next paint.
        for (const k of COLLAPSE_KEYS) if (typeof raw[k] === 'boolean') widgetState.collapsed[k] = raw[k];
      }
    } catch { /* unreadable or absent → the defaults above */ }
    return widgetState.collapsed;
  }

  function isCollapsed(key) { return readCollapsed()[key] === true; }

  function runs() { return (widgetState.payload && Array.isArray(widgetState.payload.runs)) ? widgetState.payload.runs : []; }

  // A session row knows its project only by folder NAME, which is a hint and not
  // an identity: two checkouts can share a basename. For a resume the server
  // resolves the folder from the session itself, so a miss here is left as an
  // empty id for the server to fill rather than an error on screen — refusing up
  // front was wrong, and it refused every session whose name simply differed.
  function resolveAskProject() {
    if (!widgetState.askProjects || !widgetState.askProjects.length) return;
    if (widgetState.askResumeId) {
      const match = widgetState.askResumeLabel
        ? widgetState.askProjects.find(p => p.name === widgetState.askResumeLabel)
        : null;
      widgetState.askProjectId = match ? match.id : '';
      return;
    }
    if (!widgetState.askProjectId) widgetState.askProjectId = widgetState.askProjects[0].id;
  }

  function sessionById(id) { return id ? (sessions().find((s) => s.id === id) || null) : null; }

  function clearAttach() {
    widgetState.askAttach.forEach((a) => { if (a.preview) URL.revokeObjectURL(a.preview); });
    widgetState.askAttach = [];
  }

  // The prompt Claude actually receives: what was typed, then the paths, said
  // plainly enough that a model reads them as things to open.
  function promptWithAttachments(text) {
    if (!widgetState.askAttach.length) return text;
    const lines = widgetState.askAttach.map(a => a.path);
    return text + '\n\nAttached files on this PC (read them):\n' + lines.join('\n');
  }

  // Which of the things writing here will do. A session mid-turn takes the
  // follow-up path — the text lands in THAT conversation when the turn ends. An
  // idle one with the Xenon mod listening takes it as a new turn, there, as if
  // it were typed in it. Any other idle one has no turn left to end, so nothing
  // could deliver it, and it is continued as a resumed run instead. Same
  // conversation every time; the composer says which before you press send,
  // rather than one box that quietly behaves as any of them.
  function replyMode() {
    if (!widgetState.askResumeId) return 'new';
    const s = sessions().find((x) => x.id === widgetState.askResumeId);
    // A chat the terminal has closed (or one opened from the Chats face) is
    // still on disk, and `claude --resume` continues it in the background.
    if (!s || s.ended) return 'resume';
    // A session only the registry file shows is not wired to the hooks, so a
    // follow-up could never be delivered into it.
    if (s.inferred || s.unlinked) return 'none';
    if (s.queued) return 'queued';
    if (s.state === 'running' || s.state === 'waiting') return 'followup';
    return s.terminal ? 'terminal' : 'resume';
  }

  // A resume is always a second process. While the session is still open in a
  // terminal without the mod listening, that terminal never sees the exchange,
  // so the note says where the reply will be.
  function resumeNote() {
    const s = sessionById(widgetState.askResumeId);
    return s && !s.ended
      ? t('claude_resume_note_open', 'The terminal is idle, so Claude replies here and not in the terminal')
      : t('claude_resume_note', 'Continues this conversation in the background');
  }

  // The tail of the session's own transcript. Read-only, and deliberately just
  // the conversation: tool calls are already approval cards, and repeating them
  // here would bury the two lines that say where the session got to.
  // The session being written to, when it is one we still know about.
  function askSession() {
    return sessions().find(s => s.id === widgetState.askResumeId) || null;
  }

  function inLiveSession() { const m = replyMode(); return m === 'terminal' || m === 'followup'; }

  // The commands need a mod that can run them (0.4.0); an older one would send them as plain messages.
  function canRunCommands() { const s = sessionById(widgetState.askResumeId); return !!(s && s.modCommands); }

  function titles() { return (widgetState.payload && widgetState.payload.titles) || {}; }

  function runsFor(id) {
    return runs().filter((r) => (id ? r.sessionId === id : (!r.sessionId || !sessionById(r.sessionId))));
  }

  function currentPlanKey() {
    const b = widgetState.payload && widgetState.payload.budget;
    if (!b) return 'auto';
    if (b.weeklyTokenBudget > 0) return 'custom';
    if (b.plan === 'pro' || b.plan === 'max5' || b.plan === 'max20') return b.plan;
    return 'auto';
  }

  function stopTicker() {
    if (!widgetState.ticker) return;
    clearInterval(widgetState.ticker); widgetState.ticker = null;
  }

  window.ClaudeWidgetKnown = {
    widgetState, live, limits, sessions, aged, statusSeen, COLLAPSE_KEY, readCollapsed, isCollapsed,
    runs, resolveAskProject, sessionById, clearAttach, promptWithAttachments, replyMode, resumeNote,
    askSession, inLiveSession, canRunCommands, titles, runsFor, currentPlanKey, stopTicker,
  };
})();
