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
//   CHATS face (js/claude-history.js): every chat kept on this PC, with its
//     size, and a confirmed move of the chosen ones to the Recycle Bin.
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
  // The one line that installs the Claude Code mod (integrations/claude-code/).

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
    return f ? f() : (window.ClaudeIdent.toolLabel(tool) || 'tool');
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
  // The rail (js/claude-rail.js) and the console (js/claude-console.js) draw
  // them; the helpers they share live here, next to the words they use.
  const QUIET_MS = 2 * 60 * 1000;      // "working" with no event for this long says so

  function stateLabel(s, st) {
    if (st === 'ended') return endedLabel(s);
    return STATE_LABEL[st === 'needs' ? 'waiting' : st === 'working' ? 'running' : 'idle']();
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

  // One line of what a session is doing, for its rail card.
  function nowLine(s, st) {
    const line = el('div', 'cw-lane-now');
    if (st === 'ended') { line.appendChild(el('span', 'cw-lane-state', endedLabel(s))); return line; }
    if (s.compacting) { line.appendChild(el('span', 'cw-lane-state', t('claude_compacting', 'compacting the conversation'))); return line; }
    if (st === 'needs') {
      const w = s.waitFor || {};
      line.appendChild(el('span', 'cw-lane-ask', w.kind === 'permission' ? t('claude_wait_perm', 'Waiting for your approval')
        : w.kind === 'question' ? t('claude_wait_q', 'Waiting for your answer')
          : w.kind === 'error' ? t('claude_wait_err', 'The turn ended on an error')
            : t('claude_state_waiting', 'waiting for you')));
      return line;
    }
    if (st === 'working' && s.tool) {
      line.appendChild(el('span', 'cw-spin is-on'));
      line.appendChild(el('span', 'cw-lane-intent', toolIntent(s.tool)));
      if (s.toolDetail) line.appendChild(el('span', 'cw-lane-detail', s.toolDetail));
      return line;
    }
    if (st === 'working' && s.ageMs > QUIET_MS) {
      line.appendChild(el('span', 'cw-lane-state', t('claude_thinking', 'Thinking')));
      line.appendChild(ageNode('cw-lane-for is-quiet', s.ageMs, t('claude_quiet_for', 'no activity for') + ' '));
      return line;
    }
    if (st === 'working') {
      line.appendChild(el('span', 'cw-spin is-on'));
      line.appendChild(el('span', 'cw-lane-state', t('claude_state_running', 'working')));
      return line;
    }
    if (s.lastSaid) { line.appendChild(el('span', 'cw-lane-said', s.lastSaid)); return line; }
    if (s.task) { line.appendChild(el('span', 'cw-lane-task', s.task)); return line; }
    line.appendChild(el('span', 'cw-lane-state', t('claude_state_idle', 'idle')));
    return line;
  }

  // A follow-up already on its way: queued until the turn ends, cancellable.
  function queuedRow(s) {
    const q = el('div', 'cw-queued');
    q.appendChild(el('span', 'cw-queued-label', t('claude_queued', 'Queued for the end of this turn')));
    q.appendChild(el('span', 'cw-queued-text', s.queued.text));
    const undo = el('button', 'cw-link-btn'); undo.type = 'button';
    undo.textContent = t('claude_queued_cancel', 'Cancel');
    undo.addEventListener('click', () => cancelReply(s.id));
    q.appendChild(undo);
    return q;
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
    const mod = live() && live().mod;
    const modSetUp = !!(linkState && linkState.modEnabled);
    if (!linked) note(t('claude_link_note_mod', 'Also installs the Xenon mod for Claude Code.'));
    else if (mod) note(t('claude_mod_on', 'The Xenon mod is active in Claude Code.'));
    else if (modSetUp) note(t('claude_mod_pending', 'The mod is set up. It starts with your next Claude Code session.'));
    else note(t('claude_mod_hint', 'Not installed yet: adds subagent models, live context and approvals on this screen.'));
    wrap.appendChild(notes);

    const acts = el('div', 'cw-panel-acts');
    const go = el('button', 'cw-panel-go' + (linked ? ' is-off' : '')); go.type = 'button';
    go.disabled = linking;
    go.textContent = linking
      ? t('claude_working', 'Working…')
      : (linked ? t('claude_disconnect', 'Disconnect') : t('claude_connect_go', 'Connect'));
    go.addEventListener('click', () => doLink(!linked));
    acts.appendChild(go);
    // One tap for a link made before the mod existed: connecting again writes the
    // same hooks and adds the mod.
    if (linked && !mod && !modSetUp) {
      const add = el('button', 'cw-panel-go'); add.type = 'button';
      add.disabled = linking;
      add.textContent = t('claude_mod_install', 'Install the mod');
      add.addEventListener('click', () => doLink(true));
      acts.appendChild(add);
    }
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
  let askProjects = null;      // null = not loaded yet, [] = none found
  let askProjectId = '';
  let askText = '';
  let askBusy = false;
  let askError = '';
  let askResumeId = '';        // set when continuing an existing session
  let askResumeLabel = '';
  let askModel = '';           // '' = whatever the project's own config picks
  let askRunMode = '';         // '' = the user's own default permission mode
  let askEffort = '';          // '' = the model's default effort
  // What this Claude Code accepts for a run, read from its --help on the server.
  let askOptions = { effort: false, modes: [] };
  let askAttach = [];          // [{ name, path, size }] — server-written files
  let askAttachBusy = false;
  // The open session's conversation (js/claude-thread.js): re-reads after every
  // state change until the turn has closed, so the end of a reply is never missed.
  const thread = window.ClaudeThread.create({ fetchJson: (url) => api(url), onChange: () => paint() });

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

  let askProjectsLoading = false;
  async function loadAskProjects(force) {
    // Every tile's build() may ask; one request answers them all.
    if (askProjectsLoading) return;
    askProjectsLoading = true;
    const d = await api('/api/claude/projects' + (force ? '?refresh=1' : ''));
    askProjectsLoading = false;
    askProjects = (d && Array.isArray(d.projects)) ? d.projects : [];
    if (d && d.options) {
      askOptions = {
        effort: d.options.effort === true,
        modes: Array.isArray(d.options.modes) ? d.options.modes.filter((m) => RUN_MODE_LABELS[m]) : [],
      };
    }
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

  // ── which session the console shows ────────────────────────────────────────
  // One session at a time, beside the rail, never a separate screen: the old
  // modal panel is what made it easy to lose track of which chat was which.
  // `picked` is a choice the user made and sticks until they make another;
  // without one the console takes the session that needs you most, ONCE, and
  // keeps it while it lives, so it never jumps under a finger because another
  // session changed state.
  let picked = '';
  let pickedLabel = '';
  let autoPicked = '';
  let composing = false;       // the console holds a new session instead
  let followRun = '';          // a new run whose session the console moves to once known
  const drafts = new Map();    // session id ('' = new session) → unsent text

  function sessionById(id) { return id ? (sessions().find((s) => s.id === id) || null) : null; }

  function consoleTarget() {
    if (composing) return '';
    if (picked) return picked;
    const list = sessions();
    if (autoPicked && list.some((s) => s.id === autoPicked)) return autoPicked;
    const first = window.ClaudeRail.sort(list.filter((s) => !s.resting))[0] || window.ClaudeRail.sort(list)[0];
    autoPicked = first ? first.id : '';
    return autoPicked;
  }

  // A new run gets its session id from Claude Code's first event; until then
  // the console stays on the new-session view, which shows the run's card.
  function followNewRun() {
    if (!followRun) return;
    const r = runs().find((x) => x.id === followRun);
    if (!r || r.state !== 'running') { followRun = ''; if (r && r.sessionId) select(r.sessionId, r.project || ''); return; }
    if (r.sessionId) { followRun = ''; picked = r.sessionId; pickedLabel = r.project || ''; composing = false; }
  }

  // Applies the target: swaps the draft, points the thread at it. Idempotent,
  // so every tile's build() can call it.
  function syncSelection() {
    followNewRun();
    const id = consoleTarget();
    if (id !== askResumeId) {
      drafts.set(askResumeId, askText);
      askText = drafts.get(id) || '';
      drafts.delete(id);
      askAttach = []; askError = '';
      askResumeId = id;
      const s = sessionById(id);
      askResumeLabel = s ? (s.project || '') : (id === picked ? pickedLabel : '');
      if (askProjects !== null) resolveAskProject();
      if (id && doneNotices.some((n) => n.id === id)) { doneNotices = doneNotices.filter((n) => n.id !== id); topbarSig = ''; }
    }
    if (thread.id !== id) thread.open(id);
    if (drafts.size > 20) drafts.delete(drafts.keys().next().value);
  }

  function select(id, label) {
    picked = id || '';
    pickedLabel = label || '';
    composing = false;
    if (currentFace() !== 'live') setFace('live');
    paint();
  }

  // Kept under its old name: the Chats face, the topbar marker and a finished
  // notice all open a session through it. No id = a new session.
  function openAsk(resumeId, resumeLabel, projectId) {
    if (projectId) askProjectId = projectId;
    if (resumeId) { select(resumeId, resumeLabel); }
    else {
      composing = true;
      if (currentFace() !== 'live') setFace('live');
      paint();
    }
    if (askProjects === null) loadAskProjects(false);
  }
  function closeAsk() {
    composing = false;
    paint();
  }

  // The controller polls while the session runs and settles after every state
  // change; it only needs the live record on each push.
  function syncThread() {
    if (thread.id) thread.sync(sessionById(thread.id));
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
    // A chat the terminal has closed (or one opened from the Chats face) is
    // still on disk, and `claude --resume` continues it in the background.
    if (!s || s.ended) return 'resume';
    // A session only the registry file shows is not wired to the hooks, so a
    // follow-up could never be delivered into it.
    if (s.inferred || s.unlinked) return 'none';
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
        mode: askOptions.modes.includes(askRunMode) ? askRunMode : '',
        effort: askOptions.effort ? askEffort : '',
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
        thread.setAtBottom(true);
        thread.load();
        paint();
      } else {
        // A new run has no session id yet. The console keeps showing its card
        // and moves to the session as soon as Claude Code names it.
        followRun = d.id || '';
        paint();
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
    const spin = el('span', 'cw-spin is-on'); spin.setAttribute('aria-hidden', 'true');
    line.appendChild(spin);
    line.appendChild(el('span', 'cw-typing-t', (sess && sess.tool
      ? toolIntent(sess.tool)
      : t('claude_typing', 'is working')) + '…'));
    bubble.appendChild(line);
    row.appendChild(bubble);
    return row;
  }

  function messageRow(m) {
    const mine = m.role === 'user';
    const row = el('div', 'cw-msg is-' + (mine ? 'user' : 'claude') + (m.provisional ? ' is-provisional' : ''));
    const bubble = el('div', 'cw-msg-bubble');
    bubble.appendChild(el('div', 'cw-msg-who', mine
      ? t('claude_thread_you', 'you')
      : t('claude_thread_claude', 'Claude')));
    const body = el('div', 'cw-msg-text');
    // Your own words are shown as written; Claude's are markdown.
    if (mine) body.textContent = m.text;
    else markdownInto(body, m.text);
    if (m.truncated) {
      body.appendChild(el('div', 'cw-msg-cut', t('claude_thread_cut', 'cut short here')));
      if (!thread.full) {
        const more = el('button', 'cw-msg-more', t('claude_thread_show_all', 'Show all'));
        more.type = 'button';
        more.addEventListener('click', () => thread.showFull());
        body.appendChild(more);
      }
    }
    bubble.appendChild(body);
    row.appendChild(bubble);
    return row;
  }

  function threadView() {
    const wrap = el('div', 'cw-thread-wrap');
    const box = el('div', 'cw-thread');
    wrap.appendChild(box);
    const sess = askSession();
    const working = !!(sess && sess.state === 'running');
    const list = thread.view(sess);
    if (list === null) {
      box.appendChild(el('div', 'cw-thread-note', t('claude_thread_loading', 'Reading the conversation…')));
      return wrap;
    }
    if (!list.length && !working) {
      box.appendChild(el('div', 'cw-thread-note', t('claude_thread_empty', 'Nothing to show from this session yet.')));
      return wrap;
    }
    list.forEach((m) => box.appendChild(messageRow(m)));
    if (working) box.appendChild(typingBubble(sess));

    // Land on the newest turn — but only when the view was ALREADY at the
    // bottom. Yanking someone back down mid-sentence because a new reply
    // arrived is worse than making them scroll; they get a chip instead.
    const stick = thread.atBottom;
    requestAnimationFrame(() => { try { if (stick) box.scrollTop = box.scrollHeight; } catch {} });
    box.addEventListener('scroll', () => {
      const bottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 40;
      if (bottom === thread.atBottom) return;
      const hadUnread = thread.unread;
      thread.setAtBottom(bottom);
      if (hadUnread && bottom) { const chip = wrap.querySelector('.cw-thread-new'); if (chip) chip.remove(); }
    }, { passive: true });
    if (thread.unread) {
      const chip = el('button', 'cw-thread-new', '↓ ' + t('claude_thread_new_reply', 'New reply'));
      chip.type = 'button';
      chip.addEventListener('click', () => {
        box.scrollTop = box.scrollHeight;
        thread.setAtBottom(true);
        chip.remove();
      });
      wrap.appendChild(chip);
    }
    return wrap;
  }

  const CLIP_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" '
    + 'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M20 11.5 11.6 20a5 5 0 0 1-7.1-7.1l8.5-8.4a3.4 3.4 0 0 1 4.8 4.8l-8.4 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/></svg>';

  const ATTACH_ACCEPT = 'image/*,.txt,.md,.json,.csv,.log,.yml,.yaml,.xml,.html,.css,.js,.ts,.jsx,.tsx,.py,.rs,.go,.java,.c,.h,.cpp,.sql,.toml,.ini,.diff,.patch,.pdf';

  // Everything you act on lives in one card at the bottom: what you type, what
  // you attach, which model, and the button. Three separate stacked blocks read
  // as three unrelated things, and on a touchscreen the eye has to travel the
  // whole panel to find the one control it wants.
  // The permission modes a run can start in, as Claude Code's footer names
  // them. '' keeps whatever the user set as their default.
  const RUN_MODE_LABELS = {
    manual: ['claude_run_mode_manual', 'Ask for everything'],
    acceptEdits: ['claude_mode_accept', 'accept edits on'],
    plan: ['claude_mode_plan', 'plan mode on'],
  };
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

  // One of the composer's dropdowns. It uses the app's own select so a long
  // list stays on the display; a change never repaints, which would throw away
  // what is typed.
  function composerSelect(cls, label, options, value, onChange) {
    const sel = document.createElement('select');
    sel.className = cls;
    sel.setAttribute('data-cs-fixed', '');
    sel.setAttribute('aria-label', label);
    sel.title = label;
    options.forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.label;
      if (o.note) opt.dataset.csNote = o.note;
      if (o.id === value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => onChange(sel.value));
    if (typeof window.initCustomSelect === 'function') {
      requestAnimationFrame(() => { try { window.initCustomSelect(sel); } catch {} });
    }
    return sel;
  }

  function runModeSelect() {
    const opts = [{ id: '', label: t('claude_run_mode_default', 'Default mode'), note: t('claude_run_mode_default_note', 'your Claude Code setting') }];
    askOptions.modes.forEach((m) => opts.push({ id: m, label: t(RUN_MODE_LABELS[m][0], RUN_MODE_LABELS[m][1]) }));
    return composerSelect('cw-ask-mode-sel', t('claude_run_mode', 'Permission mode'), opts, askRunMode, (v) => { askRunMode = v; });
  }

  function effortSelect() {
    const opts = [{ id: '', label: t('claude_effort', 'effort') + ': ' + t('claude_model_auto', 'Auto') }];
    EFFORTS.forEach((e) => opts.push({ id: e, label: t('claude_effort', 'effort') + ': ' + e }));
    return composerSelect('cw-ask-effort-sel', t('claude_effort', 'effort'), opts, askEffort, (v) => { askEffort = v; });
  }

  // ── the "/" picker ─────────────────────────────────────────────────────────
  // Typing "/" at the start of a new or resumed run lists the user's commands
  // and skills (names only, from /api/claude/commands). Picking one writes
  // "/name " into the box and Claude Code expands it when the run starts. Not
  // offered for a message queued into a live session: that text is handed to
  // the session as a reply, where a slash command would not run.
  const MAX_PICKS = 6;
  const commandLists = new Map();   // project id → [{ name, desc, kind }] | 'loading'
  let pickAt = 0;

  function commandsFor(projectId) {
    const key = projectId || '';
    const got = commandLists.get(key);
    if (Array.isArray(got)) return got;
    if (got !== 'loading') {
      commandLists.set(key, 'loading');
      api('/api/claude/commands?project=' + encodeURIComponent(key)).then((d) => {
        commandLists.set(key, d && Array.isArray(d.commands) ? d.commands : []);
        paint();
      });
    }
    return null;
  }

  // The word being typed, when the box is exactly "/word" so far.
  function slashQuery(text) {
    const m = /^\/([^\s]*)$/.exec(text);
    return m ? m[1].toLowerCase() : null;
  }

  function slashMatches(text) {
    const q = slashQuery(text);
    if (q === null) return null;
    const list = commandsFor(askProjectId);
    if (!list) return [];
    // Names that start with the word first, then names that contain it.
    const starts = list.filter((c) => c.name.toLowerCase().startsWith(q));
    const contains = list.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
    return starts.concat(contains).slice(0, MAX_PICKS);
  }

  function drawPicker(picker, ta) {
    picker.textContent = '';
    const list = slashMatches(ta.value);
    picker.hidden = !list;
    if (!list) return;
    if (!list.length) {
      picker.appendChild(el('div', 'cw-slash-empty', commandLists.get(askProjectId || '') === 'loading'
        ? t('claude_slash_loading', 'Reading your commands…') : t('claude_slash_none', 'No command or skill with that name')));
      return;
    }
    pickAt = Math.min(pickAt, list.length - 1);
    list.forEach((c, i) => {
      const row = el('button', 'cw-slash-item' + (i === pickAt ? ' is-on' : '')); row.type = 'button';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === pickAt ? 'true' : 'false');
      // The command's own name first, its plugin after it and quieter: a long
      // "plugin:command" cut short would otherwise lose the part that matters.
      // Picking still inserts the full name.
      const cut = c.name.lastIndexOf(':');
      row.appendChild(el('span', 'cw-slash-name', '/' + (cut > 0 ? c.name.slice(cut + 1) : c.name)));
      if (cut > 0) row.appendChild(el('span', 'cw-slash-ns', c.name.slice(0, cut)));
      if (c.desc) row.appendChild(el('span', 'cw-slash-desc', c.desc));
      // mousedown, not click: the textarea must keep focus for the next keys.
      row.addEventListener('mousedown', (e) => { e.preventDefault(); applyPick(c, picker, ta); });
      picker.appendChild(row);
    });
  }

  function applyPick(c, picker, ta) {
    ta.value = '/' + c.name + ' ';
    askText = ta.value;
    pickAt = 0;
    drawPicker(picker, ta);
    ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
  }

  // Arrow keys move, Tab or Enter picks, Escape closes. True when handled.
  function pickerKey(e, picker, ta) {
    if (picker.hidden) return false;
    const list = slashMatches(ta.value) || [];
    if (!list.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      pickAt = (pickAt + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length;
      drawPicker(picker, ta);
      return true;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) {
      applyPick(list[pickAt], picker, ta);
      return true;
    }
    if (e.key === 'Escape') { picker.hidden = true; return true; }
    return false;
  }

  function composer() {
    const box = el('div', 'cw-composer');
    const runLike = replyMode() === 'new' || replyMode() === 'resume';
    if (askProjects === null) loadAskProjects(false);

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
    const picker = el('div', 'cw-slash');
    picker.setAttribute('role', 'listbox');
    picker.hidden = true;
    ta.addEventListener('input', () => {
      askText = ta.value;
      if (runLike) { pickAt = 0; drawPicker(picker, ta); }
    });
    // Enter sends, Shift+Enter breaks the line — the arrangement every chat box
    // has, and the one that was missing here. `isComposing` is checked because
    // an IME's Enter commits the candidate word and must not also send.
    ta.addEventListener('keydown', (e) => {
      if (runLike && pickerKey(e, picker, ta)) { e.preventDefault(); return; }
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
    box.appendChild(picker);
    if (runLike) drawPicker(picker, ta);

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
    bar.appendChild(composerSelect('cw-ask-model-sel', t('claude_ask_model', 'Model'), askModelOptions(), askModel, (v) => { askModel = v; }));
    // Mode and effort apply when a run starts; a message queued into a live
    // session goes into that session as it is, so they are not offered there.
    if (runLike && askOptions.modes.length) bar.appendChild(runModeSelect());
    if (runLike && askOptions.effort) bar.appendChild(effortSelect());

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

  // ── the console ────────────────────────────────────────────────────────────
  // The selected session, the way a terminal shows it: who it is, what it is
  // doing, what it wants from you, its plan and its last tool calls, the
  // conversation, and the prompt. Decisions render here, in the console of the
  // session that asks; a decision from ANOTHER session is a one-line bar on
  // top that switches to it, so a blocked call is never hidden behind a choice.
  function consoleHelpers() {
    return { el, t, ageNode, dur, toolIntent, endedLabel, prettyModel, modelHue, fmtMoney, ctxGauge };
  }

  function titles() { return (payload && payload.titles) || {}; }

  function decisionsFor(id) {
    const pend = approvals().filter((a) => !a.urgent);
    // A request with no session id cannot be placed; it shows wherever you are.
    return {
      mine: pend.filter((a) => !a.sessionId || a.sessionId === id),
      others: pend.filter((a) => a.sessionId && a.sessionId !== id),
    };
  }

  function decisionStack(list) {
    if (!list.length) return null;
    const box = el('div', 'cw-decs');
    if (list.length > 1) box.classList.add('is-pair');
    list.slice(0, 2).forEach((a) => box.appendChild(decisionCard(a, false)));
    if (list.length > 2) box.appendChild(el('div', 'cw-decs-more', t('claude_more_waiting', '{n} more waiting').replace('{n}', String(list.length - 2))));
    return box;
  }

  function othersBar(others) {
    const a = others[0];
    const s = sessionById(a.sessionId);
    const who = window.ClaudeIdent.describe(s || { id: a.sessionId, project: a.project }, titles());
    const bar = el('button', 'cw-elsewhere is-s' + who.slot); bar.type = 'button';
    const mascot = el('span', 'cw-clawd is-needs');
    mascot.appendChild(window.ClaudeClawd.make('cw-clawd-svg'));
    bar.appendChild(mascot);
    const txt = el('span', 'cw-elsewhere-t');
    txt.appendChild(el('strong', '', who.title || '?'));
    txt.appendChild(document.createTextNode(' ' + (a.kind === 'question'
      ? t('claude_wait_q', 'Waiting for your answer') : t('claude_wait_perm', 'Waiting for your approval'))));
    bar.appendChild(txt);
    if (others.length > 1) bar.appendChild(el('span', 'cw-elsewhere-more', '+' + (others.length - 1)));
    bar.appendChild(el('span', 'cw-elsewhere-go', t('claude_notice_go', 'open')));
    bar.addEventListener('click', () => select(a.sessionId, a.project || ''));
    return bar;
  }

  function runsFor(id) {
    return runs().filter((r) => (id ? r.sessionId === id : (!r.sessionId || !sessionById(r.sessionId))));
  }

  // What you can do about a session you cannot write to from here, said once.
  function composerOrNote(s) {
    if (!(linkState && linkState.linked)) {
      const n = el('div', 'cw-cs-note');
      n.appendChild(el('span', '', t('claude_cs_link', 'Connect Claude Code to write to its sessions from here.')));
      n.appendChild(linkButton());
      return n;
    }
    if (s && (s.inferred || s.unlinked)) {
      return el('div', 'cw-cs-note', t('claude_cs_unlinked', 'This session started before Xenon was connected. Restart it in the terminal to reply from here.'));
    }
    return composer();
  }

  function sessionConsole(pane, id) {
    const s = sessionById(id);
    const rec = s || { id, project: askResumeLabel };
    const st = s ? window.ClaudeRail.stateOf(s) : 'idle';
    const h = consoleHelpers();
    const who = window.ClaudeIdent.describe(rec, titles(), askResumeLabel || t('claude_ask_session', 'session'));
    pane.classList.add('is-s' + who.slot);
    pane.appendChild(window.ClaudeConsole.head(h, rec, who, st));
    if (s) pane.appendChild(window.ClaudeConsole.status(h, s, st));
    else pane.appendChild(el('div', 'cw-cs-status is-idle', t('claude_cs_closed', 'Not open in a terminal. A message continues it in the background.')));

    const decs = decisionStack(decisionsFor(id).mine);
    if (decs) pane.appendChild(decs);

    const body = el('div', 'cw-cs-body');
    body.appendChild(threadView());
    if (s) {
      const aside = el('div', 'cw-cs-aside');
      const todos = window.ClaudeConsole.todos(h, s); if (todos) aside.appendChild(todos);
      const acts = window.ClaudeConsole.activity(h, s); if (acts) aside.appendChild(acts);
      if (aside.childNodes.length) { body.appendChild(aside); body.classList.add('has-aside'); }
    }
    pane.appendChild(body);

    runsFor(id).slice(-1).forEach((r) => pane.appendChild(runCard(r)));
    if (s && s.queued) pane.appendChild(queuedRow(s));
    pane.appendChild(composerOrNote(s));
  }

  function projectPicker() {
    if (askProjects === null) {
      loadAskProjects(false);
      return el('div', 'cw-panel-note', t('claude_ask_loading', 'Reading your projects…'));
    }
    if (!askProjects.length) {
      return el('div', 'cw-panel-note', t('claude_ask_noprojects', 'No projects found. Open Claude Code in a folder once, then come back.'));
    }
    const list = el('div', 'cw-ask-projects');
    askProjects.slice(0, 8).forEach((p) => {
      const b = el('button', 'cw-ask-proj' + (p.id === askProjectId ? ' is-sel' : '')); b.type = 'button';
      b.appendChild(el('span', 'cw-ask-proj-name', p.name));
      b.title = p.path;
      b.addEventListener('click', () => { askProjectId = p.id; paint(); });
      list.appendChild(b);
    });
    return list;
  }

  // No session in the console: a new one, or nothing running at all. Clawd
  // stands in the middle with the prompt under him rather than an empty panel.
  function newConsole(pane) {
    pane.classList.add('is-new');
    const hero = el('div', 'cw-hero');
    const mascot = el('span', 'cw-hero-clawd cw-clawd is-idle');
    mascot.appendChild(window.ClaudeClawd.make('cw-clawd-svg'));
    hero.appendChild(mascot);
    const none = !sessions().length;
    hero.appendChild(el('div', 'cw-hero-t', none && !composing
      ? t('claude_no_sessions', 'No session running') : t('claude_new_title', 'New session')));
    hero.appendChild(el('div', 'cw-hero-s', t('claude_ask_sub', 'Whatever it runs or writes comes back here to approve')));
    if (composing && !none) {
      const back = el('button', 'cw-link-btn'); back.type = 'button';
      back.textContent = t('claude_cs_back', 'Back to the sessions');
      back.addEventListener('click', closeAsk);
      hero.appendChild(back);
    }
    pane.appendChild(hero);

    const decs = decisionStack(decisionsFor('').mine);
    if (decs) pane.appendChild(decs);
    runsFor('').slice(-2).forEach((r) => pane.appendChild(runCard(r)));

    if (!(linkState && linkState.linked)) { pane.appendChild(composerOrNote(null)); return; }
    pane.appendChild(projectPicker());
    pane.appendChild(el('div', 'cw-thread-spacer'));
    pane.appendChild(composer());
  }

  function consolePane() {
    const pane = el('section', 'cw-console');
    const id = askResumeId;
    const others = decisionsFor(id).others;
    if (others.length) pane.appendChild(othersBar(others));
    if (id) sessionConsole(pane, id);
    else newConsole(pane);
    return pane;
  }

  // Rail + console. A run the dashboard started whose session is not on the
  // rail yet has nowhere else to be, so the new-session console carries it.
  function missionControl() {
    syncSelection();
    const mc = el('div', 'cw-mc');
    const list = sessions();
    if (list.length) {
      const side = el('div', 'cw-side');
      side.appendChild(window.ClaudeRail.render({
        el, t, list, titles: titles(), selected: askResumeId,
        fresh: new Set(doneNotices.map((n) => n.id)),
        onSelect: (id, label) => select(id, label),
        ageNode, nowLine, stateLabel,
        finishedTitle: (n) => collapsibleTitle('finished', t('claude_sess_finished', 'Finished'), String(n)),
        showFinished: !isCollapsed('finished'),
      }));
      mc.appendChild(side);
    } else {
      mc.classList.add('is-solo');
    }
    mc.appendChild(consolePane());
    return mc;
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

    const chips = runChips(r);
    if (chips) card.appendChild(chips);
    card.appendChild(el('div', 'cw-run-prompt', r.prompt));
    // What the run is doing now and its last tool calls, as the console shows
    // them for a session open in a terminal.
    if (r.state === 'running') {
      card.appendChild(window.ClaudeConsole.status(consoleHelpers(),
        { id: r.id, tool: r.tool, toolDetail: r.toolDetail, runForMs: r.elapsedMs }, 'working'));
    }
    const acts = window.ClaudeConsole.activity(consoleHelpers(), r);
    if (acts) card.appendChild(acts);
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
  // The mode and effort the run was started with, when not the defaults.
  function runChips(r) {
    const box = el('div', 'cw-cs-chips cw-run-chips');
    const mode = r.mode === 'manual'
      ? el('span', 'cw-chip', t(RUN_MODE_LABELS.manual[0], RUN_MODE_LABELS.manual[1]))
      : window.ClaudeConsole.modeChip(consoleHelpers(), r.mode);
    if (mode) box.appendChild(mode);
    if (r.effort) box.appendChild(el('span', 'cw-chip', t('claude_effort', 'effort') + ' ' + r.effort));
    return box.childNodes.length ? box : null;
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
  // Faces instead of one long scroll: LIVE is what is happening and what
  // needs you, USAGE is the record, CHATS is what is kept on disk. The choice is per surface and survives a
  // reload (a view preference, so localStorage, not the settings store).
  const FACE_KEY = 'xeneonedge.claude.face.v1';
  const REPAIR_SEEN_KEY = 'xeneonedge.claude.repairSeen.v1';
  const FACES = ['live', 'usage', 'history'];
  let face = null;
  function currentFace() {
    if (face) return face;
    try { face = FACES.includes(localStorage.getItem(FACE_KEY)) ? localStorage.getItem(FACE_KEY) : 'live'; } catch { face = 'live'; }
    return face;
  }
  function setFace(f) {
    face = FACES.includes(f) ? f : 'live';
    try { localStorage.setItem(FACE_KEY, face); } catch { /* private mode: session only */ }
    paint();
  }

  // The quota, small enough to live in the header: two bars, the number, and
  // the full instruments one tap away on the Usage face.
  function quotaMini() {
    const lim = limits();
    if (!lim || !(lim.fiveHour || lim.sevenDay)) return null;
    const box = el('button', 'cw-qmini'); box.type = 'button';
    box.title = t('claude_quota', 'Quota');
    const now = Date.now();
    [['fiveHour', t('claude_5h', '5h')], ['sevenDay', t('claude_7d', '7d')]].forEach(([k, label]) => {
      const win = lim[k];
      if (!win) return;
      const renewed = win.resetsAt && win.resetsAt * 1000 <= now;
      const used = renewed ? 0 : clamp(Number(win.pct) || 0, 0, 100);
      const q = el('span', 'cw-qm is-' + level(used));
      q.appendChild(el('span', 'cw-qm-k', label));
      const bar = el('span', 'cw-qm-bar');
      const fill = el('span', 'cw-qm-fill'); fill.style.width = Math.round(used) + '%';
      bar.appendChild(fill);
      q.appendChild(bar);
      q.appendChild(el('span', 'cw-qm-v', Math.round(used) + '%'));
      box.appendChild(q);
    });
    box.addEventListener('click', () => setFace('usage'));
    return box;
  }

  function header() {
    const h = el('div', 'cw-top');
    const title = el('div', 'cw-name');
    // The connection as a mark, not a sentence: complete, partly there, or off.
    const state = !linkState ? 'unknown' : !linkState.linked ? 'off' : linkState.complete === false ? 'partial' : 'on';
    const brand = el('span', 'cw-brand');
    brand.appendChild(window.ClaudeClawd.make('cw-brand-mark'));
    title.appendChild(brand);
    title.appendChild(el('span', 'cw-name-t', 'Claude Code'));
    const mark = el('span', 'cw-link-mark is-' + state);
    title.title = state === 'on' ? t('claude_connected', 'Connected')
      : state === 'partial' ? t('claude_link_incomplete', 'Part of the Claude Code connection is missing.')
        : t('claude_cta', 'Show real quota and approve from here');
    title.appendChild(mark);
    title.setAttribute('role', 'button');
    title.tabIndex = 0;
    const openLink = () => { linkPanel = true; paint(); };
    title.addEventListener('click', openLink);
    title.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openLink(); } });
    h.appendChild(title);

    const q = quotaMini();
    if (q) h.appendChild(q);

    const faces = el('div', 'cw-faces');
    faces.setAttribute('role', 'tablist');
    [['live', t('claude_sessions', 'Sessions')], ['usage', t('claude_face_usage', 'Usage')], ['history', t('claude_face_history', 'Chats')]].forEach(([id, label]) => {
      const b = el('button', 'cw-face' + (currentFace() === id ? ' is-on' : ''), label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', currentFace() === id ? 'true' : 'false');
      b.addEventListener('click', () => setFace(id));
      faces.appendChild(b);
    });
    h.appendChild(faces);

    if (linkState && linkState.linked) {
      const ask = el('button', 'cw-ask-open' + (composing ? ' is-on' : '')); ask.type = 'button';
      ask.appendChild(el('span', 'cw-ask-open-plus', '+'));
      ask.appendChild(el('span', 'cw-ask-open-t', t('claude_new_session', 'New session')));
      ask.setAttribute('aria-label', t('claude_new_session', 'New session'));
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

    wrap.appendChild(header());
    const notice = linkNotice(); if (notice) wrap.appendChild(notice);

    const f = currentFace();
    // The console is the only reader of the thread; off it, stop reading.
    if (f !== 'live' && thread.id) thread.close();
    if (f === 'history') {
      // A blocked call must never wait behind a tab.
      const decs = decisionStack(approvals().filter((a) => !a.urgent));
      if (decs) wrap.appendChild(decs);
      wrap.appendChild(window.ClaudeHistory.render({ t, ago, paint, openAsk: (id, label) => openAsk(id, label, '') }));
      return wrap;
    }
    const u = payload && payload.usage;
    if (f === 'usage') {
      const decs = decisionStack(approvals().filter((a) => !a.urgent));
      if (decs) wrap.appendChild(decs);
      if (!u) { wrap.appendChild(el('div', 'cw-state', t('claude_reading', 'Reading local Claude Code sessions…'))); return wrap; }
      const face = usageFace(u);
      face.insertBefore(quotaPanel(), face.firstChild);
      wrap.appendChild(face);
      return wrap;
    }
    if (!payload) {
      wrap.appendChild(el('div', 'cw-state', t('claude_reading', 'Reading local Claude Code sessions…')));
      return wrap;
    }
    wrap.appendChild(missionControl());
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
    let painted = 0;
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
      painted++;
      // An open dropdown (model, mode, effort) lives in the subtree a rebuild
      // replaces, so a push would snap it shut under the finger. Hold this
      // tile until it closes, then catch up.
      if (mount.querySelector('.cs-wrap.cs-open')) { paintLater(); return; }
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
      if (keepThread && !thread.atBottom) {
        const nextThread = mount.querySelector('.cw-thread');
        if (nextThread) nextThread.scrollTop = keepThread;
      }
    });
    // No console on screen: nobody is reading the thread, so stop polling it.
    // The next paint that shows the console opens it again.
    if (!painted && thread.id) thread.close();
    syncOverlay();
    const needsTick = !!(limits() || approvals().length || sessions().length);
    if (needsTick) startTicker(); else stopTicker();
  }

  let laterTimer = null;
  function paintLater() {
    if (laterTimer) return;
    laterTimer = setTimeout(() => { laterTimer = null; paint(); }, HELD_PAINT_MS);
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

  // The rail scrolls sideways on a narrow tile, so both axes are kept.
  const HELD_PAINT_MS = 400;
  const SCROLLERS = ['.cw-rail-list', '.cw-cs-aside', '.cw-console', '.cw-usage', '.cw-hist-list', '.cw-decs', '.cw-dec-body', '.cw-dec-plan', '.cw-dec-cmd'];
  function keepScroll(root) {
    return SCROLLERS.map((sel) => Array.from(root.querySelectorAll(sel), (n) => [n.scrollTop, n.scrollLeft]));
  }
  function restoreScroll(root, kept) {
    SCROLLERS.forEach((sel, i) => {
      root.querySelectorAll(sel).forEach((n, j) => {
        const k = kept[i][j];
        if (!k) return;
        if (k[0]) n.scrollTop = k[0];
        if (k[1]) n.scrollLeft = k[1];
      });
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


  // ── the topbar marker ──────────────────────────────────────────────────────
  // Lives in the clock island, so it is present in both the full and the minimal
  // bar and can be reordered or hidden like any other island element. Three
  // states and nothing more: absent when there is nothing to say, a quiet pulse
  // while a session works, and lit when one has finished and you have not looked
  // yet. Tapping it opens that session.
  let topbarSig = '';

  // Clawd, Claude Code's own mascot (js/claude-clawd.js). It replaced a text
  // pill and then a generic sparkle: neither said whose session this was.
  function clawd() { return window.ClaudeClawd.make('cw-tb-mark'); }

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
    // A session that just started or stopped working flips whether the thread
    // needs watching, and any state change re-reads it until the turn closes.
    syncThread();
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
