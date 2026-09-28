'use strict';
// Claude Code widget: an instrument for the sessions running on this PC.
//
//   DECISIONS first, on both faces: a permission Claude Code is blocked on, or a
//     question it asked, with what the request would reach (publishes, network,
//     outside the project, cannot be undone) said before the keys. An
//     irreversible one is allowed by holding the key, not tapping it. One left
//     unanswered escalates to a fullscreen overlay.
//   LIVE face: one lane per session (state, the step it is on, ten minutes of
//     activity, its own plan, context used) beside the real 5-hour and 7-day
//     windows, each with an even-pace marker and a sentence saying where this
//     pace ends. Without the link it falls back to the user-set weekly budget.
//   USAGE face: one 30-day window, said as such, read from the transcripts:
//     today, since Monday, the total, the cache share, the value at list
//     prices, thirty days of columns, projects and models.
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
  let pressing = false;     // a pointer is down on the widget (see onSSE)
  let pressTimer = 0;
  let renderDeferred = false;

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="claude"]')).filter(n => n.closest('.pager-page'));
  }

  // A page the pager has parked (.is-parked → content-visibility: hidden,
  // DashboardPager.css) is not rendered, but it KEEPS its box — so a rects-only
  // test reads a tile sitting there as visible. Same test the slideshow tile
  // uses, including the layout-editing exception: editing un-parks those pages,
  // matching the CSS, so it must not count as parked there.
  function isParked(tile) {
    const page = tile.closest('.pager-page');
    return !!(page && page.classList.contains('is-parked')
      && !document.body.classList.contains('layout-editing'));
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
  // A compact duration in the reader's language: "4h07", "3 min", "2g5h" in
  // Italian, "4時間7分" in Japanese. The units used to be hard-coded, so every
  // language read Italian days ("4g23h").
  const CJK = /^(ja|ko|zh)$/;
  function dur(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    const U = (k, fb) => t('claude_unit_' + k, fb);
    const cjk = CJK.test(String(document.documentElement.lang || '').slice(0, 2));
    if (s < 60) return s + U('s', 's');
    const m = Math.floor(s / 60);
    if (m < 60) return m + U('m', 'm');
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 24) return h + U('h', 'h') + (mm ? (cjk ? mm + U('m', 'm') : String(mm).padStart(2, '0')) : '');
    const d = Math.floor(h / 24), hh = h % 24;
    return d + U('d', 'd') + (hh ? hh + U('h', 'h') : '');
  }
  function ago(ms) { return dur(ms); }
  // Countdown to an absolute epoch-seconds instant.
  function until(epochSec) {
    const ms = (Number(epochSec) || 0) * 1000 - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return '';
    return dur(ms);
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
  function questionsOn() { const c = cfg(); return !c || c.questions !== false; }
  function topbarOn() {
    const c = cfg();
    try {
      const items = hubSettings && hubSettings.topbarClock && hubSettings.topbarClock.items;
      const item = Array.isArray(items) ? items.find((entry) => entry && entry.id === 'claude') : null;
      if (item) return item.hidden !== true;
    } catch { /* legacy settings fallback below */ }
    return !c || c.topbar !== false;
  }

  // With a surface switched off there is nothing to show, nothing to escalate
  // and nothing for the topbar to call urgent. The server also answers the hook
  // immediately in that case, so the prompt is already back in the terminal by
  // the time this runs — the two halves have to agree or the tile would draw a
  // card for something nobody is waiting on any more.
  //
  // The two switches are separate because the bargains are: a permission decides
  // whether something RUNS on this PC, a question only picks how Claude
  // proceeds. Filtering both on the permission switch would have hidden every
  // question from anyone who only wanted approvals at the keyboard.
  function approvals() {
    const l = live();
    const all = (l && l.approvals) || [];
    return all.filter((a) => (a.kind === 'question' ? questionsOn() : approvalsOn()));
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

  // ── formatting in the reader's language ────────────────────────────────────
  // Counts, money and clock times go through Intl in the UI language, so an
  // Italian dashboard reads "4,36 Mrd" and "1.991 US$", and a Japanese one
  // "43.6億". The old hand-rolled "B"/"$" formatting was English everywhere.
  function uiLang() { return String(document.documentElement.lang || 'en').slice(0, 2) || 'en'; }
  function fmtTokens(n) {
    const v = Math.max(0, Math.round(n || 0));
    try { return new Intl.NumberFormat(uiLang(), { notation: 'compact', maximumFractionDigits: v >= 1e9 ? 2 : 1 }).format(v); }
    catch { return hTok(v); }
  }
  function fmtMoney(n) {
    const v = Math.max(0, n || 0);
    try { return new Intl.NumberFormat(uiLang(), { style: 'currency', currency: 'USD', maximumFractionDigits: v >= 100 ? 0 : 2 }).format(v); }
    catch { return hCost(v); }
  }
  // A share with a decimal, written the reader's way ("96,1 %" in French).
  function fmtPct(fraction, digits) {
    const v = Math.max(0, Number(fraction) || 0);
    try { return new Intl.NumberFormat(uiLang(), { style: 'percent', maximumFractionDigits: digits }).format(v); }
    catch { return (Math.round(v * 100 * Math.pow(10, digits)) / Math.pow(10, digits)) + '%'; }
  }
  function sameLocalDay(a, b) {
    const x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }
  // A clock time, with the weekday in front when it is not today.
  function fmtWhen(ms) {
    try {
      // timeParts() carries Settings → Time format (12h/24h), not the locale's.
      const opts = sameLocalDay(ms, Date.now()) ? timeParts() : timeParts({ weekday: 'short' });
      return new Intl.DateTimeFormat(uiLang(), opts).format(new Date(ms));
    } catch { return new Date(ms).toLocaleTimeString(); }
  }
  function fmtDay(ms) {
    try { return new Intl.DateTimeFormat(uiLang(), { day: 'numeric', month: 'short' }).format(new Date(ms)); }
    catch { return new Date(ms).toLocaleDateString(); }
  }
  // "claude-opus-5-5" → "Opus 5.5": the name Anthropic uses, not the API id.
  function prettyModel(model) {
    const id = String(model || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
    if (!id) return '';
    const parts = id.split('-');
    const name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    const ver = parts.slice(1).filter((p) => /^\d+$/.test(p)).join('.');
    return ver ? name + ' ' + ver : name;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ── ages that tick ─────────────────────────────────────────────────────────
  // Every age on this tile ("waiting 0:42", "running 3m") used to be frozen at
  // the moment the server built the payload: a session showed "0s" until the
  // next change. The server sends how old things were WHEN IT SENT them; this
  // side adds the time since it arrived. That is right on a paired phone whose
  // clock disagrees with the PC's, where comparing two clocks would not be.
  let payloadAt = Date.now();
  function aged(msAtSend) { return Math.max(0, (Number(msAtSend) || 0) + (Date.now() - payloadAt)); }
  function ageNode(cls, msAtSend, prefix) {
    const n = el('span', cls);
    n.dataset.ageBase = String(Number(msAtSend) || 0);
    n.dataset.agePrefix = prefix || '';
    n.textContent = (prefix || '') + dur(aged(msAtSend));
    return n;
  }

  // ── quota: two instruments ─────────────────────────────────────────────────
  // Each window is a segmented gauge of what is USED (the number Claude's own
  // usage page shows), with a marker where an even pace would put you right
  // now: fill past the marker means burning faster than the window allows. The
  // sentence under it turns that into a time. Both come straight from the two
  // numbers Claude Code reports (used % and the reset instant) and the window's
  // known length, so nothing here is sampled, smoothed or guessed.
  const WINDOW_MS = Object.freeze({ fiveHour: 5 * 3600 * 1000, sevenDay: 7 * 86400 * 1000 });
  const SEGMENTS = 20;
  // Below this share of the window elapsed, the pace is mostly noise.
  const PACE_MIN_ELAPSED = 0.15;

  function level(used) { return used >= 90 ? 'crit' : used >= 70 ? 'warn' : 'ok'; }

  function paceLine(used, elapsed, start, reset) {
    if (!reset || elapsed === null || elapsed < PACE_MIN_ELAPSED || used <= 0) return null;
    const projected = used / elapsed;
    if (projected >= 100) {
      const hitAt = start + (Date.now() - start) * (100 / used);
      return el('div', 'cw-pace is-warn',
        t('claude_pace_hit', 'At this pace you reach the limit at {time}').replace('{time}', fmtWhen(hitAt)));
    }
    return el('div', 'cw-pace',
      t('claude_pace_end', 'At this pace you end this window at {pct}%').replace('{pct}', String(Math.round(projected))));
  }

  function gauge(key, label, win) {
    const L = WINDOW_MS[key];
    const reset = (Number(win.resetsAt) || 0) * 1000;
    const nowMs = Date.now();
    // Past its reset instant a window has started over: showing the old figure
    // until the next statusline post (it used to stay for minutes) is showing a
    // number that is no longer true.
    const renewed = !!reset && reset <= nowMs;
    const used = renewed ? 0 : clamp(Number(win.pct) || 0, 0, 100);
    const start = reset - L;
    const elapsed = reset && !renewed ? clamp((nowMs - start) / L, 0, 1) : null;

    const box = el('div', 'cw-gauge is-' + level(used));
    const head = el('div', 'cw-gauge-head');
    head.appendChild(el('span', 'cw-gauge-key', label));
    head.appendChild(el('span', 'cw-gauge-val', Math.round(used) + '%'));
    const reset$ = el('span', 'cw-gauge-reset');
    if (renewed) reset$.textContent = t('claude_new_window', 'new window');
    else if (reset) {
      reset$.appendChild(el('span', 'cw-gauge-reset-l', t('claude_resets_in', 'resets in') + ' '));
      const cd = el('span', 'cw-gauge-reset-t', until(win.resetsAt));
      cd.dataset.resetAt = String(win.resetsAt);
      reset$.appendChild(cd);
    }
    head.appendChild(reset$);
    box.appendChild(head);

    const track = el('div', 'cw-gauge-track');
    track.setAttribute('role', 'meter');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(Math.round(used)));
    track.setAttribute('aria-label', label);
    const lit = Math.round((used / 100) * SEGMENTS);
    for (let i = 0; i < SEGMENTS; i++) track.appendChild(el('span', 'cw-seg' + (i < lit ? ' is-on' : '')));
    if (elapsed !== null) {
      const mark = el('span', 'cw-gauge-pace');
      mark.style.left = (elapsed * 100).toFixed(2) + '%';
      mark.title = t('claude_pace_mark', 'An even pace would be here now');
      track.appendChild(mark);
    }
    box.appendChild(track);
    const pace = paceLine(used, elapsed, start, reset);
    if (pace) box.appendChild(pace);
    return box;
  }

  // Has any session posted a statusline yet? With Claude Code linked, the quota
  // arrives on those posts; before the first one there is nothing to show YET,
  // which is different from an API-key account that has no windows at all.
  function statusSeen() {
    return sessions().some((s) => typeof s.contextPct === 'number' || typeof s.cost === 'number');
  }

  function quotaPanel() {
    const lim = limits();
    const panel = el('div', 'cw-quota');
    panel.appendChild(el('div', 'cw-sec-title', t('claude_quota', 'Quota')));

    if (lim && (lim.fiveHour || lim.sevenDay)) {
      if (lim.fiveHour) panel.appendChild(gauge('fiveHour', t('claude_5h', '5h'), lim.fiveHour));
      if (lim.sevenDay) panel.appendChild(gauge('sevenDay', t('claude_7d', '7d'), lim.sevenDay));
      return panel;
    }
    if (linkState && linkState.linked && !statusSeen()) {
      panel.appendChild(el('div', 'cw-quiet-note', t('claude_quota_waiting', "The quota appears with Claude's next reply.")));
      return panel;
    }

    // No real windows: an API-key account, or Claude Code not connected. The
    // user's own weekly budget stands in, and says what it counts.
    const u = payload && payload.usage;
    const b = payload && payload.budget;
    const week = u ? u.week.tokens : 0;
    const weekly = b ? b.weekly : 0;
    const box = el('div', 'cw-gauge is-' + (weekly > 0 ? level((week / weekly) * 100) : 'ok'));
    const head = el('div', 'cw-gauge-head');
    head.appendChild(el('span', 'cw-gauge-key', t('claude_budget_band', 'Weekly budget')));
    const used = weekly > 0 ? clamp((week / weekly) * 100, 0, 100) : 0;
    head.appendChild(el('span', 'cw-gauge-val', weekly > 0 ? Math.round(used) + '%' : fmtTokens(week)));
    const edit = el('button', 'cw-link-btn'); edit.type = 'button';
    edit.textContent = weekly > 0 ? t('claude_edit', 'edit') : t('claude_set_budget_short', 'set');
    edit.addEventListener('click', openBudget);
    head.appendChild(edit);
    box.appendChild(head);
    if (weekly > 0) {
      const track = el('div', 'cw-gauge-track');
      const lit = Math.round((used / 100) * SEGMENTS);
      for (let i = 0; i < SEGMENTS; i++) track.appendChild(el('span', 'cw-seg' + (i < lit ? ' is-on' : '')));
      box.appendChild(track);
      box.appendChild(el('div', 'cw-pace', fmtTokens(Math.max(0, weekly - week)) + ' ' + t('claude_left_short', 'left')
        + ' · ' + t('claude_budget_counts', 'counts every token, cache reads included')));
    }
    panel.appendChild(box);
    return panel;
  }

  // ── approvals ──────────────────────────────────────────────────────────────
  const STATE_LABEL = {
    running: () => t('claude_state_running', 'working'),
    waiting: () => t('claude_state_waiting', 'waiting for you'),
    idle: () => t('claude_state_idle', 'idle'),
  };

  // "Did it finish, or did I kill it?" is the question the user asks about a
  // session that is no longer there, and the old widget answered neither: the
  // record was deleted the moment it ended.
  function endedLabel(s) {
    if (s.endedReason === 'gone') return t('claude_ended_gone', 'closed');
    if (s.endedReason === 'clear') return t('claude_ended_clear', 'cleared');
    if (s.endedReason === 'logout') return t('claude_ended_logout', 'signed out');
    return t('claude_ended', 'finished');
  }

  // `extra` is only for a plan card: the mode its row approves into, or the
  // feedback it is sent back with.
  async function decide(id, behavior, extra) {
    if (deciding.has(id)) return;
    deciding.add(id);
    paint();
    const d = await api('/api/claude/decide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, behavior, ...(extra || {}) }),
    });
    deciding.delete(id);
    typedAns.delete(id);
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

  // ── answering a question ───────────────────────────────────────────────────
  // What the user has picked so far, per card: approvalId → array (one entry per
  // question) of arrays of option labels. Held here rather than in the DOM
  // because every SSE push rebuilds the tile, and a half-made choice must
  // survive Claude finishing a tool call in the middle of it.
  const qsel = new Map();
  // What has been typed, per card: approvalId → array (one string per question:
  // the "Other" box or a text/number answer; for a plan card, index 0 is the
  // feedback). Mirrored on input and never repainted from, so the caret stays
  // where the user left it.
  const typedAns = new Map();
  // The terminal's "Other" row, as a pick. Never sent as a label: its text is.
  const OTHER = '\u0000other';

  function typedFor(a) {
    let cur = typedAns.get(a.id);
    if (!cur) { cur = []; typedAns.set(a.id, cur); }
    return cur;
  }

  function pickOption(a, qi, label, multi) {
    const cur = qsel.get(a.id) || a.questions.map(() => []);
    const row = cur[qi] || [];
    if (multi) {
      const at = row.indexOf(label);
      cur[qi] = at === -1 ? row.concat(label) : row.filter((x) => x !== label);
    } else {
      cur[qi] = row.length === 1 && row[0] === label ? [] : [label];
    }
    qsel.set(a.id, cur);
    paint();
  }

  function answerReady(a) {
    const cur = qsel.get(a.id) || [];
    const typed = typedAns.get(a.id) || [];
    return (a.questions || []).some((q, qi) => {
      const text = String(typed[qi] || '').trim();
      if (q.kind === 'text' || q.kind === 'number') return !!text;
      const row = cur[qi] || [];
      return row.some((l) => l !== OTHER) || (row.indexOf(OTHER) !== -1 && !!text);
    });
  }

  async function sendAnswer(a, skip) {
    if (deciding.has(a.id)) return;
    deciding.add(a.id);
    paint();
    const cur = qsel.get(a.id) || [];
    const typed = typedAns.get(a.id) || [];
    // A typed answer counts only where it is the answer: its question is a
    // text/number one, or "Other" is picked. Text left in a box the user then
    // closed is not something they chose to send.
    const body = skip ? { id: a.id, skip: true } : {
      id: a.id,
      selections: (a.questions || []).map((q, qi) => (cur[qi] || []).filter((l) => l !== OTHER)),
      typed: (a.questions || []).map((q, qi) => (
        q.kind === 'text' || q.kind === 'number' || (cur[qi] || []).indexOf(OTHER) !== -1 ? String(typed[qi] || '') : '')),
    };
    const d = await api('/api/claude/answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    deciding.delete(a.id);
    qsel.delete(a.id);
    typedAns.delete(a.id);
    if (!d || !d.ok) {
      // Claude stopped waiting, or it was answered in the terminal. Saying so
      // beats a button that appears to do nothing.
      if (window.XenonToast) window.XenonToast.show({ type: 'warn', title: t('claude_decide_late', 'That request is no longer waiting') });
    }
    const l = live();
    if (l && l.approvals) l.approvals = l.approvals.filter((x) => x.id !== a.id);
    paint();
  }

  // ── a follow-up into a live session ────────────────────────────────────────
  // Only offered while a turn is running, because the delivery point is the end
  // of that turn. An idle session takes the resume path instead (submitAsk), and
  // the composer says which of the two is about to happen before you press send.
  async function queueReply(sessionId, text) {
    const d = await api('/api/claude/reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, text }),
    });
    return d && d.ok ? { ok: true } : { ok: false, error: (d && d.error) || 'failed' };
  }
  async function cancelReply(sessionId) {
    await api('/api/claude/reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cancel: true }),
    });
    const s = sessions().find((x) => x.id === sessionId);
    if (s) s.queued = null;
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

  // ── the decision card ──────────────────────────────────────────────────────
  // With auto mode on (Claude Code's default since August 2026) routine calls
  // never reach a person, so a request that does is the unusual one. The card is
  // built for that: what it wants to do in words, the exact command as evidence,
  // what makes it unusual (the risk line), and two keys.
  //
  // Two guards against the wrong tap, both learned from how these cards fail:
  //   ARMING  a card ignores taps for its first moments on screen, so a finger
  //           already on its way to something else (or the tap that woke the
  //           screen) cannot land on Allow as the card appears under it.
  //   HOLD    an irreversible request (deletes, force-pushes, resets) is allowed
  //           by holding the key, not tapping it. Deny is always one tap.
  const ARM_MS = 450;
  const HOLD_MS = 900;
  const firstSeen = new Map();   // approval id → when this surface first drew it
  const armTimers = new Set();

  function isArmed(a) {
    if (!firstSeen.has(a.id)) firstSeen.set(a.id, Date.now());
    const left = firstSeen.get(a.id) + ARM_MS - Date.now();
    if (left <= 0) return true;
    if (!armTimers.has(a.id)) {
      armTimers.add(a.id);
      setTimeout(() => { armTimers.delete(a.id); paint(); }, left + 30);
    }
    return false;
  }
  function forgetSeen() {
    const alive = new Set(approvals().map((a) => a.id));
    for (const id of firstSeen.keys()) if (!alive.has(id)) firstSeen.delete(id);
  }

  const RISK_LABEL = {
    irreversible: () => t('claude_risk_irreversible', 'Cannot be undone'),
    publish: () => t('claude_risk_publish', 'Publishes your work'),
    network: () => t('claude_risk_network', 'Reaches the network'),
    outside: () => t('claude_risk_outside', 'Outside the project folder'),
    readonly: () => t('claude_risk_readonly', 'Only reads'),
  };

  function key(cls, label, onTap, a) {
    const b = el('button', 'cw-key ' + cls); b.type = 'button';
    b.appendChild(el('span', 'cw-key-label', label));
    b.disabled = deciding.has(a.id);
    b.addEventListener('click', () => { if (isArmed(a)) onTap(); });
    return b;
  }

  // Allow for an irreversible request: hold for HOLD_MS. A keyboard has no
  // "hold" the page can rely on, so there it is two presses within 3 seconds.
  function holdKey(a) {
    const b = el('button', 'cw-key is-allow is-hold'); b.type = 'button';
    b.appendChild(el('span', 'cw-key-fill'));
    const label = el('span', 'cw-key-label', t('claude_hold_allow', 'Hold to allow'));
    b.appendChild(label);
    b.disabled = deciding.has(a.id);
    let timer = 0;
    const stop = () => { clearTimeout(timer); timer = 0; b.classList.remove('is-holding'); };
    b.addEventListener('pointerdown', (e) => {
      if (!isArmed(a) || b.disabled) return;
      try { b.setPointerCapture(e.pointerId); } catch { /* not all pointers capture */ }
      b.classList.add('is-holding');
      timer = setTimeout(() => { timer = 0; b.classList.remove('is-holding'); decide(a.id, 'allow'); }, HOLD_MS);
    });
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointercancel', stop);
    b.addEventListener('lostpointercapture', stop);
    let keyAt = 0;
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (!isArmed(a)) return;
      if (Date.now() - keyAt < 3000) { decide(a.id, 'allow'); return; }
      keyAt = Date.now();
      label.textContent = t('claude_press_again', 'Press again to allow');
    });
    return b;
  }

  // One numbered row, the shape the terminal's own lists have.
  function optRow(n, label, desc, picked, disabled, onTap) {
    const btn = el('button', 'cw-opt' + (picked ? ' is-picked' : ''));
    btn.type = 'button';
    btn.setAttribute('aria-pressed', picked ? 'true' : 'false');
    btn.disabled = disabled;
    btn.appendChild(el('span', 'cw-opt-n', String(n)));
    const text = el('span', 'cw-opt-text');
    text.appendChild(el('span', 'cw-opt-label', label));
    if (desc) text.appendChild(el('span', 'cw-opt-desc', desc));
    btn.appendChild(text);
    btn.addEventListener('click', onTap);
    return btn;
  }

  // A text box whose value lives in typedAns rather than in the DOM, so a
  // repaint rebuilds it with the same text; `data-keep` lets paint() give it
  // its focus and caret back (keepFocus).
  function typedBox(a, qi, keep, opts) {
    const o = opts || {};
    const input = o.multiline ? document.createElement('textarea') : document.createElement('input');
    input.className = 'cw-dec-input';
    if (o.multiline) input.rows = 2;
    else input.type = o.number ? 'number' : 'text';
    if (o.number) {
      input.inputMode = 'decimal';
      if (Number.isFinite(o.min)) input.min = String(o.min);
      if (Number.isFinite(o.max)) input.max = String(o.max);
      if (Number.isFinite(o.step)) input.step = String(o.step);
    }
    input.maxLength = 2000;
    input.placeholder = o.placeholder || '';
    input.dataset.keep = keep;
    input.value = typedFor(a)[qi] || '';
    input.disabled = deciding.has(a.id);
    input.addEventListener('input', () => {
      typedFor(a)[qi] = input.value;
      if (typeof o.onInput === 'function') o.onInput();
    });
    return input;
  }

  function questionKeys(a, onInput) {
    const wrap = el('div', 'cw-dec-qs');
    const cur = qsel.get(a.id) || a.questions.map(() => []);
    const busy = deciding.has(a.id);
    const ph = t('claude_q_other_ph', 'Type your answer');
    a.questions.forEach((q, qi) => {
      const box = el('div', 'cw-dec-q');
      if (q.header) box.appendChild(el('div', 'cw-dec-qhead', q.header));
      box.appendChild(el('div', 'cw-dec-qtext', q.question));
      if (q.kind === 'text' || q.kind === 'number') {
        box.appendChild(typedBox(a, qi, 'q-' + a.id + '-' + qi, {
          number: q.kind === 'number', min: q.min, max: q.max, step: q.step,
          placeholder: q.kind === 'number' && q.unit ? q.unit : (q.placeholder || ph), onInput,
        }));
        wrap.appendChild(box);
        return;
      }
      if (q.multiSelect) box.appendChild(el('div', 'cw-dec-qnote', t('claude_q_multi', 'Pick one or more')));
      const list = el('div', 'cw-opts');
      const row = cur[qi] || [];
      (q.options || []).forEach((o, oi) => {
        list.appendChild(optRow(oi + 1, o.label, o.description, row.indexOf(o.label) !== -1, busy,
          () => { if (isArmed(a)) pickOption(a, qi, o.label, !!q.multiSelect); }));
      });
      // The terminal adds this row to every choice question; the card showed
      // the same question without it, so an answer that was none of the
      // options could only be given at the keyboard.
      const other = row.indexOf(OTHER) !== -1;
      list.appendChild(optRow((q.options || []).length + 1, t('claude_q_other', 'Other'), '', other, busy,
        () => { if (isArmed(a)) pickOption(a, qi, OTHER, !!q.multiSelect); }));
      box.appendChild(list);
      if (other) box.appendChild(typedBox(a, qi, 'q-' + a.id + '-' + qi, { placeholder: ph, onInput }));
      wrap.appendChild(box);
    });
    return wrap;
  }

  // The rows of Claude Code's plan dialog, with its wording: approve into a
  // mode, or keep planning with what to change. "Allow" over a plan said
  // nothing about what happens next, and did nothing in the terminal either.
  const PLAN_CHOICE_LABEL = {
    auto: () => t('claude_xp_auto', 'Yes, and use auto mode'),
    acceptEdits: () => t('claude_xp_accept', 'Yes, auto-accept edits'),
    default: () => t('claude_xp_manual', 'Yes, manually approve edits'),
  };
  function planKeys(a) {
    const box = el('div', 'cw-dec-acts is-plan');
    const busy = deciding.has(a.id);
    const list = el('div', 'cw-opts is-col');
    const choices = Array.isArray(a.choices) && a.choices.length ? a.choices : ['default'];
    choices.forEach((mode, i) => {
      const label = PLAN_CHOICE_LABEL[mode] ? PLAN_CHOICE_LABEL[mode]() : mode;
      list.appendChild(optRow(i + 1, label, '', false, busy,
        () => { if (isArmed(a)) decide(a.id, 'allow', { mode }); }));
    });
    box.appendChild(list);
    const back = el('div', 'cw-dec-back');
    back.appendChild(typedBox(a, 0, 'xp-' + a.id, { multiline: true, placeholder: t('claude_xp_feedback', 'Tell Claude what to change') }));
    back.appendChild(key('is-deny', t('claude_xp_keep', 'No, keep planning'),
      () => decide(a.id, 'deny', { feedback: String(typedFor(a)[0] || '') }), a));
    box.appendChild(back);
    return box;
  }

  function decisionCard(a, big) {
    const isAsk = a.kind === 'question';
    const isPlan = a.kind === 'plan';
    const risks = Array.isArray(a.risks) ? a.risks : [];
    const irreversible = risks.indexOf('irreversible') !== -1;
    const armed = isArmed(a);
    const card = el('section', 'cw-dec is-' + (isAsk ? 'question' : isPlan ? 'plan' : 'permission')
      + (big ? ' is-big' : '') + (irreversible ? ' is-risky' : '') + (armed ? '' : ' is-arming'));
    card.setAttribute('aria-live', 'polite');

    const head = el('div', 'cw-dec-head');
    head.appendChild(el('span', 'cw-dec-kind', isAsk ? t('claude_question', 'Question')
      : isPlan ? t('claude_xp_kind', 'Plan') : t('claude_permission', 'Permission')));
    const where = el('span', 'cw-dec-where');
    where.textContent = [a.project, prettyModel(a.model)].filter(Boolean).join(' · ');
    head.appendChild(where);
    const left = el('span', 'cw-dec-timer');
    // "8:42" alone reads as a time of day; the template says it is what is left.
    left.dataset.expiresAt = String(Date.now() + (a.expiresInMs || 0));
    left.dataset.tpl = t('claude_dec_left', '{t} left');
    left.textContent = left.dataset.tpl.replace('{t}', mmss(a.expiresInMs));
    left.title = t('claude_dec_expires', 'After this the terminal asks instead');
    head.appendChild(left);
    card.appendChild(head);

    // Typing never repaints, so the Answer key's enabled state is updated here.
    let send = null;
    const refreshSend = () => { if (send) send.disabled = deciding.has(a.id) || !answerReady(a); };

    const body = el('div', 'cw-dec-body');
    if (isAsk) {
      body.appendChild(questionKeys(a, refreshSend));
    } else if (isPlan) {
      body.appendChild(el('div', 'cw-dec-what', t('claude_xp_what', 'Ready to code?')));
      if (a.plan) body.appendChild(el('div', 'cw-dec-plan', a.plan));
    } else {
      body.appendChild(el('div', 'cw-dec-what', toolIntent(a.tool)));
      if (a.plan) body.appendChild(el('div', 'cw-dec-plan', a.plan));
      else if (a.detail) body.appendChild(el('div', 'cw-dec-cmd', a.detail));
      if (risks.length) {
        const line = el('div', 'cw-dec-risks');
        risks.forEach((r) => { if (RISK_LABEL[r]) line.appendChild(el('span', 'cw-risk is-' + r, RISK_LABEL[r]())); });
        body.appendChild(line);
      }
    }
    card.appendChild(body);

    if (isPlan) { card.appendChild(planKeys(a)); return card; }
    const acts = el('div', 'cw-dec-acts');
    if (isAsk) {
      acts.appendChild(key('is-quiet', t('claude_q_terminal', 'In the terminal'), () => sendAnswer(a, true), a));
      send = key('is-allow', t('claude_q_send', 'Answer'), () => sendAnswer(a, false), a);
      refreshSend();
      acts.appendChild(send);
    } else {
      acts.appendChild(key('is-deny', t('claude_deny', 'Deny'), () => decide(a.id, 'deny'), a));
      acts.appendChild(irreversible ? holdKey(a) : key('is-allow', t('claude_allow', 'Allow'), () => decide(a.id, 'allow'), a));
    }
    card.appendChild(acts);
    return card;
  }

  // The escalation: an urgent request takes the whole display. Rendered outside
  // the tile so it works even when the widget isn't on the current page.
  function syncOverlay() {
    if (pressing) { renderDeferred = true; return; }
    const urgent = approvals().filter(a => a.urgent)[0];
    if (!urgent) { closeOverlay(); return; }
    if (!overlay) {
      overlay = el('div', 'cw-overlay');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      document.body.appendChild(overlay);
      // This is a full-screen backdrop-filter, and it was in none of the three
      // registries every other one joins. Two real consequences: a Store promo
      // card could draw itself over an unanswered permission prompt (the worst
      // possible moment to be asked to dismiss something), and the blur kept
      // every dashboard animation running underneath it, which is exactly the
      // per-frame cost ambientFreeze exists to remove.
      if (typeof window.ambientFreeze === 'function') window.ambientFreeze('claude-approval', true);
    }
    // Rebuilt on every push like the tile, so it keeps the reader's place in a
    // long plan and the focus of a box being typed into, the same way.
    const focus = keepFocus(overlay);
    const kept = keepScroll(overlay);
    overlay.replaceChildren(decisionCard(urgent, true));
    restoreScroll(overlay, kept);
    focus();
  }
  function closeOverlay() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('claude-approval', false);
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

  // ── sessions: one lane each ────────────────────────────────────────────────
  // A dark cockpit: a lane that is fine stays grey and quiet, and colour means
  // something. Working is a thin line in the accent; waiting for you lights the
  // lane and moves it to the top, longest-waiting first; a finished session is
  // filed below. Each lane answers, left to right: which project, what it is
  // doing right now in words, how its plan is going, and how full its context is.
  const TRACE_MS = 10 * 60 * 1000;     // the activity trace covers the last 10 minutes
  const QUIET_MS = 2 * 60 * 1000;      // "working" with no event for this long says so

  function laneState(s) {
    if (s.ended) return 'ended';
    if (s.waitFor || s.state === 'waiting') return 'needs';
    if (s.state === 'running') return 'working';
    return 'idle';
  }
  const LANE_ORDER = { needs: 0, working: 1, idle: 2, ended: 3 };
  function sortLanes(list) {
    return list.slice().sort((a, b) => {
      const d = LANE_ORDER[laneState(a)] - LANE_ORDER[laneState(b)];
      if (d) return d;
      if (a.waitFor && b.waitFor) return (b.waitFor.forMs || 0) - (a.waitFor.forMs || 0);
      return (a.ageMs || 0) - (b.ageMs || 0);
    });
  }

  // The last ten minutes of tool calls as marks on a time line, newest on the
  // right, older ones fading: a session that is flowing, one that is thinking
  // and one that is stuck look different at a glance, with no log to read.
  function traceEl(s) {
    const acts = Array.isArray(s.activity) ? s.activity : [];
    if (!acts.length) return null;
    // Activity times are the server's clock. The payload says what that clock
    // read when it was sent, and the time since then is measured here, so a
    // phone whose clock disagrees with the PC's still draws the trace right.
    const l = live();
    const sentAt = Number(l && l.now) || 0;
    if (!sentAt) return null;
    const drift = Date.now() - payloadAt;
    const wrap = el('div', 'cw-trace');
    wrap.setAttribute('aria-hidden', 'true');
    let drawn = 0;
    acts.forEach((x) => {
      const endAt = Number(x.at) || 0;
      const age = (sentAt - endAt) + drift;
      if (age < 0 || age > TRACE_MS) return;
      const len = clamp(Number(x.ms) || 0, 0, TRACE_MS);
      const right = 1 - age / TRACE_MS;
      const width = Math.max(0.004, len / TRACE_MS);
      const mark = el('span', 'cw-tick' + (x.ok === false ? ' is-fail' : ''));
      mark.style.left = (clamp(right - width, 0, 1) * 100).toFixed(2) + '%';
      mark.style.width = (width * 100).toFixed(2) + '%';
      mark.style.opacity = (0.28 + 0.72 * right).toFixed(2);
      wrap.appendChild(mark);
      drawn++;
    });
    return drawn ? wrap : null;
  }

  function planRail(s) {
    const todos = Array.isArray(s.todos) ? s.todos : [];
    if (!todos.length) return null;
    const done = todos.filter((x) => x.status === 'done').length;
    const doing = todos.find((x) => x.status === 'doing');
    const rail = el('div', 'cw-rail');
    const segs = el('div', 'cw-rail-segs');
    segs.setAttribute('aria-hidden', 'true');
    todos.forEach((x) => segs.appendChild(el('span', 'cw-rail-seg is-' + x.status)));
    rail.appendChild(segs);
    const text = el('span', 'cw-rail-text');
    text.appendChild(el('span', 'cw-rail-count', done + '/' + todos.length));
    if (doing) text.appendChild(el('span', 'cw-rail-now', doing.text));
    rail.appendChild(text);
    return rail;
  }

  function ctxGauge(pct) {
    const p = clamp(Math.round(pct), 0, 100);
    const g = el('span', 'cw-ctx' + (p >= 90 ? ' is-crit' : p >= 75 ? ' is-warn' : ''));
    g.title = t('claude_ctx_hint', 'How full the context window is');
    const bar = el('span', 'cw-ctx-bar');
    const fill = el('span', 'cw-ctx-fill'); fill.style.width = p + '%';
    bar.appendChild(fill);
    g.appendChild(bar);
    g.appendChild(el('span', 'cw-ctx-val', t('claude_ctx', 'ctx') + ' ' + p + '%'));
    return g;
  }

  function nowLine(s, st) {
    const line = el('div', 'cw-lane-now');
    if (st === 'ended') { line.appendChild(el('span', 'cw-lane-state', endedLabel(s))); return line; }
    if (s.compacting) { line.appendChild(el('span', 'cw-lane-state', t('claude_compacting', 'compacting the conversation'))); return line; }
    if (st === 'needs') {
      const w = s.waitFor || {};
      const label = w.kind === 'permission' ? t('claude_wait_perm', 'Waiting for your approval')
        : w.kind === 'question' ? t('claude_wait_q', 'Waiting for your answer')
          : w.kind === 'error' ? t('claude_wait_err', 'The turn ended on an error')
            : t('claude_state_waiting', 'waiting for you');
      line.appendChild(el('span', 'cw-lane-ask', label));
      if (w.text) line.appendChild(el('span', 'cw-lane-detail', w.text));
      return line;
    }
    if (st === 'working' && s.tool) {
      line.appendChild(el('span', 'cw-lane-intent', toolIntent(s.tool)));
      if (s.toolDetail) line.appendChild(el('span', 'cw-lane-detail', s.toolDetail));
      // How long it has been on this one step: a build and a hang look the same without it.
      if (s.toolForMs > 4000) line.appendChild(ageNode('cw-lane-for', s.toolForMs, ''));
      return line;
    }
    if (st === 'working' && s.ageMs > QUIET_MS) {
      line.appendChild(el('span', 'cw-lane-state', t('claude_thinking', 'Thinking')));
      line.appendChild(ageNode('cw-lane-for is-quiet', s.ageMs, t('claude_quiet_for', 'no activity for') + ' '));
      return line;
    }
    if (s.lastSaid && st !== 'working') { line.appendChild(el('span', 'cw-lane-said', s.lastSaid)); return line; }
    if (s.task) { line.appendChild(el('span', 'cw-lane-task', s.task)); return line; }
    line.appendChild(el('span', 'cw-lane-state', st === 'working' ? t('claude_state_running', 'working') : t('claude_state_idle', 'idle')));
    return line;
  }

  // A session whose request is already on a card above (or full screen) needs
  // one line here, not a second copy of the same command.
  function carded(s) {
    return approvals().some((a) => a.sessionId && a.sessionId === s.id);
  }

  function lane(s) {
    const st = laneState(s);
    const short = st === 'needs' && carded(s);
    const row = el('article', 'cw-lane is-' + st + (s.inferred ? ' is-inferred' : '') + (short ? ' is-carded' : ''));
    // Tapping a lane opens its conversation, to read it or send a follow-up.
    // Only once linked, and only with a session id Claude Code would accept.
    if (linkState && linkState.linked && s.id && !s.inferred) {
      row.classList.add('is-tappable');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      const open = () => openAsk(s.id, s.project || '', '');
      row.addEventListener('click', open);
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
      });
    }

    const top = el('div', 'cw-lane-top');
    // The state is drawn as colour (the edge bar, the dot); its name is said
    // too, for a screen reader and for whoever cannot tell the colours apart.
    const dot = el('span', 'cw-lane-dot');
    dot.setAttribute('aria-hidden', 'true');
    top.appendChild(dot);
    top.appendChild(el('span', 'cw-sr', (st === 'ended' ? endedLabel(s)
      : STATE_LABEL[st === 'needs' ? 'waiting' : st === 'working' ? 'running' : 'idle']()) + ':'));
    top.appendChild(el('span', 'cw-lane-proj', s.project || '?'));
    const tag = sessionTag(s);
    if (tag) top.appendChild(el('span', 'cw-lane-tag', '#' + tag));
    if (s.branch) top.appendChild(el('span', 'cw-lane-branch', s.branch));
    // The one clock a lane shows: how long it has waited for you, or how long
    // since it last did anything.
    const clock = st === 'needs' && s.waitFor
      ? ageNode('cw-lane-clock', s.waitFor.forMs, '')
      : ageNode('cw-lane-clock', s.ageMs, '');
    if (short) {
      const w = s.waitFor || {};
      top.appendChild(el('span', 'cw-lane-ask', w.kind === 'question'
        ? t('claude_wait_q', 'Waiting for your answer') : t('claude_wait_perm', 'Waiting for your approval')));
    }
    // A running step already carries its own timer on the line below.
    if (!(st === 'working' && s.tool && s.toolForMs > 4000)) top.appendChild(clock);
    row.appendChild(top);
    if (short) return row;

    row.appendChild(nowLine(s, st));
    if (st !== 'ended') { const tr = traceEl(s); if (tr) row.appendChild(tr); }

    const foot = el('div', 'cw-lane-foot');
    const rail = planRail(s); if (rail) foot.appendChild(rail);
    if (typeof s.contextPct === 'number') foot.appendChild(ctxGauge(s.contextPct));
    if (s.model) foot.appendChild(el('span', 'cw-lane-model', prettyModel(s.model)));
    if (s.subagents && s.subagents.length) {
      const n = s.subagents.length;
      foot.appendChild(el('span', 'cw-lane-agents', n === 1 ? t('claude_agents_1', '1 agent')
        : t('claude_agents_n', '{n} agents').replace('{n}', String(n))));
    }
    if ((s.linesAdded || 0) + (s.linesRemoved || 0) > 0) {
      const lines = el('span', 'cw-lane-lines');
      lines.appendChild(el('span', 'is-add', '+' + (s.linesAdded || 0)));
      lines.appendChild(el('span', 'is-del', '−' + (s.linesRemoved || 0)));
      foot.appendChild(lines);
    }
    if (foot.childNodes.length) row.appendChild(foot);

    // A follow-up already on its way: queued until the turn ends, cancellable.
    if (s.queued) {
      const q = el('div', 'cw-queued');
      q.appendChild(el('span', 'cw-queued-label', t('claude_queued', 'Queued for the end of this turn')));
      q.appendChild(el('span', 'cw-queued-text', s.queued.text));
      const undo = el('button', 'cw-link-btn'); undo.type = 'button';
      undo.textContent = t('claude_queued_cancel', 'Cancel');
      undo.addEventListener('click', (ev) => { ev.stopPropagation(); cancelReply(s.id); });
      q.appendChild(undo);
      row.appendChild(q);
    }
    return row;
  }

  function lanesPanel() {
    const panel = el('div', 'cw-lanes');
    const list = sessions();
    const active = sortLanes(list.filter((s) => !s.resting));
    const resting = sortLanes(list.filter((s) => s.resting));

    const head = el('div', 'cw-sec-head');
    head.appendChild(el('span', 'cw-sec-title', t('claude_sessions', 'Sessions')));
    const working = active.filter((s) => laneState(s) === 'working').length;
    const needs = active.filter((s) => laneState(s) === 'needs').length;
    const parts = [];
    // One and many are different words in most of the eleven languages.
    const count = (n, one, many, fbOne, fbMany) => (n === 1 ? t(one, fbOne) : t(many, fbMany)).replace('{n}', String(n));
    if (needs) parts.push(count(needs, 'claude_sum_needs_1', 'claude_sum_needs_n', '1 needs you', '{n} need you'));
    if (working) parts.push(count(working, 'claude_sum_working_1', 'claude_sum_working_n', '1 working', '{n} working'));
    if (parts.length) head.appendChild(el('span', 'cw-sec-sum' + (needs ? ' is-needs' : ''), parts.join(' · ')));
    panel.appendChild(head);

    if (!list.length) {
      const empty = el('div', 'cw-empty');
      empty.appendChild(el('div', 'cw-empty-t', t('claude_no_sessions', 'No session running')));
      const u = payload && payload.usage;
      if (u && u.live && u.live.at) empty.appendChild(el('div', 'cw-empty-s', t('claude_last_active', 'last active') + ' ' + dur(u.live.ageMs) + ' · ' + (u.live.project || '')));
      panel.appendChild(empty);
      return panel;
    }
    const scroller = el('div', 'cw-lanes-scroll cw-sess-scroll');
    active.slice(0, 20).forEach((s) => scroller.appendChild(lane(s)));
    if (resting.length) {
      scroller.appendChild(collapsibleTitle('finished', t('claude_sess_finished', 'Finished'), String(resting.length)));
      if (!isCollapsed('finished')) resting.slice(0, 20).forEach((s) => scroller.appendChild(lane(s)));
    }
    panel.appendChild(scroller);
    return panel;
  }

  // ── sections that fold ─────────────────────────────────────────────────────
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

  // ── the Usage face ─────────────────────────────────────────────────────────
  // Everything here describes ONE window and says which: the last 30 days, and
  // the date the data really starts when Claude Code has already deleted older
  // transcripts (it does, so "30 days" can hold eight). Today and "since Monday"
  // are the two exceptions, and are named for exactly what they are. No figure
  // on this face is all-time next to a 30-day one.
  function usageFace(u) {
    const face = el('div', 'cw-usage');
    const w = u.window || { days: 30, startsAt: 0, dataFrom: 0, tokens: 0, cost: 0 };
    // It scrolls and holds nothing focusable, so it takes focus itself: a
    // keyboard can then scroll it too.
    face.tabIndex = 0;
    face.setAttribute('role', 'region');
    face.setAttribute('aria-label', t('claude_usage_window', 'Last {n} days').replace('{n}', String(w.days || 30)));

    const head = el('div', 'cw-sec-head');
    head.appendChild(el('span', 'cw-sec-title', t('claude_usage_window', 'Last {n} days').replace('{n}', String(w.days || 30))));
    if (w.dataFrom && w.startsAt && w.dataFrom > w.startsAt + 86400000) {
      head.appendChild(el('span', 'cw-sec-sum', t('claude_since', 'data since {date}').replace('{date}', fmtDay(w.dataFrom))));
    }
    face.appendChild(head);

    // A ledger, not a row of stat cards: label on the left, figure on the right,
    // one line each, so it reads like a statement.
    const ledger = el('dl', 'cw-ledger');
    const row = (label, value, note, cls) => {
      const r = el('div', 'cw-ledger-row' + (cls ? ' ' + cls : ''));
      r.appendChild(el('dt', null, label));
      const dd = el('dd');
      dd.appendChild(el('span', 'cw-ledger-v', value));
      if (note) dd.appendChild(el('span', 'cw-ledger-n', note));
      r.appendChild(dd);
      ledger.appendChild(r);
    };
    const tok = t('claude_tokens', 'tokens');
    row(t('claude_ledger_today', 'Today'), fmtTokens(u.today.tokens), tok);
    row(t('claude_since_monday', 'Since Monday'), fmtTokens(u.week.tokens), tok);
    row(t('claude_ledger_total', 'Total'), fmtTokens(w.tokens), tok);
    row(t('claude_cache_read', 'Read from cache'), fmtPct(u.cacheHitRate, 1),
      t('claude_cache_read_hint', 'of the input'));
    row(t('claude_ledger_value', 'API value'), fmtMoney(w.cost), t('claude_api_value_hint', 'at list prices'), 'is-value');
    face.appendChild(ledger);

    face.appendChild(daysChart(u));
    const split = el('div', 'cw-split');
    const p = projectList(u, w); if (p) split.appendChild(p);
    const m = modelList(u); if (m) split.appendChild(m);
    face.appendChild(split);
    return face;
  }

  // Thirty days on one axis, today on the right. Each column is that day's
  // tokens, the lower part what was read from cache. Mondays carry their date
  // so the week is findable; days with no work are an empty slot, not a gap in
  // the axis.
  function daysChart(u) {
    const wrap = el('div', 'cw-days');
    const chart = el('div', 'cw-days-bars');
    const max = u.daily.reduce((mx, d) => Math.max(mx, d.tokens), 0) || 1;
    const last = u.daily.length - 1;
    u.daily.forEach((d, i) => {
      const [y, mo, da] = d.day.split('-').map(Number);
      const date = new Date(y, mo - 1, da);
      const col = el('div', 'cw-day' + (i === last ? ' is-today' : '') + (date.getDay() === 1 ? ' is-monday' : ''));
      col.title = fmtDay(date.getTime()) + ' · ' + fmtTokens(d.tokens) + ' ' + t('claude_tokens', 'tokens');
      const h = d.tokens > 0 ? Math.max(2, Math.round((d.tokens / max) * 100)) : 0;
      // Two blocks, not an overlay: a translucent layer over the bar's own fill
      // came out LIGHTER than the rest, the opposite of what the legend said.
      const stack = el('div', 'cw-day-stack'); stack.style.height = h + '%';
      const cache = el('div', 'cw-day-cache');
      cache.style.height = (d.tokens > 0 ? Math.round(clamp(d.cacheRead / d.tokens, 0, 1) * 100) : 0) + '%';
      stack.appendChild(el('div', 'cw-day-fresh'));
      stack.appendChild(cache);
      col.appendChild(stack);
      if (date.getDay() === 1 || i === last) col.appendChild(el('span', 'cw-day-tick', String(date.getDate())));
      chart.appendChild(col);
    });
    wrap.appendChild(chart);
    const legend = el('div', 'cw-days-legend');
    const item = (cls, text) => { const s = el('span', 'cw-leg'); s.appendChild(el('i', cls)); s.appendChild(document.createTextNode(text)); return s; };
    legend.appendChild(item('is-cache', t('claude_leg_cache', 'read from cache')));
    legend.appendChild(item('is-fresh', t('claude_leg_fresh', 'everything else')));
    wrap.appendChild(legend);
    return wrap;
  }

  function projectList(u, w) {
    if (!u.projects || !u.projects.length) return null;
    const box = el('div', 'cw-projects');
    box.appendChild(el('div', 'cw-sec-title', t('claude_projects', 'Projects')));
    const total = w.tokens || u.projects.reduce((s, x) => s + x.tokens, 0) || 1;
    u.projects.slice(0, 6).forEach((x) => {
      const r = el('div', 'cw-bar-row');
      r.appendChild(el('span', 'cw-bar-name', x.name));
      const track = el('span', 'cw-bar-track');
      const fill = el('span', 'cw-bar-fill'); fill.style.width = clamp((x.tokens / total) * 100, 0.5, 100).toFixed(1) + '%';
      track.appendChild(fill);
      r.appendChild(track);
      // Share of the whole window, so the column adds up to 100 with the rest.
      const pct = (x.tokens / total) * 100;
      r.appendChild(el('span', 'cw-bar-val', fmtPct(pct / 100, pct >= 10 ? 0 : 1)));
      box.appendChild(r);
    });
    const more = (u.projectCount || u.projects.length) - Math.min(6, u.projects.length);
    if (more > 0) box.appendChild(el('div', 'cw-bar-more', t('claude_more_projects', '+{n} more').replace('{n}', String(more))));
    return box;
  }

  function modelList(u) {
    const models = (u.models || []).filter((m) => m.tokens > 0);
    if (!models.length) return null;
    const box = el('div', 'cw-models');
    box.appendChild(el('div', 'cw-sec-title', t('claude_models', 'Models')));
    const total = models.reduce((s, x) => s + x.tokens, 0) || 1;
    const bar = el('div', 'cw-model-bar');
    models.forEach((m) => {
      const seg = el('span', 'cw-model-seg');
      seg.style.width = ((m.tokens / total) * 100).toFixed(2) + '%';
      seg.style.background = modelHue(m.model);
      bar.appendChild(seg);
    });
    box.appendChild(bar);
    models.slice(0, 4).forEach((m) => {
      const r = el('div', 'cw-model-row');
      const dot = el('i', 'cw-model-dot'); dot.style.background = modelHue(m.model);
      r.appendChild(dot);
      r.appendChild(el('span', 'cw-model-name', prettyModel(m.model)));
      r.appendChild(el('span', 'cw-model-tok', fmtTokens(m.tokens)));
      r.appendChild(el('span', 'cw-model-cost', fmtMoney(m.cost)));
      box.appendChild(r);
    });
    return box;
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

  // Which of the two things writing here will do. A session mid-turn takes the
  // follow-up path — the text lands in THAT conversation when the turn ends. An
  // idle one has no turn left to end, so nothing could deliver it, and it is
  // continued as a resumed run instead. Same conversation either way; the
  // composer says which before you press send, rather than one box that quietly
  // behaves as either.
  function replyMode() {
    if (!askResumeId) return 'new';
    const s = sessions().find((x) => x.id === askResumeId);
    if (!s || s.ended) return 'none';
    if (s.queued) return 'queued';
    return (s.state === 'running' || s.state === 'waiting') ? 'followup' : 'resume';
  }

  async function submitAsk() {
    const prompt = askText.trim();
    if (!prompt || askBusy) return;

    // Follow-up into a turn that is still running: queue it, do not start a
    // second process against the same conversation.
    if (replyMode() === 'followup') {
      askBusy = true; askError = ''; paint();
      const q = await queueReply(askResumeId, prompt);
      askBusy = false;
      if (q.ok) { askText = ''; askAttach = []; }
      else askError = replyErrorText(q.error);
      paint();
      return;
    }

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

  function replyErrorText(code) {
    if (code === 'already_queued') return t('claude_reply_e_queued', 'There is already a message waiting to be delivered');
    if (code === 'session_ended') return t('claude_reply_e_ended', 'That session has closed');
    if (code === 'unknown_session') return t('claude_reply_e_unknown', 'Xenon has lost track of that session');
    return t('claude_reply_e_failed', 'Could not queue that message');
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
    ta.dataset.keep = 'ask';
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

    const mode = replyMode();
    const send = el('button', 'cw-ask-send'); send.type = 'button';
    send.textContent = askBusy
      ? (mode === 'followup' ? t('claude_reply_sending', 'Queueing…') : t('claude_ask_sending', 'Starting…'))
      : (askResumeId ? t('claude_ask_send_more', 'Send') : t('claude_ask_send', 'Start'));
    send.disabled = askBusy || mode === 'none' || (askProjects !== null && !askProjects.length);
    send.addEventListener('click', () => { askText = ta.value; submitAsk(); });
    bar.appendChild(send);

    box.appendChild(bar);
    // Say where the text is going BEFORE it is sent. The two destinations look
    // identical from here and behave differently, and the old composer only ever
    // did one of them whatever it looked like it was doing.
    const note = mode === 'followup' ? t('claude_reply_note', 'Goes into this session when the current turn ends')
      : mode === 'resume' ? t('claude_resume_note', 'Continues this conversation in the background')
        : mode === 'queued' ? t('claude_queued_note', 'A message is already waiting to be delivered')
          : mode === 'none' ? t('claude_reply_e_ended', 'That session has closed')
            : '';
    if (note) box.appendChild(el('div', 'cw-ask-note' + (mode === 'none' ? ' is-warn' : ''), note));
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
  // ── the frame: header, faces, the connection notice ────────────────────────
  // Two faces instead of one long scroll: LIVE is what is happening and what
  // needs you, USAGE is the record. The choice is per surface and survives a
  // reload (a view preference, so localStorage, not the settings store).
  const FACE_KEY = 'xeneonedge.claude.face.v1';
  const REPAIR_SEEN_KEY = 'xeneonedge.claude.repairSeen.v1';
  let face = null;
  function currentFace() {
    if (face) return face;
    try { face = localStorage.getItem(FACE_KEY) === 'usage' ? 'usage' : 'live'; } catch { face = 'live'; }
    return face;
  }
  function setFace(f) {
    face = f === 'usage' ? 'usage' : 'live';
    try { localStorage.setItem(FACE_KEY, face); } catch { /* private mode: session only */ }
    paint();
  }

  function header() {
    const h = el('div', 'cw-top');
    const title = el('div', 'cw-name');
    // The connection as a mark, not a sentence: complete, partly there, or off.
    const state = !linkState ? 'unknown' : !linkState.linked ? 'off' : linkState.complete === false ? 'partial' : 'on';
    const mark = el('span', 'cw-link-mark is-' + state);
    mark.title = state === 'on' ? t('claude_connected', 'Connected')
      : state === 'partial' ? t('claude_link_incomplete', 'Part of the Claude Code connection is missing.')
        : t('claude_cta', 'Show real quota and approve from here');
    title.appendChild(mark);
    title.appendChild(el('span', 'cw-name-t', 'Claude Code'));
    title.setAttribute('role', 'button');
    title.tabIndex = 0;
    const openLink = () => { linkPanel = true; paint(); };
    title.addEventListener('click', openLink);
    title.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openLink(); } });
    h.appendChild(title);

    const faces = el('div', 'cw-faces');
    faces.setAttribute('role', 'tablist');
    [['live', t('claude_face_live', 'Live')], ['usage', t('claude_face_usage', 'Usage')]].forEach(([id, label]) => {
      const b = el('button', 'cw-face' + (currentFace() === id ? ' is-on' : ''), label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', currentFace() === id ? 'true' : 'false');
      b.addEventListener('click', () => setFace(id));
      faces.appendChild(b);
    });
    h.appendChild(faces);

    if (linkState && linkState.linked) {
      const ask = el('button', 'cw-ask-open'); ask.type = 'button';
      ask.textContent = t('claude_ask_open', 'Ask');
      ask.addEventListener('click', () => openAsk('', '', ''));
      h.appendChild(ask);
    } else {
      h.appendChild(linkButton());
    }
    return h;
  }

  // What changed about the connection, said once where it matters. A repair
  // only reaches sessions started after it (Claude Code reads its hooks when a
  // session starts), so the notice says to restart the open ones.
  function linkNotice() {
    if (!linkState || !linkState.linked) return null;
    if (linkState.complete === false) {
      const n = el('div', 'cw-notice is-warn');
      n.appendChild(el('span', 'cw-notice-t', t('claude_link_incomplete', 'Part of the Claude Code connection is missing.')));
      const b = el('button', 'cw-link-btn'); b.type = 'button';
      b.textContent = t('claude_link_repair', 'Repair');
      b.addEventListener('click', () => doLink(true));
      n.appendChild(b);
      return n;
    }
    let seen = 0;
    try { seen = Number(localStorage.getItem(REPAIR_SEEN_KEY)) || 0; } catch { /* private mode */ }
    if (linkState.repairedAt && linkState.repairedAt > seen) {
      const n = el('div', 'cw-notice');
      n.appendChild(el('span', 'cw-notice-t', t('claude_link_repaired', 'The Claude Code connection was updated. Restart the Claude Code sessions that are open to use it.')));
      const b = el('button', 'cw-link-btn'); b.type = 'button';
      b.textContent = t('claude_notice_ok', 'OK');
      b.addEventListener('click', () => {
        try { localStorage.setItem(REPAIR_SEEN_KEY, String(linkState.repairedAt)); } catch { /* private mode */ }
        paint();
      });
      n.appendChild(b);
      return n;
    }
    return null;
  }

  function build() {
    const wrap = el('div', 'cw-wrap');
    if (editing) { wrap.appendChild(budgetEditor()); return wrap; }
    if (linkPanel) { wrap.appendChild(linkPanelView()); return wrap; }
    if (askOpen) { wrap.appendChild(askPanel()); return wrap; }

    wrap.appendChild(header());
    const notice = linkNotice(); if (notice) wrap.appendChild(notice);

    // Decisions render first and on both faces: a blocked tool call must never
    // wait behind a tab, a loading placeholder or a scroll position. The one
    // escalated to full screen is drawn there instead of twice.
    const pend = approvals().filter((a) => !a.urgent);
    if (pend.length) {
      const box = el('div', 'cw-decs');
      // Two at most, side by side on a wide tile (see .cw-decs.is-pair).
      if (pend.length > 1) box.classList.add('is-pair');
      pend.slice(0, 2).forEach((a) => box.appendChild(decisionCard(a, false)));
      if (pend.length > 2) box.appendChild(el('div', 'cw-decs-more', t('claude_more_waiting', '{n} more waiting').replace('{n}', String(pend.length - 2))));
      wrap.appendChild(box);
    }

    const rl = runs();
    if (rl.length) {
      const box = el('div', 'cw-run-list');
      rl.slice(-2).forEach((r) => box.appendChild(runCard(r)));
      wrap.appendChild(box);
    }

    const u = payload && payload.usage;
    if (currentFace() === 'usage') {
      if (!u) { wrap.appendChild(el('div', 'cw-state', t('claude_reading', 'Reading local Claude Code sessions…'))); return wrap; }
      wrap.appendChild(usageFace(u));
      return wrap;
    }

    if (!u && !sessions().length) {
      wrap.appendChild(el('div', 'cw-state', t('claude_reading', 'Reading local Claude Code sessions…')));
      return wrap;
    }
    const grid = el('div', 'cw-livegrid');
    grid.appendChild(lanesPanel());
    grid.appendChild(quotaPanel());
    wrap.appendChild(grid);
    return wrap;
  }

  // ── ticking ────────────────────────────────────────────────────────────────
  // Only the countdown texts change every second. Repainting the whole tile for
  // that would throw away scroll position and fight the user's taps, so the tick
  // mutates just those nodes — and stops entirely when nothing counts down.
  function tick() {
    const nodes = document.querySelectorAll('[data-reset-at], [data-expires-at], [data-age-base]');
    nodes.forEach(n => {
      if (n.dataset.resetAt) n.textContent = until(Number(n.dataset.resetAt));
      else if (n.dataset.expiresAt) n.textContent = (n.dataset.tpl || '{t}').replace('{t}', mmss(Number(n.dataset.expiresAt) - Date.now()));
      else n.textContent = (n.dataset.agePrefix || '') + dur(aged(Number(n.dataset.ageBase)));
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
    // A finger is on the widget: see "a tap must survive an SSE push".
    if (pressing) { renderDeferred = true; return; }
    // Half-made choices belong to cards that still exist. Approval ids are
    // unique per request, so without this the map keeps one entry per question
    // ever asked, for as long as the page is open — the unbounded Map the
    // codebase rules out everywhere else.
    forgetSeen();
    if (qsel.size || typedAns.size) {
      const alive = new Set(approvals().map(a => a.id));
      for (const id of qsel.keys()) if (!alive.has(id)) qsel.delete(id);
      for (const id of typedAns.keys()) if (!alive.has(id)) typedAns.delete(id);
    }
    tiles().forEach(tile => {
      const mount = tile.querySelector('.claude-widget-mount');
      if (!mount) return;
      // Nothing on a parked page is on screen, and the scroll reads just below
      // are LAYOUT reads: performing them there forces Chromium to render the
      // very subtree the parking exists to skip (the "Rendering was performed in
      // a subtree hidden by content-visibility" console flood), on every SSE
      // push, to rebuild a tile nobody can see and preserve a scroll position
      // nobody is holding. The page-change listener below repaints it at the one
      // moment it can next be looked at. The overlay, topbar marker and ticker
      // are handled outside this loop and stay live regardless of page.
      if (isParked(tile)) return;
      // A repaint rebuilds the tile, and an SSE push can land at any moment —
      // so without this the session list would jump back to the top while the
      // user is scrolling through it.
      // Every area that scrolls: the lanes, the Live face on a narrow tile, the
      // Usage face, the decisions and each card's body. Without this a push
      // threw whoever was reading the Usage face back to its top every time.
      const kept = keepScroll(mount);
      // The conversation gets the same treatment, and needs it more: it now
      // reloads itself every couple of seconds while a session works, so
      // without this every refresh would throw the reader back to the top
      // mid-paragraph. threadView() re-pins to the bottom only when the reader
      // was already there.
      const prevThread = mount.querySelector('.cw-thread');
      const keepThread = prevThread ? prevThread.scrollTop : 0;
      const focus = keepFocus(mount);
      mount.replaceChildren(build());
      restoreScroll(mount, kept);
      focus();
      if (keepThread && threadAtBottom === false) {
        const nextThread = mount.querySelector('.cw-thread');
        if (nextThread) nextThread.scrollTop = keepThread;
      }
    });
    syncOverlay();
    const needsTick = !!(limits() || approvals().length || sessions().length);
    if (needsTick) startTicker(); else stopTicker();
  }

  // A text box inside a rebuilt subtree is a NEW element, so typing into one
  // while a session works lost focus on the next push, several times a second.
  // Boxes that carry `data-keep` get focus and caret back after the rebuild;
  // their text survives because it is held in state, not in the DOM.
  function keepFocus(root) {
    const a = document.activeElement;
    const k = a && root.contains(a) && a.dataset ? a.dataset.keep : '';
    if (!k) return () => {};
    let s = null, e = null;
    try { s = a.selectionStart; e = a.selectionEnd; } catch { /* a number input has no selection */ }
    return () => {
      const n = Array.from(root.querySelectorAll('[data-keep]')).find((x) => x.dataset.keep === k);
      if (!n || n.disabled) return;
      try { n.focus({ preventScroll: true }); } catch { return; }
      if (s !== null) { try { n.setSelectionRange(s, e); } catch { /* not a text field */ } }
    };
  }

  const SCROLLERS = ['.cw-sess-scroll', '.cw-livegrid', '.cw-usage', '.cw-decs', '.cw-dec-body', '.cw-dec-plan', '.cw-dec-cmd'];
  function keepScroll(root) {
    return SCROLLERS.map((sel) => Array.from(root.querySelectorAll(sel), (n) => n.scrollTop));
  }
  function restoreScroll(root, kept) {
    SCROLLERS.forEach((sel, i) => {
      root.querySelectorAll(sel).forEach((n, j) => { if (kept[i][j]) n.scrollTop = kept[i][j]; });
    });
  }

  async function seed() {
    if (seedInflight) return;
    seedInflight = true;
    try {
      const d = await api('/api/claude');
      if (d) { payload = d; payloadAt = Date.now(); }
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
      //
      // And only a real FINISH. "Not running" used to be enough, which meant a
      // session that stopped to ask for a permission was announced as having
      // finished answering — the opposite of what had happened, at the one
      // moment the user most needed to know the difference. A session that was
      // killed is not an announcement either: it has nothing to show and
      // nothing to continue.
      const finished = was === 'running' && s.state === 'idle' && !s.waitFor
        && !(s.ended && s.endedReason === 'gone');
      if (finished) {
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

  // ── Clawd ───────────────────────────────────────────────────────────────────
  // Claude Code's own pixel mascot, in the top bar, animated by what the session
  // is doing. It replaced a text pill and then a generic four-point sparkle:
  // neither said whose session this was, and the pill spent six characters
  // saying what a shape says instantly.
  //
  // The geometry is not a drawing from memory. It was read back out of the
  // sprite: the PNG was decoded, the body colour measured (#D77757, which is the
  // orange this codebase already carries as #D97757 — one step off in red, and
  // the established value is what ships; see the note in ClaudeWidget.css), the
  // cell edges found from the pixel runs, and the whole thing resampled onto its
  // real 16x12 grid:
  //
  //     ..############..      rows 0-1   head
  //     ..############..
  //     ..##.######.##..      rows 2-4   eyes, as HOLES at cols 4 and 11
  //     ..##.######.##..
  //     ..##.######.##..
  //     ################      rows 5-6   arms, two cells proud on each side
  //     ################
  //     ..############..      rows 7-9   body
  //     ..############..
  //     ..############..
  //     ...#.#....#.#...      rows 10-11 four legs, at cols 3, 5, 10, 12
  //     ...#.#....#.#...
  //
  // Drawn as merged runs rather than 150 one-unit rects, split into the groups
  // the animation needs to move independently: the shell, each pair of legs, and
  // two eye covers that are painted in the body colour to blink.
  const CLAWD = Object.freeze({
    shell: [[2, 0, 12, 2], [2, 2, 2, 3], [5, 2, 6, 3], [12, 2, 2, 3], [0, 5, 16, 2], [2, 7, 12, 3]],
    legL: [[3, 10, 1, 2], [5, 10, 1, 2]],
    legR: [[10, 10, 1, 2], [12, 10, 1, 2]],
    eyes: [[4, 2, 1, 3], [11, 2, 1, 3]],
  });
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function rects(parent, list, cls) {
    const g = document.createElementNS(SVG_NS, 'g');
    if (cls) g.setAttribute('class', cls);
    for (const [x, y, w, h] of list) {
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('x', x); r.setAttribute('y', y);
      r.setAttribute('width', w); r.setAttribute('height', h);
      g.appendChild(r);
    }
    parent.appendChild(g);
    return g;
  }
  function clawd() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 12');
    svg.setAttribute('class', 'cw-tb-mark');
    svg.setAttribute('aria-hidden', 'true');
    // Square pixels, whatever the device ratio: the whole point of the thing.
    svg.setAttribute('shape-rendering', 'crispEdges');
    rects(svg, CLAWD.shell, 'cw-cl-shell');
    rects(svg, CLAWD.legL, 'cw-cl-leg cw-cl-legl');
    rects(svg, CLAWD.legR, 'cw-cl-leg cw-cl-legr');
    // Same colour as the shell, revealed only for a blink. An eye is a hole in
    // this sprite, so closing one means filling it back in.
    rects(svg, CLAWD.eyes, 'cw-cl-eyes');
    return svg;
  }

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
    // A session filed under Finished contributes nothing to any of these. It is
    // not working, it is not blocked, and it cannot become either without an
    // event that would move it back out — a 47-minute-old session was putting
    // the bar into its loudest state while two others were actually running.
    const list = sessions().filter(s => !s.ended && !s.resting);
    const working = list.filter(s => s.state === 'running').length;
    const done = otherNotices().length ? doneNotices.length : 0;
    // A card the user can answer, or a session blocked with no card to answer.
    const pending = approvals().length || list.filter(s => s.waitFor).length;

    // Rebuilding on every payload would restart the animation several times a
    // second while a session is busy — exactly when it must look calm. Only
    // redraw when what the chip MEANS changes.
    const sig = `${working}|${done}|${pending}`;
    if (sig === topbarSig) return;
    topbarSig = sig;

    // Nothing happening → the island gives the space back rather than holding an
    // empty chip. An approval always shows: it is the one thing that blocks.
    if (!working && !done && !pending) { host.hidden = true; host.replaceChildren(); return; }

    host.hidden = false;
    // These are not alternatives, and writing them as a ladder is what made the
    // bar read "finished" while the widget next to it said "1 running": one
    // session ending outranked another that was still working, and the two
    // surfaces contradicted each other on screen at the same time.
    //
    // They are two different questions, so they get two different channels.
    // MOTION says what is happening — walking, hopping, still. The DOT says
    // whether something is for you — amber blocked, accent a result you have not
    // read. A session finishing while another works is Clawd walking with an
    // accent dot, which is both facts at once instead of the louder one winning.
    const state = pending ? 'is-waiting' : (working ? 'is-working' : 'is-done');
    const chip = el('button', 'cw-tb ' + state);
    chip.type = 'button';
    // The mark, not a word. A pill reading "wants your OK" spent the width of
    // six characters saying something the colour says instantly, and it said it
    // next to a clock, where nobody reads sentences. State is carried by colour
    // and by how the mark moves: it turns slowly while Claude works, holds still
    // when there is an answer to read, and knocks when it is blocked on you.
    // The words stay in the tooltip, which is where a word belongs here.
    chip.appendChild(clawd());
    // The tooltip lists everything that is true, for the same reason: it is read
    // right next to a widget that lists it all, and the two must not disagree.
    const parts = [];
    if (pending) parts.push(t('claude_bar_waiting', 'wants your OK'));
    if (working) parts.push(t('claude_bar_working', 'working'));
    if (done) parts.push(t('claude_bar_done', 'finished'));
    const label = parts.join(' · ');
    // A dot rather than a recolour: at this size, repainting Clawd costs the one
    // thing he is there for, which is being recognisably Claude.
    //
    // And the dot is what makes the state legible WITHOUT MOTION, which matters
    // more than it looks. Four dashboard states pause every animation — a dialog
    // open, a minute without touches, game mode, Performance Mode — and on a
    // machine with any of them on, a design that says "working" only by walking
    // says nothing at all: standing still, working and finished were the same
    // picture. Motion is the enhancement here; the dot is the signal.
    //   nothing   Clawd alone, quiet
    //   accent    finished, and you have not looked
    //   amber     blocked on you
    if (pending) chip.appendChild(el('span', 'cw-tb-alert'));
    else if (done) chip.appendChild(el('span', 'cw-tb-alert is-done'));
    if (working > 1 && !pending) chip.appendChild(el('span', 'cw-tb-n', String(working)));
    chip.title = label;
    chip.setAttribute('aria-label', label);
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

  // ── a tap must survive an SSE push ─────────────────────────────────────────
  // A tap is pointerdown + pointerup on the SAME element. The tile, the overlay
  // and the topbar marker are rebuilt from scratch on every push, and while any
  // other session is working those arrive several times a second, so a button
  // replaced between the two halves of a tap never received its click. That was
  // "I tap Allow, or an answer, and nothing happens". While a pointer is down on
  // any of the three, rebuilds wait, and run just after the click lands.
  const PRESS_SCOPE = '.claude-widget-mount, .cw-overlay, #clock-claude';
  function renderNow() {
    syncTopbar();
    if (!tiles().length) syncOverlay();
    else paint();
  }
  function releasePress() {
    if (!pressing) return;
    pressing = false;
    clearTimeout(pressTimer);
    if (!renderDeferred) return;
    renderDeferred = false;
    // After the click, not before it: click is dispatched after pointerup in
    // the same input task, and a timer only runs once that task is over.
    setTimeout(renderNow, 40);
  }
  document.addEventListener('pointerdown', (e) => {
    const target = e.target;
    if (!(target && target.closest && target.closest(PRESS_SCOPE))) return;
    pressing = true;
    clearTimeout(pressTimer);
    // A release can happen where we never hear about it (the pointer left the
    // window); rendering is never held back for longer than a long press.
    pressTimer = setTimeout(releasePress, 2500);
  }, true);
  document.addEventListener('pointerup', releasePress, true);
  document.addEventListener('pointercancel', releasePress, true);

  function onSSE(data) {
    if (!data) return;
    payload = data;
    payloadAt = Date.now();
    // Presence runs on EVERY payload, before the early return below: the topbar
    // marker and the "another session answered" notice have to keep working
    // when the tile is on another page, or not on the dashboard at all.
    trackPresence();
    // A session that just started or just stopped working flips whether the
    // thread needs watching, so the poll is re-evaluated on every payload.
    syncThreadPoll();
    if (pressing) { renderDeferred = true; return; }
    // The overlay is global, so live state has to be applied even when the tile
    // isn't mounted on the current page.
    renderNow();
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

  // A tile on a parked page skips its rebuild in paint(), so it can be holding
  // state from before the page was parked. Landing on the page is exactly when
  // that becomes visible, so redraw it from the payload already in hand.
  window.addEventListener('xenon:page-change', () => { if (tiles().length) paint(); });

  window.ClaudeWidget = { renderWidgets, onSSE, onSettingsChanged };
})();
