'use strict';
// Claude Code widget. Three bands, in order of what you need from across the room:
//
//   1. QUOTA — the real subscription windows (5-hour and 7-day) as horizontal
//      bars with a countdown to their reset. These come from Claude Code itself
//      via the statusline bridge; when it isn't linked (or the user is on an API
//      key, which has no windows) the band falls back to the user-set weekly
//      token budget it always had.
//   2. LIVE — one row per running session: project, what it's doing, which model,
//      and its actual state (running / waiting for you / idle) reported by hooks
//      rather than guessed from file timestamps.
//   3. TOTALS — today, this week, cache hit rate. Quiet, tabular, last.
//
// On top of all that sits the APPROVAL card: Claude Code blocks on a permission
// request and the user answers it here. An unanswered request escalates to a
// fullscreen overlay, because a tool call waiting on a tap nobody noticed is
// worse than an interruption.
//
// Every string here is filesystem- or Claude-derived and renders through
// textContent / the el() factory — never innerHTML.
(function () {
  const el = makeEl;        // shared DOM factory (utils.js)
  const api = apiJson;      // fetch → JSON, null on failure (utils.js)
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  let payload = null;       // { usage, live, budget, tile } — null until seeded
  let seeded = false, seedInflight = false;
  let editing = false;      // budget editor open?
  let customOpen = false;   // custom-budget input revealed inside the editor
  let linking = false;      // link/unlink request in flight
  let linkState = null;     // GET /api/claude/link result
  let linkPanel = false;    // link panel open?
  const deciding = new Set(); // approval ids with a decision in flight
  let ticker = null;        // 1s interval, only while something counts down
  let overlay = null;       // fullscreen approval overlay element

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="claude"]')).filter(n => n.closest('.pager-page'));
  }

  // ── model → hue. Encodes which model produced the work, not decoration. ──
  const MODEL_COLORS = Object.freeze({ opus: '#D97757', fable: '#A98BE0', mythos: '#A98BE0', sonnet: '#3FB9C4', haiku: '#79C267' });
  function modelHue(model) {
    const m = String(model || '');
    for (const key in MODEL_COLORS) if (m.indexOf('claude-' + key) === 0 || m.indexOf(key) === 0) return MODEL_COLORS[key];
    return 'var(--accent)';
  }
  function shortModel(model) {
    return String(model || '').replace(/^claude-/, '').replace(/-\d{6,}$/, '') || 'unknown';
  }

  // ── formatting ──
  function hTok(n) {
    n = Math.max(0, Math.round(n || 0));
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e11 ? 0 : 2).replace(/\.0+$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(n);
  }
  function hCost(n) {
    n = Math.max(0, n || 0);
    if (n >= 1000) return '$' + Math.round(n).toLocaleString();
    if (n >= 10) return '$' + n.toFixed(0);
    return '$' + n.toFixed(n >= 1 ? 1 : 2);
  }
  function ago(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    if (s < 60) return s + 's';
    const m = Math.round(s / 60); if (m < 60) return m + 'm';
    const h = Math.round(m / 60); if (h < 24) return h + 'h';
    return Math.round(h / 24) + 'g';
  }
  // Countdown to an absolute epoch-seconds instant, coarse on purpose: the exact
  // second only matters in the last minute.
  function until(epochSec) {
    const ms = (Number(epochSec) || 0) * 1000 - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h' + (m % 60 ? String(m % 60).padStart(2, '0') : '');
    const d = Math.floor(h / 24);
    return d + 'g' + (h % 24 ? String(h % 24) + 'h' : '');
  }
  function mmss(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    const m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function live() { return (payload && payload.live) || null; }
  function limits() { const l = live(); return (l && l.limits) || null; }

  // ── what this widget is allowed to put in front of you ─────────────────────
  // Both surfaces below appear OUTSIDE the tile — the approval cards escalate to
  // a fullscreen overlay and the topbar marker sits in the clock island — so they
  // show up even when the widget isn't on the current page. That is deliberate
  // (a blocked tool call must stay answerable), but it has to be the user's
  // choice, so each is a switch in Settings → Claude Code. Defaults stay on.
  function cfg() {
    return (typeof hubSettings === 'object' && hubSettings && hubSettings.claudeWidget) || null;
  }
  function approvalsOn() { const c = cfg(); return !c || c.approvals !== false; }
  function topbarOn() { const c = cfg(); return !c || c.topbar !== false; }

  // With approvals off there is nothing to show, nothing to escalate and nothing
  // for the topbar to call urgent — one gate covers all three. The server also
  // answers the hook immediately in that case, so the prompt is already back in
  // the terminal by the time this runs.
  function approvals() {
    if (!approvalsOn()) return [];
    const l = live();
    return (l && l.approvals) || [];
  }

  // Bridge sessions when Claude Code is linked (exact state), transcript-derived
  // sessions otherwise (recency heuristic). Never both — mixing an exact list
  // with a guessed one would double-count the same session.
  function sessions() {
    const l = live();
    if (l && l.sessions && l.sessions.length) return l.sessions;
    const u = payload && payload.usage;
    if (!u || !u.sessions) return [];
    return u.sessions.map(s => ({ ...s, state: 'running', inferred: true }));
  }

  // ── quota band ─────────────────────────────────────────────────────────────
  // Bar and number both read USED, the same way Claude's own usage page does
  // (claude.ai → Impostazioni → Utilizzo → "3% utilizzato"). They used to
  // disagree: the bar filled with what was consumed while the number beside it
  // showed what was left, so a 3%-full bar sat next to "97%" and the widget
  // looked broken against the figures Claude itself reports. Colour crosses to
  // warn/critical near the ceiling.
  function limitBar(key, label, win) {
    const row = el('div', 'cw-lim');
    row.appendChild(el('span', 'cw-lim-key', label));

    const track = el('div', 'cw-lim-track');
    const used = Math.max(0, Math.min(100, Number(win.pct) || 0));
    const fill = el('div', 'cw-lim-fill');
    fill.style.width = used + '%';
    if (used >= 90) fill.classList.add('is-critical');
    else if (used >= 70) fill.classList.add('is-warn');
    track.appendChild(fill);
    row.appendChild(track);

    const val = el('span', 'cw-lim-val', Math.round(used) + '%');
    if (used >= 90) val.classList.add('is-critical');
    else if (used >= 70) val.classList.add('is-warn');
    row.appendChild(val);

    const reset = el('span', 'cw-lim-reset');
    reset.dataset.resetAt = String(win.resetsAt || 0);
    reset.textContent = win.resetsAt ? until(win.resetsAt) : '';
    row.appendChild(reset);
    return row;
  }

  function quotaBand() {
    const lim = limits();
    const band = el('div', 'cw-quota');

    if (lim && (lim.fiveHour || lim.sevenDay)) {
      const head = el('div', 'cw-quota-head');
      head.appendChild(el('span', 'cw-quota-title', t('claude_quota', 'Quota')));
      head.appendChild(el('span', 'cw-quota-hint', t('claude_quota_used', 'used · resets in')));
      band.appendChild(head);
      if (lim.fiveHour) band.appendChild(limitBar('5h', t('claude_5h', '5h'), lim.fiveHour));
      if (lim.sevenDay) band.appendChild(limitBar('7d', t('claude_7d', '7d'), lim.sevenDay));
      return band;
    }

    // No real windows: either not linked, or an API-key user who has none. Fall
    // back to the weekly token budget, and say plainly which one is on screen.
    const u = payload && payload.usage;
    const b = payload && payload.budget;
    const week = u ? u.week.tokens : 0;
    const weekly = b ? b.weekly : 0;

    const head = el('div', 'cw-quota-head');
    head.appendChild(el('span', 'cw-quota-title', t('claude_budget_band', 'Weekly budget')));
    const btn = el('button', 'cw-quota-edit'); btn.type = 'button';
    btn.textContent = weekly > 0 ? t('claude_edit', 'edit') : t('claude_set_budget_short', 'set');
    btn.addEventListener('click', openBudget);
    head.appendChild(btn);
    band.appendChild(head);

    const row = el('div', 'cw-lim');
    row.appendChild(el('span', 'cw-lim-key', t('claude_week_short', 'wk')));
    const track = el('div', 'cw-lim-track');
    const used = weekly > 0 ? Math.max(0, Math.min(100, (week / weekly) * 100)) : 0;
    const fill = el('div', 'cw-lim-fill');
    fill.style.width = (weekly > 0 ? used : 0) + '%';
    if (used >= 90) fill.classList.add('is-critical');
    else if (used >= 70) fill.classList.add('is-warn');
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('span', 'cw-lim-val', weekly > 0 ? Math.round(used) + '%' : hTok(week)));
    // With a budget set, the trailing slot says how many tokens are still under
    // it — the useful half of "38% used" when the ceiling is one you typed in.
    row.appendChild(el('span', 'cw-lim-reset', weekly > 0 ? hTok(Math.max(0, weekly - week)) + ' ' + t('claude_left_short', 'left') : ''));
    band.appendChild(row);
    return band;
  }

  // ── approvals ──────────────────────────────────────────────────────────────
  const STATE_LABEL = {
    running: () => t('claude_state_running', 'working'),
    waiting: () => t('claude_state_waiting', 'waiting for you'),
    idle: () => t('claude_state_idle', 'idle'),
  };

  async function decide(id, behavior) {
    if (deciding.has(id)) return;
    deciding.add(id);
    paint();
    const d = await api('/api/claude/decide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, behavior }),
    });
    deciding.delete(id);
    if (!d || !d.ok) {
      // Expired, or answered on another surface. Say so — a silent no-op here
      // reads as a broken button.
      if (window.XenonToast) window.XenonToast.show({ type: 'warn', title: t('claude_decide_late', 'That request is no longer waiting') });
    }
    // The SSE push repaints with the request gone; drop it locally meanwhile so
    // the card can't be tapped twice.
    const l = live();
    if (l && l.approvals) l.approvals = l.approvals.filter(a => a.id !== id);
    paint();
  }

  // What Claude is about to do, in the words the user needs: the plain-language
  // intent as the headline, the literal argument underneath as evidence. The
  // tool NAME alone ("Bash") tells a non-developer nothing.
  const TOOL_INTENT = {
    Bash: () => t('claude_intent_bash', 'Run a command'),
    Write: () => t('claude_intent_write', 'Create a file'),
    Edit: () => t('claude_intent_edit', 'Change a file'),
    NotebookEdit: () => t('claude_intent_edit', 'Change a file'),
    Read: () => t('claude_intent_read', 'Read a file'),
    Glob: () => t('claude_intent_search', 'Search the project'),
    Grep: () => t('claude_intent_search', 'Search the project'),
    WebFetch: () => t('claude_intent_web', 'Open a web page'),
    WebSearch: () => t('claude_intent_websearch', 'Search the web'),
    Agent: () => t('claude_intent_agent', 'Start a sub-agent'),
    Task: () => t('claude_intent_agent', 'Start a sub-agent'),
    KillShell: () => t('claude_intent_kill', 'Stop a running command'),
    AskUserQuestion: () => t('claude_intent_ask', 'Ask you a question'),
  };
  function toolIntent(tool) {
    const f = TOOL_INTENT[tool];
    return f ? f() : (tool || 'tool');
  }

  // AskUserQuestion is not a permission and is no longer treated as one: the
  // server answers it immediately so Claude's own prompt reaches the terminal,
  // and this card is only a heads-up that you are being asked something. It
  // shows the question and the options for real, and says where to answer —
  // here it cannot be answered, because a hook cannot supply a tool's result.
  function questionBody(a) {
    const wrap = el('div', 'cw-appr-qs');
    a.questions.forEach((q) => {
      const box = el('div', 'cw-appr-q');
      if (q.header) box.appendChild(el('div', 'cw-appr-qhead', q.header));
      box.appendChild(el('div', 'cw-appr-qtext', q.question));
      if (q.options && q.options.length) {
        const list = el('ul', 'cw-appr-qopts');
        q.options.forEach((o) => {
          const li = el('li', 'cw-appr-qopt');
          li.appendChild(el('span', 'cw-appr-qopt-label', o.label));
          if (o.description) li.appendChild(el('span', 'cw-appr-qopt-desc', o.description));
          list.appendChild(li);
        });
        box.appendChild(list);
      }
      wrap.appendChild(box);
    });
    wrap.appendChild(el('div', 'cw-appr-qnote',
      t('claude_ask_answer_where', 'Answer in the terminal — Claude is waiting for you there.')));
    return wrap;
  }

  function approvalCard(a, big) {
    const isAsk = !!(a.questions && a.questions.length);
    const card = el('div', 'cw-appr'
      + (big ? ' cw-appr--big' : '')
      + (a.urgent ? ' is-urgent' : '')
      + (isAsk ? ' is-ask' : ''));

    const head = el('div', 'cw-appr-head');
    head.appendChild(el('span', 'cw-appr-badge',
      isAsk ? t('claude_question', 'Question') : t('claude_permission', 'Permission')));
    if (a.project) head.appendChild(el('span', 'cw-appr-proj', a.project));
    const left = el('span', 'cw-appr-timer');
    left.dataset.expiresAt = String(Date.now() + (a.expiresInMs || 0));
    left.textContent = mmss(a.expiresInMs);
    head.appendChild(left);
    card.appendChild(head);

    // Everything between the header and the buttons goes in one scrollable box.
    // Without it a card taller than the tile (or than a short display, for the
    // fullscreen one) was simply cut off — and what got cut was the bottom,
    // which is where Allow and Deny live. Now the card can only ever lose the
    // MIDDLE, which scrolls, and the two things you must be able to see — what
    // is being asked and the buttons that answer it — always stay on screen.
    const body = el('div', 'cw-appr-body');
    const intent = el('div', 'cw-appr-tool', toolIntent(a.tool));
    intent.appendChild(el('span', 'cw-appr-toolname', a.tool || ''));
    body.appendChild(intent);

    if (isAsk) body.appendChild(questionBody(a));
    else if (a.detail) body.appendChild(el('div', 'cw-appr-detail', a.detail));
    card.appendChild(body);

    const busy = deciding.has(a.id);
    const acts = el('div', 'cw-appr-acts');
    // A notice settles nothing, so it gets one button that means "seen" and no
    // Allow/Deny pair — offering a choice over something already decided is how
    // the old card got read as "tap to answer the question", which it never was.
    if (a.notice) {
      const ok = el('button', 'cw-appr-ok'); ok.type = 'button';
      ok.textContent = t('claude_ask_dismiss', 'Got it');
      ok.disabled = busy;
      ok.addEventListener('click', () => decide(a.id, 'allow'));
      acts.appendChild(ok);
    } else {
      const allow = el('button', 'cw-appr-allow'); allow.type = 'button';
      allow.textContent = t('claude_allow', 'Allow');
      allow.disabled = busy;
      allow.addEventListener('click', () => decide(a.id, 'allow'));
      const deny = el('button', 'cw-appr-deny'); deny.type = 'button';
      deny.textContent = t('claude_deny', 'Deny');
      deny.disabled = busy;
      deny.addEventListener('click', () => decide(a.id, 'deny'));
      acts.appendChild(allow);
      acts.appendChild(deny);
    }
    card.appendChild(acts);
    return card;
  }

  // The escalation: an urgent request takes the whole display. Rendered outside
  // the tile so it works even when the widget isn't on the current page.
  function syncOverlay() {
    const urgent = approvals().filter(a => a.urgent)[0];
    if (!urgent) { closeOverlay(); return; }
    if (!overlay) {
      overlay = el('div', 'cw-overlay');
      document.body.appendChild(overlay);
    }
    overlay.replaceChildren(approvalCard(urgent, true));
  }
  function closeOverlay() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
  }

  // ── live sessions ──────────────────────────────────────────────────────────
  // Two sessions in the same folder are the normal case, not an edge one, and
  // the project name alone then names both of them. A short slice of the session
  // id is added ONLY to the rows that would otherwise be ambiguous, so the list
  // stays clean when there is nothing to disambiguate. The same tag is shown in
  // the panel header, which is what lets you tell which row you opened.
  function sessionTag(s) {
    const same = sessions().filter(x => (x.project || '') === (s.project || ''));
    return (same.length > 1 && s.id) ? s.id.slice(0, 4) : '';
  }

  function sessionRow(s) {
    const state = s.state || 'running';
    const row = el('div', 'cw-sess is-' + state);
    // Tapping a row sends it a follow-up. Only once linked (the panel starts a
    // real run) and only with a session id to resume — an inferred row read off
    // the transcripts has no id Claude Code would accept.
    if (linkState && linkState.linked && s.id) {
      row.classList.add('is-tappable');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      const open = () => openAsk(s.id, s.project || '', '');
      row.title = (s.project || '') + (sessionTag(s) ? ' #' + sessionTag(s) : '');
      row.addEventListener('click', open);
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
      });
    }
    row.appendChild(el('span', 'cw-sess-dot'));

    const main = el('div', 'cw-sess-main');
    const top = el('div', 'cw-sess-top');
    top.appendChild(el('span', 'cw-sess-proj', s.project || '?'));
    const tag = sessionTag(s);
    if (tag) top.appendChild(el('span', 'cw-sess-tag', '#' + tag));
    if (s.branch) top.appendChild(el('span', 'cw-sess-branch', s.branch));
    main.appendChild(top);

    // Second line: what it's actually doing. A running tool name beats the
    // prompt text — it's the more current fact.
    const sub = el('div', 'cw-sess-sub');
    if (state === 'waiting') sub.appendChild(el('span', 'cw-sess-state', STATE_LABEL.waiting()));
    else if (s.tool) sub.appendChild(el('span', 'cw-sess-tool', s.tool));
    else if (s.task) sub.appendChild(el('span', 'cw-sess-task', s.task));
    else sub.appendChild(el('span', 'cw-sess-state', (STATE_LABEL[state] || STATE_LABEL.idle)()));
    main.appendChild(sub);
    row.appendChild(main);

    const meta = el('div', 'cw-sess-meta');
    if (s.model) {
      const chip = el('span', 'cw-model-chip');
      chip.style.setProperty('--m', modelHue(s.model));
      chip.textContent = shortModel(s.model);
      meta.appendChild(chip);
    }
    if (typeof s.contextPct === 'number') meta.appendChild(el('span', 'cw-sess-ctx', t('claude_ctx', 'ctx') + ' ' + Math.round(s.contextPct) + '%'));
    meta.appendChild(el('span', 'cw-sess-age', ago(s.ageMs)));
    row.appendChild(meta);
    return row;
  }

  function liveBand() {
    const band = el('div', 'cw-live');
    const list = sessions();

    // Sessions that have gone quiet are the ones you come back to, so they are
    // kept and filed rather than dropped. Splitting them out means a morning's
    // worth of finished work cannot crowd out the one session actually running.
    const active = list.filter(s => !s.resting);
    const resting = list.filter(s => s.resting);

    const head = el('div', 'cw-band-head');
    head.appendChild(el('span', 'cw-band-title', t('claude_sessions', 'Sessions')));
    if (active.length) head.appendChild(el('span', 'cw-band-hint', active.length + ' ' + t('claude_running', 'running')));
    // Start work from here. Only offered once Claude Code is linked: without the
    // hooks a run's permission prompts would land in a terminal the user is not
    // looking at, which is the opposite of the point.
    if (linkState && linkState.linked) {
      const ask = el('button', 'cw-ask-open'); ask.type = 'button';
      ask.textContent = t('claude_ask_open', 'Ask');
      ask.addEventListener('click', () => openAsk('', '', ''));
      head.appendChild(ask);
    }
    band.appendChild(head);

    if (!list.length) {
      const u = payload && payload.usage;
      const empty = el('div', 'cw-sess is-idle');
      empty.appendChild(el('span', 'cw-sess-dot'));
      const main = el('div', 'cw-sess-main');
      main.appendChild(el('div', 'cw-sess-top', t('claude_no_sessions', 'No session running')));
      if (u && u.live && u.live.at) main.appendChild(el('div', 'cw-sess-sub', t('claude_last_active', 'last active') + ' ' + ago(u.live.ageMs)));
      empty.appendChild(main);
      band.appendChild(empty);
      return band;
    }
    // The rows live in their own scroller so a long list absorbs whatever height
    // the collapsed sections gave back, instead of pushing the totals off the
    // tile or being cut mid-row. The cap is a safety valve, not a display limit:
    // scrolling is what shows the rest.
    const scroller = el('div', 'cw-sess-scroll');
    active.slice(0, 20).forEach(s => scroller.appendChild(sessionRow(s)));

    if (resting.length) {
      const key = 'finished';
      scroller.appendChild(collapsibleTitle(key,
        t('claude_sess_finished', 'Finished'),
        String(resting.length)));
      if (!isCollapsed(key)) resting.slice(0, 20).forEach(s => scroller.appendChild(sessionRow(s)));
    }
    band.appendChild(scroller);
    return band;
  }

  // ── totals ─────────────────────────────────────────────────────────────────
  function totalsBand(u) {
    const band = el('div', 'cw-totals');
    const add = (label, value, accent) => {
      const cell = el('div', 'cw-total' + (accent ? ' is-accent' : ''));
      cell.appendChild(el('span', 'cw-total-val', value));
      cell.appendChild(el('span', 'cw-total-key', label));
      band.appendChild(cell);
    };
    add(t('claude_today', 'today'), hTok(u.today.tokens));
    add(t('claude_week', 'this week'), hTok(u.week.tokens));
    add(t('claude_cache', 'cache'), Math.round((u.cacheHitRate || 0) * 100) + '%');
    add(t('claude_api_value', 'API value'), hCost(u.total.cost), true);
    return band;
  }

  // ── lower detail (revealed by container queries on a tall tile) ────────────
  // The 30-day chart and the project bars are reference, not live state: useful
  // to open, not worth the vertical space all the time. Collapsing one hands its
  // height to the session list, which is the part that actually changes and the
  // part that runs out of room first. The choice is per-surface and survives a
  // reload; it is a view preference, so it lives in localStorage rather than
  // adding another writer to the settings store.
  const COLLAPSE_KEY = 'xeneonedge.claude.collapsed.v1';
  const COLLAPSE_KEYS = ['spark', 'projects', 'finished'];
  // Sections that start closed. Finished sessions are kept so they can be
  // reopened later, which is the opposite of wanting them in the way: the
  // heading says how many there are, and one tap unfolds them.
  const COLLAPSED_BY_DEFAULT = { finished: true };
  let collapsed = null;

  function readCollapsed() {
    if (collapsed) return collapsed;
    collapsed = { ...COLLAPSED_BY_DEFAULT };
    try {
      const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
      if (raw && typeof raw === 'object') {
        // An explicit stored value wins in BOTH directions, so a section opened
        // by hand does not snap shut on the next paint.
        for (const k of COLLAPSE_KEYS) if (typeof raw[k] === 'boolean') collapsed[k] = raw[k];
      }
    } catch { /* unreadable or absent → the defaults above */ }
    return collapsed;
  }
  function isCollapsed(key) { return readCollapsed()[key] === true; }
  function toggleCollapsed(key) {
    const c = readCollapsed();
    c[key] = !c[key];
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(c)); } catch { /* private mode: session-only */ }
    paint();
  }

  // A section head that opens and closes. A real <button> so it is reachable by
  // keyboard and announced as a control, with the chevron carrying the state.
  function collapsibleTitle(key, text, hint) {
    const open = !isCollapsed(key);
    const b = el('button', 'cw-section cw-section-btn'); b.type = 'button';
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    const chev = el('span', 'cw-section-chev' + (open ? ' is-open' : ''));
    chev.textContent = '›';                 // › rotated by CSS when open
    b.appendChild(chev);
    b.appendChild(el('span', 'cw-section-t', text));
    if (hint) b.appendChild(el('span', 'cw-section-hint', hint));
    b.addEventListener('click', () => toggleCollapsed(key));
    return b;
  }

  function sparks(u) {
    const wrap = el('div', 'cw-spark');
    wrap.appendChild(collapsibleTitle('spark', t('claude_last30', 'Last 30 days'), t('claude_cache_legend', 'cache · fresh')));
    if (isCollapsed('spark')) return wrap;
    const chart = el('div', 'cw-spark-bars');
    const max = u.daily.reduce((m, d) => Math.max(m, d.tokens), 0) || 1;
    const todayIdx = u.daily.length - 1;
    u.daily.forEach((d, i) => {
      const col = el('div', 'cw-bar' + (i === todayIdx ? ' is-today' : ''));
      col.title = d.day + ' · ' + hTok(d.tokens);
      const h = d.tokens > 0 ? Math.max(3, Math.round((d.tokens / max) * 100)) : 0;
      const cacheFrac = d.tokens > 0 ? Math.max(0, Math.min(1, d.cacheRead / d.tokens)) : 0;
      const stack = el('div', 'cw-bar-stack'); stack.style.height = h + '%';
      const cache = el('div', 'cw-bar-cache'); cache.style.height = Math.round(cacheFrac * 100) + '%';
      stack.appendChild(cache);
      col.appendChild(stack);
      chart.appendChild(col);
    });
    wrap.appendChild(chart);
    return wrap;
  }

  function projectBars(u) {
    if (!u.projects.length) return null;
    const wrap = el('div', 'cw-projects');
    wrap.appendChild(collapsibleTitle('projects', t('claude_projects', 'Projects'), ''));
    if (isCollapsed('projects')) return wrap;
    const total = u.projects.reduce((s, p) => s + p.tokens, 0) || 1;
    const top = u.projects[0].tokens || 1;
    u.projects.slice(0, 5).forEach(p => {
      const row = el('div', 'cw-proj');
      row.appendChild(el('span', 'cw-proj-name', p.name));
      const track = el('div', 'cw-proj-track');
      const bar = el('div', 'cw-proj-bar'); bar.style.width = Math.max(4, Math.round((p.tokens / top) * 100)) + '%';
      track.appendChild(bar);
      row.appendChild(track);
      row.appendChild(el('span', 'cw-proj-val', Math.round((p.tokens / total) * 100) + '%'));
      wrap.appendChild(row);
    });
    return wrap;
  }

  function modelSplit(u) {
    if (!u.models.length) return null;
    const wrap = el('div', 'cw-models');
    const total = u.models.reduce((s, m) => s + m.tokens, 0) || 1;
    const bar = el('div', 'cw-model-bar');
    u.models.forEach(m => {
      if (m.tokens <= 0) return;
      const seg = el('div', 'cw-model-seg');
      seg.style.width = (m.tokens / total * 100) + '%';
      seg.style.background = modelHue(m.model);
      seg.title = shortModel(m.model) + ' · ' + hTok(m.tokens);
      bar.appendChild(seg);
    });
    wrap.appendChild(bar);
    const legend = el('div', 'cw-model-legend');
    u.models.slice(0, 4).forEach(m => {
      if (m.tokens <= 0) return;
      const it = el('span', 'cw-model-leg');
      const dot = el('span', 'cw-model-legdot'); dot.style.background = modelHue(m.model);
      it.appendChild(dot);
      it.appendChild(el('span', 'cw-model-legname', shortModel(m.model)));
      it.appendChild(el('span', 'cw-model-legval', hTok(m.tokens)));
      legend.appendChild(it);
    });
    wrap.appendChild(legend);
    return wrap;
  }

  // ── link panel ─────────────────────────────────────────────────────────────
  // Connecting writes hooks + a statusline into the user's Claude Code
  // settings.json. That is someone else's config file, so the panel says exactly
  // what happens, and disconnecting is one tap away.
  async function loadLinkState() {
    const d = await api('/api/claude/link');
    if (d) linkState = d;
    paint();
  }
  async function doLink(on) {
    if (linking) return;
    linking = true; paint();
    const d = await api(on ? '/api/claude/link' : '/api/claude/unlink', { method: 'POST' });
    linking = false;
    if (d && d.ok) {
      linkState = d;
      linkPanel = false;
      if (window.XenonToast) {
        window.XenonToast.show({
          type: 'ok',
          title: on ? t('claude_linked', 'Claude Code connected') : t('claude_unlinked', 'Claude Code disconnected'),
          body: on ? t('claude_linked_body', 'Restart any running Claude Code session to pick it up.') : '',
        });
      }
    } else if (window.XenonToast) {
      window.XenonToast.show({ type: 'error', title: t('claude_link_fail', 'Could not update Claude Code settings') });
    }
    paint();
  }

  function linkButton() {
    const linked = !!(linkState && linkState.linked);
    const b = el('button', 'cw-linkbtn' + (linked ? ' is-on' : '')); b.type = 'button';
    b.textContent = linked ? t('claude_connected', 'Connected') : t('claude_connect', 'Connect Claude Code');
    b.addEventListener('click', () => { linkPanel = true; paint(); });
    return b;
  }

  function linkPanelView() {
    const wrap = el('div', 'cw-panel');
    const head = el('div', 'cw-panel-head');
    head.appendChild(el('div', 'cw-panel-title', t('claude_link_title', 'Connect Claude Code')));
    const close = el('button', 'cw-panel-close'); close.type = 'button';
    close.setAttribute('aria-label', t('back', 'Back'));
    close.textContent = '✕';
    close.addEventListener('click', () => { linkPanel = false; paint(); });
    head.appendChild(close);
    wrap.appendChild(head);

    const linked = !!(linkState && linkState.linked);
    wrap.appendChild(el('div', 'cw-panel-body', linked
      ? t('claude_link_on_desc', 'Claude Code reports its real quota, live session state and permission requests to this dashboard.')
      : t('claude_link_off_desc', 'Adds hooks and a status line to your Claude Code settings. Unlocks the real 5-hour and 7-day quota, exact session state, and approving permission requests from this screen.')));

    const notes = el('ul', 'cw-panel-notes');
    const note = (text) => { const li = el('li', 'cw-panel-note', text); notes.appendChild(li); };
    note(t('claude_link_note_backup', 'Your settings.json is backed up before the first change.'));
    if (linkState && linkState.chained) note(t('claude_link_note_chain', 'Your existing status line keeps running.'));
    note(t('claude_link_note_restart', 'Sessions already open need a restart to report.'));
    wrap.appendChild(notes);

    const acts = el('div', 'cw-panel-acts');
    const go = el('button', 'cw-panel-go' + (linked ? ' is-off' : '')); go.type = 'button';
    go.disabled = linking;
    go.textContent = linking
      ? t('claude_working', 'Working…')
      : (linked ? t('claude_disconnect', 'Disconnect') : t('claude_connect_go', 'Connect'));
    go.addEventListener('click', () => doLink(!linked));
    acts.appendChild(go);
    wrap.appendChild(acts);

    if (linkState && linkState.settingsPath) wrap.appendChild(el('div', 'cw-panel-path', linkState.settingsPath));
    return wrap;
  }

  // ── asking Claude from the touchscreen ─────────────────────────────────────
  // The dashboard starts a real Claude Code run. Two things make that safe to
  // put behind a button: the project comes from a server-side list (the client
  // sends an id, never a path), and the run uses Claude Code's normal permission
  // mode — so every command and every file write comes back here as a card the
  // user has to approve. Xenon starts the work; it does not grant it anything.
  let askOpen = false;
  let askProjects = null;      // null = not loaded yet, [] = none found
  let askProjectId = '';
  let askText = '';
  let askBusy = false;
  let askError = '';
  let askResumeId = '';        // set when continuing an existing session
  let askResumeLabel = '';
  let askModel = '';           // '' = whatever the project's own config picks
  let askAttach = [];          // [{ name, path, size }] — server-written files
  let askAttachBusy = false;
  let askThread = null;        // null = not loaded, [] = nothing to show

  // The models to offer are read from what this machine has ACTUALLY used —
  // the model ids in your own transcripts, biggest first. A hard-coded list was
  // wrong in both directions: it left out models you use every day and it would
  // keep offering names long after they stop existing. The CLI's short aliases
  // are kept alongside them, because they are the stable way to say "the current
  // Opus" and they survive a version bump that retires a dated id.
  const ASK_ALIASES = ['opus', 'sonnet', 'haiku'];
  const MAX_ASK_MODELS = 14;
  function askModelOptions() {
    // "Auto" on its own said nothing, but the full explanation belongs in the
    // open list, not in the closed trigger — there it just stretched the control
    // across the bar. The trigger keeps the short word; the list says what it
    // falls back to, which differs: continuing a session keeps that session's
    // model, a new run takes the project's own Claude Code config.
    const out = [{
      id: '',
      label: t('claude_model_auto', 'Auto'),
      note: askResumeId
        ? t('claude_model_auto_session', 'keeps the session model')
        : t('claude_model_auto_project', 'the project default'),
    }];
    ASK_ALIASES.forEach(a => out.push({
      id: a,
      label: a.charAt(0).toUpperCase() + a.slice(1),
      note: t('claude_model_alias_note', 'always the current one'),
    }));
    const u = payload && payload.usage;
    const seen = new Set(out.map(o => o.id));
    ((u && u.models) || []).forEach(m => {
      const id = String(m.model || '');
      // `<synthetic>` and friends are placeholders Claude Code writes for turns
      // that never went to a model. Offering one as a choice would guarantee a
      // failed run.
      if (!id || id === 'unknown' || id.charAt(0) === '<' || seen.has(id)) return;
      seen.add(id);
      out.push({ id, label: shortModel(id) });
    });
    // The selected model must always be in the list, or the dropdown would
    // silently fall back to Auto and start a run on something else.
    if (askModel && !seen.has(askModel)) out.push({ id: askModel, label: shortModel(askModel) });
    return out.slice(0, MAX_ASK_MODELS);
  }

  function runs() { return (payload && Array.isArray(payload.runs)) ? payload.runs : []; }

  async function loadAskProjects(force) {
    const d = await api('/api/claude/projects' + (force ? '?refresh=1' : ''));
    askProjects = (d && Array.isArray(d.projects)) ? d.projects : [];
    resolveAskProject();
    paint();
  }

  // A session row knows its project only by folder NAME, which is a hint and not
  // an identity: two checkouts can share a basename. For a resume the server
  // resolves the folder from the session itself, so a miss here is left as an
  // empty id for the server to fill rather than an error on screen — refusing up
  // front was wrong, and it refused every session whose name simply differed.
  function resolveAskProject() {
    if (!askProjects || !askProjects.length) return;
    if (askResumeId) {
      const match = askResumeLabel
        ? askProjects.find(p => p.name === askResumeLabel)
        : null;
      askProjectId = match ? match.id : '';
      return;
    }
    if (!askProjectId) askProjectId = askProjects[0].id;
  }

  function openAsk(resumeId, resumeLabel, projectId) {
    askOpen = true;
    askError = '';
    askResumeId = resumeId || '';
    askResumeLabel = resumeLabel || '';
    askThread = null;
    if (projectId) askProjectId = projectId;
    if (askProjects !== null) resolveAskProject();
    paint();
    if (askProjects === null) loadAskProjects(false);
    if (askResumeId) { threadAtBottom = true; loadThread(askResumeId); }
    syncThreadPoll();
  }
  function closeAsk() {
    askOpen = false; askError = ''; askResumeId = ''; askResumeLabel = '';
    askThread = null; askAttach = [];
    stopThreadPoll();
    paint();
  }

  // What the session has been saying. Writing a follow-up into a conversation
  // you cannot see is guesswork, and the transcript is right there on disk.
  let threadTimer = null;
  let threadAtBottom = true;      // was the reader parked at the newest turn?
  const THREAD_POLL_MS = 2500;

  async function loadThread(id) {
    const d = await api('/api/claude/transcript?session=' + encodeURIComponent(id));
    // Still the same session? A fast second tap must not paint the wrong thread.
    if (askResumeId !== id) return;
    const next = (d && d.ok && Array.isArray(d.messages)) ? d.messages : [];
    // Repainting an unchanged thread would restart the typing dots and fight the
    // scroll position for nothing.
    const changed = !askThread || askThread.length !== next.length
      || (next.length && askThread[askThread.length - 1].text !== next[next.length - 1].text);
    askThread = next;
    if (changed) paint();
  }

  // While a session is working, new replies land in its transcript on their own.
  // Poll ONLY while the panel is open on a session that is actually running —
  // an idle session writes nothing, so a timer there would be pure waste — and
  // stop the moment either stops being true.
  function syncThreadPoll() {
    const sess = askSession();
    const want = askOpen && !!askResumeId && !!sess && sess.state === 'running';
    if (want && !threadTimer) {
      threadTimer = setInterval(() => {
        if (!askOpen || !askResumeId) { stopThreadPoll(); return; }
        loadThread(askResumeId);
      }, THREAD_POLL_MS);
    } else if (!want && threadTimer) {
      stopThreadPoll();
      // One last read on the way down, so the reply that ended the run is not
      // left sitting on disk unread until the next tap.
      if (askOpen && askResumeId) loadThread(askResumeId);
    }
  }
  function stopThreadPoll() {
    if (threadTimer) { clearInterval(threadTimer); threadTimer = null; }
  }

  // ── attachments ────────────────────────────────────────────────────────────
  // A headless run takes text, so a file becomes a file on disk plus its path in
  // the prompt. Claude reads it with its own Read tool, which means the read
  // comes back here as an approval card: attaching something does not hand it
  // over, it offers it.
  const MAX_ATTACH = 6;

  async function addAttachments(files) {
    if (!files || !files.length) return;
    askAttachBusy = true; askError = ''; paint();
    for (const f of files) {
      if (askAttach.length >= MAX_ATTACH) { askError = t('claude_attach_max', 'That is as many files as one message can carry.'); break; }
      const d = await api('/api/claude/attach?name=' + encodeURIComponent(f.name || 'file'), {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f,
      });
      if (d && d.ok) askAttach.push({ name: d.name, path: d.path, size: d.size });
      else { askError = attachErrorText(d && d.error, f.name); break; }
    }
    askAttachBusy = false; paint();
  }

  function attachErrorText(code, name) {
    const who = name ? String(name) + ': ' : '';
    switch (code) {
      case 'too_big': return who + t('claude_attach_e_big', 'that file is too large (12 MB max).');
      case 'bad_type': return who + t('claude_attach_e_type', 'that kind of file cannot be attached.');
      case 'empty': return who + t('claude_attach_e_empty', 'that file is empty.');
      default: return who + t('claude_attach_e_generic', 'could not be attached.');
    }
  }

  // The prompt Claude actually receives: what was typed, then the paths, said
  // plainly enough that a model reads them as things to open.
  function promptWithAttachments(text) {
    if (!askAttach.length) return text;
    const lines = askAttach.map(a => a.path);
    return text + '\n\nAttached files on this PC (read them):\n' + lines.join('\n');
  }

  async function submitAsk() {
    const prompt = askText.trim();
    if (!prompt || askBusy) return;
    askBusy = true; askError = ''; paint();
    const d = await api('/api/claude/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: askProjectId, prompt: promptWithAttachments(prompt),
        resume: askResumeId, model: askModel,
      }),
    });
    askBusy = false;
    if (d && d.ok) {
      askText = '';
      askAttach = [];
      if (askResumeId) {
        // Sending a follow-up must NOT throw you out of the conversation you are
        // reading — that was the whole point of opening it. Stay put, empty the
        // box, and let the thread poll pick the reply up: what you just sent
        // appears in it as soon as Claude Code writes the turn.
        threadAtBottom = true;
        loadThread(askResumeId);
        syncThreadPoll();
        paint();
      } else {
        // A new run has no conversation to stay in yet; the tile shows its card.
        closeAsk();
      }
    }
    else { askError = runErrorText(d && d.error); paint(); }
  }

  async function stopRun(id) {
    const d = await api('/api/claude/run/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!d || !d.ok) {
      if (window.XenonToast) window.XenonToast.show({ type: 'warn', title: t('claude_run_stop_late', 'That run already finished') });
    }
  }

  // Every refusal the runner can return, said in words. A bare error code on a
  // touchscreen is a dead end — the user cannot open a log to find out more.
  function runErrorText(code) {
    switch (code) {
      case 'claude_not_found': return t('claude_run_e_notfound', 'Claude Code was not found on this PC.');
      case 'too_many_runs': return t('claude_run_e_busy', 'Another run is already going. Wait for it or stop it.');
      case 'unknown_project': return t('claude_run_e_project', 'That project is no longer available.');
      case 'empty_prompt': return t('claude_run_e_empty', 'Write what you want done first.');
      case 'bad_session': return t('claude_run_e_session', 'That session cannot be continued.');
      case 'bad_model': return t('claude_run_e_model', 'That model name was refused.');
      case 'spawn_failed': return t('claude_run_e_spawn', 'Claude Code would not start.');
      default: return t('claude_run_e_generic', 'The run could not be started.');
    }
  }

  // ── markdown, as DOM ───────────────────────────────────────────────────────
  // Claude writes markdown, and showing it raw is how the panel ended up full of
  // asterisks and backticks. This builds NODES rather than an HTML string: every
  // piece of the transcript reaches the page through textContent, so there is no
  // parse step for a crafted tool result or a filename to aim at. It covers what
  // actually turns up in these messages — fenced code, headings, lists, inline
  // code, bold and italic — and anything it does not know stays plain text,
  // which reads fine.
  const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|__[^_]+__|_[^_\n]+_)/;

  function inlineInto(node, text) {
    const parts = String(text).split(INLINE_RE);
    parts.forEach(p => {
      if (!p) return;
      if (p.length > 2 && p.charAt(0) === '`' && p.charAt(p.length - 1) === '`') {
        node.appendChild(el('code', 'cw-md-code', p.slice(1, -1)));
      } else if (p.length > 4 && (p.startsWith('**') || p.startsWith('__'))) {
        node.appendChild(el('strong', '', p.slice(2, -2)));
      } else if (p.length > 2 && (p.charAt(0) === '*' || p.charAt(0) === '_')) {
        node.appendChild(el('em', '', p.slice(1, -1)));
      } else {
        node.appendChild(document.createTextNode(p));
      }
    });
    return node;
  }

  function markdownInto(box, raw) {
    const lines = String(raw || '').split('\n');
    let list = null;
    let fence = null;
    const endList = () => { list = null; };

    lines.forEach(line => {
      const fenceMark = /^\s*```(.*)$/.exec(line);
      if (fenceMark) {
        if (fence) { fence = null; }
        else { endList(); fence = el('pre', 'cw-md-pre'); box.appendChild(fence); }
        return;
      }
      if (fence) {
        fence.appendChild(document.createTextNode((fence.childNodes.length ? '\n' : '') + line));
        return;
      }

      const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        endList();
        box.appendChild(inlineInto(el('div', 'cw-md-h'), heading[2]));
        return;
      }
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const numbered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        if (!list) { list = el('div', 'cw-md-list'); box.appendChild(list); }
        const item = el('div', 'cw-md-li');
        item.appendChild(el('span', 'cw-md-bullet', numbered ? numbered[1] + '.' : '•'));
        // The inline pieces go inside ONE text box, not straight into the item.
        // The item is a flex row, so appending them to it made every <strong>
        // and <code> its own flex COLUMN — which is why a bolded lead-in ended
        // up stacked in a narrow strip beside the rest of its own sentence.
        const body = el('div', 'cw-md-litext');
        inlineInto(body, bullet ? bullet[1] : numbered[2]);
        item.appendChild(body);
        list.appendChild(item);
        return;
      }
      endList();
      if (!line.trim()) return;                    // blank lines become the gap
      box.appendChild(inlineInto(el('div', 'cw-md-p'), line));
    });
    // An unterminated fence still shows its contents rather than swallowing the
    // rest of the message.
    return box;
  }

  // The tail of the session's own transcript. Read-only, and deliberately just
  // the conversation: tool calls are already approval cards, and repeating them
  // here would bury the two lines that say where the session got to.
  // The session being written to, when it is one we still know about.
  function askSession() {
    return sessions().find(s => s.id === askResumeId) || null;
  }

  // "Claude is working" as a bubble at the end of the thread, with the tool it
  // is running right now when there is one. This is what the transcript CANNOT
  // give: it is written a message at a time, so between two replies there is
  // nothing on disk and the panel would just sit there looking finished.
  function typingBubble(sess) {
    const row = el('div', 'cw-msg is-claude is-typing');
    const bubble = el('div', 'cw-msg-bubble');
    bubble.appendChild(el('div', 'cw-msg-who', t('claude_thread_claude', 'Claude')));
    const line = el('div', 'cw-typing');
    const dots = el('span', 'cw-typing-dots');
    for (let i = 0; i < 3; i++) dots.appendChild(el('span', 'cw-typing-dot'));
    line.appendChild(dots);
    line.appendChild(el('span', 'cw-typing-t', sess && sess.tool
      ? sess.tool
      : t('claude_typing', 'is working')));
    bubble.appendChild(line);
    row.appendChild(bubble);
    return row;
  }

  function threadView() {
    const box = el('div', 'cw-thread');
    const sess = askSession();
    const working = !!(sess && sess.state === 'running');
    if (askThread === null) {
      box.appendChild(el('div', 'cw-thread-note', t('claude_thread_loading', 'Reading the conversation…')));
      return box;
    }
    if (!askThread.length) {
      if (working) box.appendChild(typingBubble(sess));
      else box.appendChild(el('div', 'cw-thread-note', t('claude_thread_empty', 'Nothing to show from this session yet.')));
      return box;
    }
    askThread.forEach(m => {
      const mine = m.role === 'user';
      const row = el('div', 'cw-msg is-' + (mine ? 'user' : 'claude'));
      const bubble = el('div', 'cw-msg-bubble');
      bubble.appendChild(el('div', 'cw-msg-who', mine
        ? t('claude_thread_you', 'you')
        : t('claude_thread_claude', 'Claude')));
      const body = el('div', 'cw-msg-text');
      // Your own words are shown as written; Claude's are markdown.
      if (mine) body.textContent = m.text;
      else markdownInto(body, m.text);
      if (m.truncated) body.appendChild(el('div', 'cw-msg-cut', t('claude_thread_cut', 'cut short here')));
      bubble.appendChild(body);
      row.appendChild(bubble);
      box.appendChild(row);
    });
    if (working) box.appendChild(typingBubble(sess));

    // Land on the newest turn — but only when the view was ALREADY at the
    // bottom. The thread now refreshes itself while the session works, and
    // yanking someone back down mid-sentence because a new reply arrived is
    // worse than making them scroll.
    const stick = threadAtBottom !== false;
    requestAnimationFrame(() => { try { if (stick) box.scrollTop = box.scrollHeight; } catch {} });
    box.addEventListener('scroll', () => {
      threadAtBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 40;
    }, { passive: true });
    return box;
  }

  const CLIP_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" '
    + 'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M20 11.5 11.6 20a5 5 0 0 1-7.1-7.1l8.5-8.4a3.4 3.4 0 0 1 4.8 4.8l-8.4 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/></svg>';

  const ATTACH_ACCEPT = 'image/*,.txt,.md,.json,.csv,.log,.yml,.yaml,.xml,.html,.css,.js,.ts,.jsx,.tsx,.py,.rs,.go,.java,.c,.h,.cpp,.sql,.toml,.ini,.diff,.patch,.pdf';

  // Everything you act on lives in one card at the bottom: what you type, what
  // you attach, which model, and the button. Three separate stacked blocks read
  // as three unrelated things, and on a touchscreen the eye has to travel the
  // whole panel to find the one control it wants.
  function composer() {
    const box = el('div', 'cw-composer');

    const ta = document.createElement('textarea');
    ta.className = 'cw-ask-text';
    ta.rows = 3;
    ta.value = askText;
    ta.placeholder = askResumeId
      ? t('claude_ask_placeholder_more', 'Write the follow-up…')
      : t('claude_ask_placeholder', 'What should Claude do?');
    ta.title = t('claude_ask_enter_hint', 'Enter sends, Shift+Enter adds a line');
    ta.maxLength = 4000;
    // Repainting on every keystroke would fight the caret, so the value is only
    // mirrored into state and read back when something else needs it.
    ta.addEventListener('input', () => { askText = ta.value; });
    // Enter sends, Shift+Enter breaks the line — the arrangement every chat box
    // has, and the one that was missing here. `isComposing` is checked because
    // an IME's Enter commits the candidate word and must not also send.
    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      askText = ta.value;
      submitAsk();
    });
    // Paste an image straight in. On a touchscreen this is the difference
    // between "attach a screenshot" being one gesture and being a file hunt.
    ta.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.files) || null;
      if (!items || !items.length) return;
      e.preventDefault();
      askText = ta.value;
      addAttachments(Array.from(items));
    });
    box.appendChild(ta);

    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    input.accept = ATTACH_ACCEPT;
    input.addEventListener('change', () => { askText = ta.value; addAttachments(Array.from(input.files || [])); });
    box.appendChild(input);

    if (askAttach.length) {
      const chips = el('div', 'cw-attach-chips');
      askAttach.forEach((a, i) => {
        const chip = el('div', 'cw-attach-chip');
        chip.appendChild(el('span', 'cw-attach-name', a.name));
        const rm = el('button', 'cw-attach-rm'); rm.type = 'button';
        rm.setAttribute('aria-label', t('claude_attach_remove', 'Remove attachment'));
        rm.textContent = '✕';
        // The file stays on disk; it is pruned with the rest. Deleting it here
        // would mean a delete endpoint taking a path, which is exactly what this
        // design avoids.
        rm.addEventListener('click', () => { askText = ta.value; askAttach.splice(i, 1); paint(); });
        chip.appendChild(rm);
        chips.appendChild(chip);
      });
      box.appendChild(chips);
    }

    const bar = el('div', 'cw-composer-bar');

    const clip = el('button', 'cw-icon-btn'); clip.type = 'button';
    clip.disabled = askAttachBusy || askAttach.length >= MAX_ATTACH;
    clip.title = t('claude_attach_add', 'Attach a file');
    clip.setAttribute('aria-label', t('claude_attach_add', 'Attach a file'));
    // A drawn paperclip rather than the emoji: the emoji renders at whatever
    // size and weight the platform font decides, which is why it sat in the bar
    // looking like a smudge next to a crisp button.
    if (askAttachBusy) clip.textContent = '…';
    else clip.innerHTML = CLIP_SVG;      // static, trusted markup
    clip.addEventListener('click', () => { askText = ta.value; input.click(); });
    bar.appendChild(clip);

    // The model sits with the composer rather than behind a settings screen:
    // picking a cheaper model for a small job is a per-run decision. It uses the
    // app's own dropdown, not a native one, so a long list stays inside the
    // display instead of falling off the bottom of the Xeneon Edge.
    const sel = document.createElement('select');
    sel.className = 'cw-ask-model-sel';
    sel.setAttribute('data-cs-fixed', '');
    sel.setAttribute('aria-label', t('claude_ask_model', 'Model'));
    askModelOptions().forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.label;
      if (o.note) opt.dataset.csNote = o.note;
      if (o.id === askModel) opt.selected = true;
      sel.appendChild(opt);
    });
    // No repaint: rebuilding the composer here would throw away what is typed.
    sel.addEventListener('change', () => { askModel = sel.value; });
    bar.appendChild(sel);
    if (typeof window.initCustomSelect === 'function') {
      requestAnimationFrame(() => { try { window.initCustomSelect(sel); } catch {} });
    }

    bar.appendChild(el('div', 'cw-composer-gap'));

    const send = el('button', 'cw-ask-send'); send.type = 'button';
    send.textContent = askBusy
      ? t('claude_ask_sending', 'Starting…')
      : (askResumeId ? t('claude_ask_send_more', 'Send') : t('claude_ask_send', 'Start'));
    send.disabled = askBusy || (askProjects !== null && !askProjects.length);
    send.addEventListener('click', () => { askText = ta.value; submitAsk(); });
    bar.appendChild(send);

    box.appendChild(bar);
    if (askError) box.appendChild(el('div', 'cw-ask-error', askError));
    return box;
  }

  function askPanel() {
    const wrap = el('div', 'cw-panel is-ask');
    const head = el('div', 'cw-panel-head');
    const titles = el('div', 'cw-panel-titles');
    titles.appendChild(el('div', 'cw-panel-title',
      askResumeId ? t('claude_ask_continue_title', 'Continue this session') : t('claude_ask_title', 'Ask Claude')));
    // One line of context instead of a paragraph and a full-width badge: when
    // continuing, the folder IS the context, and the caveat about a shared
    // transcript belongs near it rather than above everything.
    // Naming the folder was not enough: two sessions in the same folder is the
    // ordinary case, and both then read as "xenon". Carry the same #tag the list
    // row shows, and say what this session was last asked to do — that is the
    // thing that actually tells the two apart.
    if (askResumeId) {
      const s = askSession();
      const tag = s ? sessionTag(s) : '';
      const line = el('div', 'cw-panel-sub');
      line.appendChild(el('span', 'cw-panel-sub-proj', askResumeLabel || t('claude_ask_session', 'session')));
      if (tag) line.appendChild(el('span', 'cw-sess-tag', '#' + tag));
      const last = (s && (s.tool || s.task)) || '';
      if (last) line.appendChild(el('span', 'cw-panel-sub-task', last));
      else line.appendChild(el('span', 'cw-panel-sub-task', t('claude_ask_continue_sub', 'shares its transcript with the terminal')));
      titles.appendChild(line);
    } else {
      titles.appendChild(el('div', 'cw-panel-sub',
        t('claude_ask_sub', 'Whatever it runs or writes comes back here to approve')));
    }
    head.appendChild(titles);
    const back = el('button', 'cw-panel-close'); back.type = 'button';
    back.setAttribute('aria-label', t('back', 'Back'));
    back.textContent = '✕';
    back.addEventListener('click', closeAsk);
    head.appendChild(back);
    wrap.appendChild(head);

    const notice = noticeBar();
    if (notice) wrap.appendChild(notice);

    if (askProjects === null) {
      wrap.appendChild(el('div', 'cw-panel-note', t('claude_ask_loading', 'Reading your projects…')));
    } else if (!askProjects.length) {
      wrap.appendChild(el('div', 'cw-panel-note', t('claude_ask_noprojects', 'No projects found. Open Claude Code in a folder once, then come back.')));
    } else if (!askResumeId) {
      // Resuming already knows its project; picking another would send the
      // follow-up somewhere the session does not live.
      const list = el('div', 'cw-ask-projects');
      askProjects.slice(0, 8).forEach(p => {
        const b = el('button', 'cw-ask-proj' + (p.id === askProjectId ? ' is-sel' : '')); b.type = 'button';
        b.appendChild(el('span', 'cw-ask-proj-name', p.name));
        b.title = p.path;
        b.addEventListener('click', () => { askProjectId = p.id; paint(); });
        list.appendChild(b);
      });
      wrap.appendChild(list);
    }

    if (askResumeId) wrap.appendChild(threadView());
    else wrap.appendChild(el('div', 'cw-thread-spacer'));
    wrap.appendChild(composer());
    return wrap;
  }

  // A run in progress, or its result. Deliberately plain: the interesting part
  // is the text Claude produced, so it gets the room.
  function runCard(r) {
    const card = el('div', 'cw-run is-' + r.state);
    const head = el('div', 'cw-run-head');
    head.appendChild(el('span', 'cw-run-badge', t('claude_run_badge', 'Xenon run')));
    head.appendChild(el('span', 'cw-run-proj', r.project || ''));
    head.appendChild(el('span', 'cw-run-state', runStateText(r)));
    card.appendChild(head);

    card.appendChild(el('div', 'cw-run-prompt', r.prompt));
    if (r.output) card.appendChild(el('div', 'cw-run-out', r.output));
    if (r.state === 'failed' && r.error) card.appendChild(el('div', 'cw-run-err', r.error));

    if (r.state === 'running') {
      const stop = el('button', 'cw-run-stop'); stop.type = 'button';
      stop.textContent = t('claude_run_stop', 'Stop');
      stop.addEventListener('click', () => stopRun(r.id));
      card.appendChild(stop);
    }
    return card;
  }
  function runStateText(r) {
    if (r.state === 'running') return t('claude_run_working', 'working') + ' · ' + ago(r.elapsedMs);
    if (r.state === 'done') return t('claude_run_done', 'done');
    if (r.state === 'stopped') return t('claude_run_stopped', 'stopped');
    return t('claude_run_failed', 'failed');
  }

  // ── budget editor (fallback ceiling when there are no real windows) ────────
  const PLAN_OPTIONS = [
    { key: 'auto',  plan: 'custom', labelKey: 'claude_plan_auto',  fb: 'Auto' },
    { key: 'pro',   plan: 'pro',    labelKey: 'claude_plan_pro',   fb: 'Pro' },
    { key: 'max5',  plan: 'max5',   labelKey: 'claude_plan_max5',  fb: 'Max 5×' },
    { key: 'max20', plan: 'max20',  labelKey: 'claude_plan_max20', fb: 'Max 20×' },
  ];
  function currentPlanKey() {
    const b = payload && payload.budget;
    if (!b) return 'auto';
    if (b.weeklyTokenBudget > 0) return 'custom';
    if (b.plan === 'pro' || b.plan === 'max5' || b.plan === 'max20') return b.plan;
    return 'auto';
  }
  function openBudget() { editing = true; customOpen = currentPlanKey() === 'custom'; paint(); }
  function closeBudget() { editing = false; paint(); }
  async function postBudget(patch) {
    const d = await api('/api/claude/budget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (d && d.ok && d.budget) { if (payload) payload.budget = d.budget; editing = false; paint(); }
    else if (window.XenonToast) window.XenonToast.show({ type: 'error', title: t('claude_budget_fail', 'Could not save budget') });
  }
  function budgetEditor() {
    const wrap = el('div', 'cw-panel');
    const head = el('div', 'cw-panel-head');
    head.appendChild(el('div', 'cw-panel-title', t('claude_budget_title', 'Weekly budget')));
    const back = el('button', 'cw-panel-close'); back.type = 'button';
    back.setAttribute('aria-label', t('back', 'Back'));
    back.textContent = '✕';
    back.addEventListener('click', closeBudget);
    head.appendChild(back);
    wrap.appendChild(head);

    wrap.appendChild(el('div', 'cw-panel-body', t('claude_budget_hint2', 'Used when Claude Code is not connected, or on an API key, which has no subscription windows. Pick the weekly ceiling to measure against.')));

    const cur = currentPlanKey();
    const chips = el('div', 'cw-plan-chips');
    PLAN_OPTIONS.forEach(o => {
      const c = el('button', 'cw-plan' + (cur === o.key && !customOpen ? ' is-sel' : '')); c.type = 'button';
      c.textContent = t(o.labelKey, o.fb);
      c.addEventListener('click', () => postBudget({ plan: o.plan, weeklyTokenBudget: 0 }));
      chips.appendChild(c);
    });
    const customChip = el('button', 'cw-plan' + (customOpen ? ' is-sel' : '')); customChip.type = 'button';
    customChip.textContent = t('claude_plan_custom', 'Custom');
    customChip.addEventListener('click', () => { customOpen = true; paint(); });
    chips.appendChild(customChip);
    wrap.appendChild(chips);

    if (customOpen) {
      const row = el('div', 'cw-custom');
      const input = el('input', 'cw-custom-input'); input.type = 'number'; input.min = '1'; input.step = '1'; input.placeholder = '500';
      const b = payload && payload.budget;
      if (b && b.weeklyTokenBudget > 0) input.value = String(Math.round(b.weeklyTokenBudget / 1e6));
      row.appendChild(input);
      row.appendChild(el('span', 'cw-custom-unit', t('claude_custom_unit', 'M tokens / week')));
      const save = el('button', 'cw-custom-save'); save.type = 'button'; save.textContent = t('claude_budget_save', 'Save');
      const commit = () => {
        const m = parseInt(input.value, 10);
        if (!Number.isFinite(m) || m <= 0) { input.focus(); return; }
        postBudget({ plan: 'custom', weeklyTokenBudget: m * 1e6 });
      };
      save.addEventListener('click', commit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
      row.appendChild(save);
      wrap.appendChild(row);
      requestAnimationFrame(() => { try { input.focus(); } catch {} });
    }
    return wrap;
  }

  // ── render ────────────────────────────────────────────────────────────────
  function build() {
    const wrap = el('div', 'cw-wrap');
    if (editing) { wrap.appendChild(budgetEditor()); return wrap; }
    if (linkPanel) { wrap.appendChild(linkPanelView()); return wrap; }
    if (askOpen) { wrap.appendChild(askPanel()); return wrap; }

    // Approvals render FIRST and unconditionally. The usage aggregate is only
    // scanned while the tile is on the dashboard, so it can still be null at the
    // moment a permission request lands — and a blocked tool call must never be
    // hidden behind a "loading" placeholder.
    const pend = approvals().filter(a => !a.urgent);
    if (pend.length) {
      const box = el('div', 'cw-appr-list');
      pend.slice(0, 3).forEach(a => box.appendChild(approvalCard(a, false)));
      wrap.appendChild(box);
    }

    // Runs the dashboard started sit with the approvals, above the bands: they
    // are the thing the user is waiting on, and like an approval they must show
    // before the usage aggregate has finished loading.
    const rl = runs();
    if (rl.length) {
      const box = el('div', 'cw-run-list');
      rl.slice(-2).forEach(r => box.appendChild(runCard(r)));
      wrap.appendChild(box);
    }

    const u = payload && payload.usage;
    if (!u) {
      wrap.appendChild(el('div', 'cw-state', t('claude_reading', 'Reading local Claude Code sessions…')));
      return wrap;
    }

    wrap.appendChild(quotaBand());
    wrap.appendChild(liveBand());
    wrap.appendChild(totalsBand(u));

    // Offer the connection only when it would actually add something.
    if (!linkState || !linkState.linked) {
      const cta = el('div', 'cw-cta');
      cta.appendChild(el('span', 'cw-cta-text', t('claude_cta', 'Show real quota and approve from here')));
      cta.appendChild(linkButton());
      wrap.appendChild(cta);
    }

    const more = el('div', 'cw-more');
    more.appendChild(sparks(u));
    const proj = projectBars(u); if (proj) more.appendChild(proj);
    const models = modelSplit(u); if (models) more.appendChild(models);
    wrap.appendChild(more);

    return wrap;
  }

  // ── ticking ────────────────────────────────────────────────────────────────
  // Only the countdown texts change every second. Repainting the whole tile for
  // that would throw away scroll position and fight the user's taps, so the tick
  // mutates just those nodes — and stops entirely when nothing counts down.
  function tick() {
    const nodes = document.querySelectorAll('[data-reset-at], [data-expires-at]');
    nodes.forEach(n => {
      if (n.dataset.resetAt) n.textContent = until(Number(n.dataset.resetAt));
      else n.textContent = mmss(Number(n.dataset.expiresAt) - Date.now());
    });
    if (!nodes.length) stopTicker();
  }
  function startTicker() {
    if (ticker) return;
    ticker = setInterval(tick, 1000);
  }
  function stopTicker() {
    if (!ticker) return;
    clearInterval(ticker); ticker = null;
  }

  function paint() {
    tiles().forEach(tile => {
      const mount = tile.querySelector('.claude-widget-mount');
      if (!mount) return;
      // A repaint rebuilds the tile, and an SSE push can land at any moment —
      // so without this the session list would jump back to the top while the
      // user is scrolling through it.
      const prev = mount.querySelector('.cw-sess-scroll');
      const keepTop = prev ? prev.scrollTop : 0;
      // The conversation gets the same treatment, and needs it more: it now
      // reloads itself every couple of seconds while a session works, so
      // without this every refresh would throw the reader back to the top
      // mid-paragraph. threadView() re-pins to the bottom only when the reader
      // was already there.
      const prevThread = mount.querySelector('.cw-thread');
      const keepThread = prevThread ? prevThread.scrollTop : 0;
      mount.replaceChildren(build());
      if (keepTop) {
        const next = mount.querySelector('.cw-sess-scroll');
        if (next) next.scrollTop = keepTop;
      }
      if (keepThread && threadAtBottom === false) {
        const nextThread = mount.querySelector('.cw-thread');
        if (nextThread) nextThread.scrollTop = keepThread;
      }
    });
    syncOverlay();
    const needsTick = !!(limits() || approvals().length);
    if (needsTick) startTicker(); else stopTicker();
  }

  async function seed() {
    if (seedInflight) return;
    seedInflight = true;
    try {
      const d = await api('/api/claude');
      if (d) payload = d;
    } finally { seedInflight = false; }
    paint();
    loadLinkState();
  }

  // ── public API ──
  function renderWidgets() {
    if (!tiles().length) {
      seeded = false;
      stopTicker();
      // The overlay deliberately survives: a pending approval must stay
      // answerable even after the user pages away from the widget.
      if (!approvals().length) closeOverlay();
      return;
    }
    paint();
    if (!seeded) { seeded = true; seed(); }
  }
  // ── presence: who just stopped working ─────────────────────────────────────
  // One place decides "a session went from working to done", and two surfaces
  // read it: the notice inside an open chat panel, and the marker in the topbar
  // island. Both exist for the same reason — a session that finishes while you
  // are looking somewhere else currently announces itself nowhere, so you find
  // out by going back and checking.
  const DONE_TTL_MS = 10 * 60 * 1000;   // how long a finish stays worth showing
  let lastStates = new Map();           // session id → last state seen
  let doneNotices = [];                 // [{ id, project, at }] newest last

  function trackPresence() {
    const list = sessions();
    const now = Date.now();
    const next = new Map();
    list.forEach(s => {
      const was = lastStates.get(s.id);
      next.set(s.id, s.state);
      // Only a real transition counts. Seeding (was === undefined) must not
      // announce every session that happens to be idle when the page loads.
      if (was === 'running' && s.state !== 'running') {
        doneNotices = doneNotices.filter(n => n.id !== s.id);
        doneNotices.push({ id: s.id, project: s.project || '', at: now });
      }
    });
    lastStates = next;
    doneNotices = doneNotices.filter(n => (now - n.at) < DONE_TTL_MS && next.has(n.id));
    if (doneNotices.length > 4) doneNotices = doneNotices.slice(-4);
  }

  // Notices about a session OTHER than the one being written to. Seeing "this
  // session finished" while typing into that very session is noise.
  function otherNotices() {
    return doneNotices.filter(n => n.id !== askResumeId);
  }
  function clearNotice(id) {
    doneNotices = doneNotices.filter(n => n.id !== id);
    topbarSig = '';        // the chip's meaning just changed; let it redraw
    syncTopbar();
    paint();
  }

  function noticeBar() {
    const list = otherNotices();
    if (!list.length) return null;
    const n = list[list.length - 1];
    const bar = el('button', 'cw-notice'); bar.type = 'button';
    bar.appendChild(el('span', 'cw-notice-dot'));
    const txt = el('span', 'cw-notice-t');
    txt.appendChild(el('strong', '', n.project || t('claude_thread_claude', 'Claude')));
    txt.appendChild(document.createTextNode(' ' + t('claude_notice_done', 'finished answering')));
    bar.appendChild(txt);
    if (list.length > 1) bar.appendChild(el('span', 'cw-notice-more', '+' + (list.length - 1)));
    bar.appendChild(el('span', 'cw-notice-go', t('claude_notice_go', 'open')));
    // Switching panels: the thread and any half-written follow-up belong to the
    // session being left, so both are replaced rather than carried over.
    bar.addEventListener('click', () => {
      clearNotice(n.id);
      askText = '';
      openAsk(n.id, n.project || '', '');
    });
    return bar;
  }

  // ── the topbar marker ──────────────────────────────────────────────────────
  // Lives in the clock island, so it is present in both the full and the minimal
  // bar and can be reordered or hidden like any other island element. Three
  // states and nothing more: absent when there is nothing to say, a quiet pulse
  // while a session works, and lit when one has finished and you have not looked
  // yet. Tapping it opens that session.
  let topbarSig = '';

  function syncTopbar() {
    const host = document.getElementById('clock-claude');
    if (!host) return;
    // Switched off in Settings → the island gets its space back and stays that
    // way. The signature is cleared too, so re-enabling redraws immediately
    // instead of matching a stale one and staying blank.
    if (!topbarOn()) {
      if (!host.hidden) { host.hidden = true; host.replaceChildren(); }
      topbarSig = '';
      return;
    }
    const list = sessions();
    const working = list.filter(s => s.state === 'running').length;
    const done = otherNotices().length ? doneNotices.length : 0;
    const pending = approvals().length;

    // Rebuilding on every payload would restart the breathing animation several
    // times a second while a session is busy — exactly when it must look calm.
    // Only redraw when what the chip SAYS changes.
    const sig = `${working}|${done}|${pending}`;
    if (sig === topbarSig) return;
    topbarSig = sig;

    // Nothing happening → the island gives the space back rather than holding an
    // empty chip. An approval always shows: it is the one thing that blocks.
    if (!working && !done && !pending) { host.hidden = true; host.replaceChildren(); return; }

    host.hidden = false;
    const chip = el('button', 'cw-tb' + (pending ? ' is-waiting' : (done ? ' is-done' : ' is-working')));
    chip.type = 'button';
    chip.appendChild(el('span', 'cw-tb-dot'));
    const label = pending
      ? t('claude_bar_waiting', 'wants your OK')
      : (done ? t('claude_bar_done', 'finished') : t('claude_bar_working', 'working'));
    chip.appendChild(el('span', 'cw-tb-t', label));
    if (working > 1 && !pending) chip.appendChild(el('span', 'cw-tb-n', String(working)));
    chip.title = label;
    chip.addEventListener('click', () => {
      const n = doneNotices[doneNotices.length - 1];
      if (!n) return;
      // The panel is drawn inside the tile. With the tile on another page (or
      // not added at all) there is nowhere to open it, so the tap acknowledges
      // the marker instead of pretending to navigate somewhere.
      if (!tiles().length) { clearNotice(n.id); topbarSig = ''; syncTopbar(); return; }
      clearNotice(n.id);
      askText = '';
      openAsk(n.id, n.project || '', '');
    });
    host.replaceChildren(chip);
  }

  function onSSE(data) {
    if (!data) return;
    payload = data;
    // Presence runs on EVERY payload, before the early return below: the topbar
    // marker and the "another session answered" notice have to keep working
    // when the tile is on another page, or not on the dashboard at all.
    trackPresence();
    syncTopbar();
    // A session that just started or just stopped working flips whether the
    // thread needs watching, so the poll is re-evaluated on every payload.
    syncThreadPoll();
    // The overlay is global, so live state has to be applied even when the tile
    // isn't mounted on the current page.
    if (!tiles().length) { syncOverlay(); return; }
    paint();
  }

  // Either switch was flipped in Settings. Both surfaces are redrawn from the
  // payload already in hand — an approval that is still pending server-side
  // reappears the moment cards are turned back on, without waiting for the next
  // SSE push.
  function onSettingsChanged() {
    if (!approvalsOn()) closeOverlay();
    topbarSig = '';
    syncTopbar();
    paint();
  }

  window.ClaudeWidget = { renderWidgets, onSSE, onSettingsChanged };
})();
