'use strict';
// OpenAI Codex widget: the plan, and the sessions working on this PC.
//
//   DECISIONS first, on both faces: an approval a Codex session is waiting on,
//     with what it would do (the command, or the files a patch touches) and
//     what makes it unusual, before the keys. Allow, Deny, or "Answer in Codex",
//     which puts the question back where it came from at once. An irreversible
//     one is allowed by holding the key. One left unanswered goes full screen.
//   LIVE face: the sessions the hooks report, the conversations Codex lists,
//     and the plan's usage windows (their length comes from Codex: 5 hours and
//     a week on paid plans, one 30-day window on Free).
//   USAGE face: tokens per day for the account, today, 7 and 30 days.
//
// Where the data comes from, so the empty states can say something true:
// the plan side from `codex app-server` (server/codex-appserver.js), the live
// side from the hooks server/codex-link.js installs. Every string here is
// Codex-derived and renders through textContent (makeEl), never innerHTML.
(function () {
  const el = makeEl;
  const api = apiJson;
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const AK = window.ApprovalKeys;

  let payload = null;       // { app, live, link, cfg, sdk } from SSE or GET /api/codex
  let seeded = false, seedInflight = false;
  let linkPanel = false;
  let thread = null;          // { id, title, project, loading, messages, running, error } while a conversation is open
  let threadTimer = null;
  let threadPinBottom = true;
  let linking = false;
  let refreshing = false;
  const deciding = new Set();
  let ticker = null;
  let overlay = null;
  let topbarSig = '';

  const ARM_MS = 450;
  const HOLD_MS = 900;
  const FACE_KEY = 'xeneonedge.codex.face.v1';
  const SCROLLERS = ['.cx-livegrid', '.cx-usage', '.cx-decs', '.cx-dec-body', '.cx-dec-cmd', '.cx-list', '.cx-thread'];
  const arming = AK.createArming(ARM_MS, () => paint());
  const press = AK.createPressGuard('.codex-widget-mount, .cx-overlay, #clock-codex', () => renderNow());

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="openaicodex"]')).filter((n) => n.closest('.pager-page'));
  }
  function isParked(tile) {
    const page = tile.closest('.pager-page');
    return !!(page && page.classList.contains('is-parked') && !document.body.classList.contains('layout-editing'));
  }

  // ── payload accessors ──
  function app() { return (payload && payload.app) || null; }
  function liveState() { return (payload && payload.live) || null; }
  function approvals() { const l = liveState(); return (l && Array.isArray(l.approvals)) ? l.approvals : []; }
  function sessions() { const l = liveState(); return (l && Array.isArray(l.sessions)) ? l.sessions : []; }
  function link() { return (payload && payload.link) || null; }
  function approvalsOn() {
    const c = (typeof hubSettings === 'object' && hubSettings && hubSettings.codexWidget) || null;
    return !c || c.approvals !== false;
  }
  function topbarOn() {
    try {
      const items = hubSettings && hubSettings.topbarClock && hubSettings.topbarClock.items;
      const item = Array.isArray(items) ? items.find((x) => x && x.id === 'codex') : null;
      if (item) return item.hidden !== true;
    } catch { /* default below */ }
    return true;
  }

  // ── formatting ──
  function hTok(n) {
    n = Math.max(0, Math.round(n || 0));
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e11 ? 0 : 2).replace(/\.0+$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(n);
  }
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
  function mmss(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  // A usage window's name from its length, never assumed: Codex decides it.
  function windowLabel(mins) {
    if (mins === 300) return t('codex_win_5h', '5 hours');
    if (mins === 10080) return t('codex_win_week', 'Week');
    if (mins >= 43000 && mins <= 44700) return t('codex_win_month', '30 days');
    if (!Number.isFinite(mins) || mins <= 0) return t('codex_win_plan', 'Plan');
    if (mins < 1440) return t('codex_win_hours', '{n} hours').replace('{n}', String(Math.round(mins / 60)));
    return t('codex_win_days', '{n} days').replace('{n}', String(Math.round(mins / 1440)));
  }
  function planLabel(p) {
    const s = String(p || '');
    if (!s || s === 'unknown') return '';
    const nice = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', promax: 'Pro Max', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
    return nice[s] || s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  function sourceLabel(s) {
    return ({
      app: t('codex_src_app', 'ChatGPT app'), cli: t('codex_src_cli', 'Terminal'), ide: t('codex_src_ide', 'Editor'),
      exec: t('codex_src_exec', 'Script'), agent: t('codex_src_agent', 'Sub-agent'),
    })[s] || '';
  }

  // ── decisions ──
  async function decide(id, behavior) {
    if (deciding.has(id)) return;
    deciding.add(id);
    paint();
    const d = await api('/api/codex/decide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, behavior }),
    });
    deciding.delete(id);
    if (!d || !d.ok) {
      // Codex stopped waiting (its own timeout, Ctrl-C) or another screen
      // answered first. Saying so beats a key that seems to do nothing.
      if (window.XenonToast) window.XenonToast.show({ type: 'warn', title: t('codex_decide_late', 'That request is no longer waiting') });
    }
    const l = liveState();
    if (l && l.approvals) l.approvals = l.approvals.filter((x) => x.id !== id);
    paint();
  }

  function intentOf(a) {
    const d = a.detail || {};
    switch (d.kind) {
      case 'command': return t('codex_intent_command', 'Run a command');
      case 'patch': return t('codex_intent_patch', 'Change files');
      case 'stdin': return t('codex_intent_stdin', 'Type into a running command');
      case 'permissions': return t('codex_intent_widen', 'Get more access than this session has');
      case 'agent': return t('codex_intent_agent', 'Start a sub-agent');
      case 'mcp': return t('codex_intent_mcp', 'Use a tool from {s}').replace('{s}', d.server || 'MCP');
      default: return a.tool || t('codex_intent_other', 'Do something');
    }
  }
  const RISK_LABEL = {
    irreversible: () => t('claude_risk_irreversible', 'Cannot be undone'),
    publish: () => t('claude_risk_publish', 'Publishes your work'),
    network: () => t('claude_risk_network', 'Reaches the network'),
    outside: () => t('claude_risk_outside', 'Outside the project folder'),
    readonly: () => t('claude_risk_readonly', 'Only reads'),
    widen: () => t('codex_risk_widen', 'Widens what Codex may do'),
  };
  const VERB_LABEL = {
    add: () => t('codex_file_add', 'new'),
    update: () => t('codex_file_update', 'edit'),
    delete: () => t('codex_file_delete', 'delete'),
    move: () => t('codex_file_move', 'move'),
  };

  function evidence(a) {
    const d = a.detail || {};
    if (d.kind === 'patch') {
      const box = el('div', 'cx-dec-cmd is-files');
      (d.files || []).forEach((f) => {
        const row = el('div', 'cx-file is-' + f.verb);
        row.appendChild(el('span', 'cx-file-verb', VERB_LABEL[f.verb] ? VERB_LABEL[f.verb]() : f.verb));
        row.appendChild(el('span', 'cx-file-path', f.to ? f.path + ' → ' + f.to : f.path));
        box.appendChild(row);
      });
      if (d.added || d.removed) box.appendChild(el('div', 'cx-file-n', '+' + (d.added || 0) + ' −' + (d.removed || 0)));
      return box;
    }
    if (d.kind === 'mcp') return el('div', 'cx-dec-cmd', [d.name, d.text].filter(Boolean).join('  ·  '));
    return d.text ? el('div', 'cx-dec-cmd', d.text) : null;
  }

  function key(cls, label, a, onTap) {
    const b = el('button', 'cx-key ' + cls, label);
    b.type = 'button';
    b.disabled = deciding.has(a.id);
    b.addEventListener('click', () => { if (arming.isArmed(a.id)) onTap(); });
    return b;
  }

  function decisionCard(a, big) {
    const risks = Array.isArray(a.risks) ? a.risks : [];
    const irreversible = risks.includes('irreversible');
    const armed = arming.isArmed(a.id);
    const card = el('section', 'cx-dec' + (big ? ' is-big' : '') + (irreversible ? ' is-risky' : '') + (armed ? '' : ' is-arming'));
    card.setAttribute('aria-live', 'polite');
    const head = el('div', 'cx-dec-head');
    head.appendChild(el('span', 'cx-dec-kind', t('codex_permission', 'Codex is asking')));
    head.appendChild(el('span', 'cx-dec-where', [a.project, a.model].filter(Boolean).join(' · ')));
    const left = el('span', 'cx-dec-timer');
    left.dataset.cxExpiresAt = String(Date.now() + (a.expiresInMs || 0));
    left.dataset.tpl = t('claude_dec_left', '{t} left');
    left.textContent = left.dataset.tpl.replace('{t}', mmss(a.expiresInMs));
    left.title = t('codex_dec_expires', 'After this Codex asks you itself');
    head.appendChild(left);
    card.appendChild(head);

    const body = el('div', 'cx-dec-body');
    body.appendChild(el('div', 'cx-dec-what', intentOf(a)));
    const ev = evidence(a);
    if (ev) body.appendChild(ev);
    if (a.detail && a.detail.note) body.appendChild(el('div', 'cx-dec-note', a.detail.note));
    if (risks.length) {
      const line = el('div', 'cx-dec-risks');
      risks.forEach((r) => { if (RISK_LABEL[r]) line.appendChild(el('span', 'cx-risk is-' + r, RISK_LABEL[r]())); });
      body.appendChild(line);
    }
    card.appendChild(body);

    const acts = el('div', 'cx-dec-acts');
    acts.appendChild(key('is-deny', t('claude_deny', 'Deny'), a, () => decide(a.id, 'deny')));
    acts.appendChild(key('is-quiet', t('codex_handback', 'Answer in Codex'), a, () => decide(a.id, 'handback')));
    if (irreversible) {
      acts.appendChild(AK.holdButton({
        className: 'cx-key is-allow is-hold', label: t('claude_hold_allow', 'Hold to allow'),
        pressAgain: t('claude_press_again', 'Press again to allow'), holdMs: HOLD_MS,
        disabled: deciding.has(a.id), isArmed: () => arming.isArmed(a.id), onConfirm: () => decide(a.id, 'allow'),
      }));
    } else {
      acts.appendChild(key('is-allow', t('claude_allow', 'Allow'), a, () => decide(a.id, 'allow')));
    }
    card.appendChild(acts);
    return card;
  }

  function syncOverlay() {
    if (press.pressing) { press.defer(); return; }
    const urgent = approvalsOn() ? approvals().filter((a) => a.urgent)[0] : null;
    if (!urgent) { closeOverlay(); return; }
    if (!overlay) {
      overlay = el('div', 'cx-overlay');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      document.body.appendChild(overlay);
      // A full-screen backdrop: joins the freeze registry like every other one.
      if (typeof window.ambientFreeze === 'function') window.ambientFreeze('codex-approval', true);
    }
    const kept = AK.keepScroll(overlay, SCROLLERS);
    overlay.replaceChildren(decisionCard(urgent, true));
    AK.restoreScroll(overlay, SCROLLERS, kept);
  }
  function closeOverlay() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('codex-approval', false);
  }

  // ── the plan's usage windows ──
  function gauge(win) {
    const row = el('div', 'cx-gauge');
    const top = el('div', 'cx-gauge-top');
    top.appendChild(el('span', 'cx-gauge-name', windowLabel(win.windowMins)));
    const pct = Number.isFinite(win.pct) ? win.pct : null;
    top.appendChild(el('span', 'cx-gauge-pct' + (pct >= 90 ? ' is-crit' : pct >= 70 ? ' is-warn' : ''), pct === null ? '—' : pct + '%'));
    row.appendChild(top);
    const bar = el('div', 'cx-bar');
    const fill = el('span', 'cx-bar-fill' + (pct >= 90 ? ' is-crit' : pct >= 70 ? ' is-warn' : ''));
    fill.style.width = (pct || 0) + '%';
    bar.appendChild(fill);
    // Even pace: where usage would be now if it were spread evenly over the
    // window. Ahead of the marker means the window runs out before it resets.
    if (win.resetsAt && win.windowMins) {
      const span = win.windowMins * 60000;
      const elapsed = Math.max(0, Math.min(1, 1 - (win.resetsAt - Date.now()) / span));
      const mark = el('span', 'cx-bar-pace');
      mark.style.left = (elapsed * 100).toFixed(1) + '%';
      mark.title = t('codex_pace', 'Even pace');
      bar.appendChild(mark);
    }
    row.appendChild(bar);
    if (win.resetsAt) {
      const r = el('div', 'cx-gauge-reset');
      r.appendChild(document.createTextNode(t('codex_resets_in', 'Resets in') + ' '));
      const left = el('span', '', dur(win.resetsAt - Date.now()));
      left.dataset.cxResetAt = String(win.resetsAt);
      r.appendChild(left);
      row.appendChild(r);
    }
    return row;
  }

  function limitsPanel() {
    const a = app();
    const box = el('div', 'cx-limits');
    const head = el('div', 'cx-sec-head');
    head.appendChild(el('span', 'cx-sec-title', t('codex_plan_usage', 'Plan usage')));
    const plan = planLabel((a && a.account && a.account.plan) || (a && a.limits && a.limits.plan));
    if (plan) head.appendChild(el('span', 'cx-sec-sum', plan));
    box.appendChild(head);
    if (!a || !a.caps || a.caps.limits === false) {
      box.appendChild(el('div', 'cx-muted', t('codex_limits_unsupported', 'This copy of Codex does not report its limits. Updating Codex adds them.')));
      return box;
    }
    const lim = a.limits;
    if (!lim || !Array.isArray(lim.buckets) || !lim.buckets.length) {
      box.appendChild(el('div', 'cx-muted', t('codex_limits_reading', 'Reading the plan from Codex…')));
      return box;
    }
    // The main limit always; any other (Codex sends extras such as
    // "gpt-reserve") only while it is the one blocking. Codex's own usage menu
    // shows just the main 5h + Weekly, so an extra row read as a third limit
    // nobody could place (Discord, Oct 2026).
    lim.buckets.slice(0, 3).filter((b, i) => i === 0 || b.reached).forEach((b, i) => {
      if (i > 0 && b.name) box.appendChild(el('div', 'cx-bucket-name', b.name));
      if (b.primary) box.appendChild(gauge(b.primary));
      if (b.secondary) box.appendChild(gauge(b.secondary));
      if (b.reached) box.appendChild(el('div', 'cx-notice is-warn', t('codex_limit_reached', 'Limit reached. Codex waits for the reset.')));
    });
    if (lim.credits && (lim.credits.has || lim.credits.unlimited)) {
      box.appendChild(el('div', 'cx-muted', lim.credits.unlimited ? t('codex_credits_unlimited', 'Credits: unlimited')
        : t('codex_credits', 'Credits: {n}').replace('{n}', lim.credits.balance || '✓')));
    }
    return box;
  }

  // ── sessions and recent conversations ──
  function stateLabel(s) {
    if (s.ended) return t('codex_state_ended', 'Closed');
    if (s.state === 'waiting') return t('codex_state_waiting', 'Waiting for you');
    if (s.state === 'running') return t('codex_state_running', 'Working');
    return t('codex_state_idle', 'Idle');
  }
  // How long ago, coarse enough to read at a glance: minutes, then hours, then
  // days, then a date. "69g10h" was exact and unreadable.
  function ago(ts) {
    const ms = Date.now() - ts;
    if (ms < 48 * 3600000) return dur(ms);
    const days = Math.floor(ms / 86400000);
    if (days < 30) return days + t('claude_unit_d', 'd');
    try { return new Intl.DateTimeFormat(t('locale'), { day: 'numeric', month: 'short' }).format(new Date(ts)); } catch { return days + t('claude_unit_d', 'd'); }
  }

  // ── one conversation, opened from a row ──
  // Codex writes the conversation from another process, so nothing tells us a
  // new answer landed: the open view reads it again on its own, often while a
  // turn runs, now and then while idle (a prompt sent from Codex starts one),
  // and only while some tile actually shows it.
  const THREAD_RUNNING_MS = 3000;
  const THREAD_IDLE_MS = 15000;
  function threadShown() {
    return !!thread && document.visibilityState === 'visible' && tiles().some((tile) => !isParked(tile));
  }
  function closeThread() {
    thread = null;
    if (threadTimer) { clearTimeout(threadTimer); threadTimer = null; }
    paint();
  }
  function scheduleThread() {
    if (threadTimer) { clearTimeout(threadTimer); threadTimer = null; }
    if (!thread || thread.loading) return;
    const id = thread.id;
    threadTimer = setTimeout(() => {
      threadTimer = null;
      if (!thread || thread.id !== id) return;
      if (threadShown()) loadThread(id, false);
      else scheduleThread();
    }, thread.running ? THREAD_RUNNING_MS : THREAD_IDLE_MS);
  }
  function threadSig(msgs, running) {
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    return msgs.length + '|' + (running ? 1 : 0) + '|' + (last ? last.role + last.text.length + last.text.slice(-40) : '');
  }
  async function loadThread(id, first) {
    const d = await api('/api/codex/thread?id=' + encodeURIComponent(id));
    if (!thread || thread.id !== id) return;
    const before = threadSig(thread.messages, thread.running);
    const wasError = thread.error;
    if (d && d.ok) {
      thread.messages = Array.isArray(d.messages) ? d.messages : [];
      thread.running = d.running === true;
      thread.error = '';
    } else if (first || !thread.messages.length) thread.error = (d && d.error) || 'failed';
    // A refresh that fails keeps what was already on screen.
    const changed = first || thread.loading || wasError !== thread.error || before !== threadSig(thread.messages, thread.running);
    if (first || thread.loading) threadPinBottom = true;
    thread.loading = false;
    if (changed) {
      // A reader parked at the newest message follows the new one in.
      const th = document.querySelector('.codex-widget-mount .cx-thread');
      if (th && th.scrollHeight - th.scrollTop - th.clientHeight < 24) threadPinBottom = true;
      paint();
    }
    scheduleThread();
  }
  function openThread(id, title, project) {
    if (threadTimer) { clearTimeout(threadTimer); threadTimer = null; }
    thread = { id, title, project, loading: true, messages: [], running: false, error: '' };
    paint();
    loadThread(id, true);
  }
  function threadView() {
    const box = el('div', 'cx-panel cx-thread-panel');
    const top = el('div', 'cx-top');
    const back = el('button', 'cx-btn is-quiet', '‹ Codex');
    back.type = 'button';
    back.addEventListener('click', closeThread);
    top.appendChild(back);
    const head = el('div', 'cx-thread-head');
    head.appendChild(el('span', 'cx-row-title', thread.title || ''));
    if (thread.project) head.appendChild(el('span', 'cx-row-sub', thread.project));
    top.appendChild(head);
    const again = el('button', 'cx-btn is-quiet cx-refresh', '↻');
    again.type = 'button';
    again.title = t('codex_refresh', 'Read again from Codex');
    again.setAttribute('aria-label', again.title);
    again.addEventListener('click', () => openThread(thread.id, thread.title, thread.project));
    top.appendChild(again);
    box.appendChild(top);
    const list = el('div', 'cx-thread');
    if (thread.loading) list.appendChild(el('div', 'cx-muted', t('codex_reading', 'Reading Codex…')));
    else if (thread.error) list.appendChild(el('div', 'cx-muted', thread.error === 'unsupported' ? t('codex_thread_unsupported', 'This copy of Codex cannot share its conversations. Updating Codex adds it.') : t('codex_thread_failed', 'Codex did not return this conversation.')));
    else if (!thread.messages.length) list.appendChild(el('div', 'cx-muted', t('codex_thread_empty', 'Nothing to show in this conversation yet.')));
    for (const m of thread.messages) {
      if (m.role === 'progress') { list.appendChild(el('div', 'cx-thread-progress', m.text)); continue; }
      if (m.role === 'note') { list.appendChild(el('div', 'cx-thread-note', m.text === 'failed' ? t('codex_turn_failed', 'This turn ended with an error.') : t('codex_turn_stopped', 'This turn was stopped.'))); continue; }
      const row = el('div', 'cx-msg is-' + m.role);
      const b = el('div', 'cx-bubble' + (m.role === 'assistant' ? ' ai-msg-markdown' : ''));
      // The user's words as text; Codex's through the escaping markdown renderer
      // Xenon AI uses (js/ai.js): it escapes first and only links http(s)/mailto.
      if (m.role === 'assistant' && typeof _aiRenderMarkdown === 'function') b.innerHTML = _aiRenderMarkdown(m.text);
      else b.textContent = m.text;
      if (m.files) b.appendChild(el('span', 'cx-files', ' ' + t('codex_n_files', '+{n} attached').replace('{n}', String(m.files))));
      row.appendChild(b);
      list.appendChild(row);
    }
    if (thread.running) list.appendChild(el('div', 'cx-thread-note is-running', t('codex_state_running', 'Working')));
    box.appendChild(list);
    box.appendChild(el('div', 'cx-muted cx-thread-foot', t('codex_thread_foot', 'Your requests and Codex’s answers. Commands and file changes stay in Codex.')));
    return box;
  }

  function sessionsPanel() {
    const box = el('div', 'cx-sessions');
    const list = sessions().filter((s) => !s.ended || s.ageMs < 10 * 60000);
    const threads = (app() && Array.isArray(app().threads)) ? app().threads : [];
    const head = el('div', 'cx-sec-head');
    head.appendChild(el('span', 'cx-sec-title', t('codex_sessions', 'Sessions')));
    const working = list.filter((s) => s.state === 'running' || s.state === 'waiting').length;
    if (working) head.appendChild(el('span', 'cx-sec-sum', t('codex_n_working', '{n} working').replace('{n}', String(working))));
    box.appendChild(head);
    const scroll = el('div', 'cx-list');
    // Every row opens its conversation, the way a session row does on the
    // Claude tile.
    const row = (cls, title, sub, open) => {
      const r = el('button', 'cx-row ' + cls);
      r.type = 'button';
      r.appendChild(el('span', 'cx-dot'));
      const main = el('span', 'cx-row-main');
      main.appendChild(el('span', 'cx-row-title', title));
      main.appendChild(el('span', 'cx-row-sub', sub));
      r.appendChild(main);
      r.addEventListener('click', open);
      return r;
    };
    if (list.length) {
      list.slice(0, 6).forEach((s) => {
        const title = s.task || s.project || t('codex_session', 'Session');
        scroll.appendChild(row('is-' + (s.ended ? 'ended' : s.state), title,
          [s.task ? s.project : '', s.model, stateLabel(s)].filter(Boolean).join(' · '),
          () => openThread(s.id, title, s.project)));
      });
    } else if (!(link() && link().linked)) {
      const n = el('div', 'cx-unlinked');
      n.appendChild(el('span', 'cx-muted', t('codex_live_unlinked', 'Connect Codex to see sessions working and approve their requests here.')));
      const b = el('button', 'cx-btn is-go', t('codex_connect', 'Connect'));
      b.type = 'button';
      b.addEventListener('click', () => { linkPanel = true; paint(); loadLink(true); });
      n.appendChild(b);
      scroll.appendChild(n);
    }
    if (threads.length) {
      scroll.appendChild(el('div', 'cx-sub-title', t('codex_recent', 'Recent in Codex')));
      threads.slice(0, 6).forEach((th) => {
        const title = th.title || th.project || '—';
        scroll.appendChild(row('is-thread is-' + th.status, title,
          [th.project, sourceLabel(th.source), th.updatedAt ? ago(th.updatedAt) : ''].filter(Boolean).join(' · '),
          () => openThread(th.id, title, th.project)));
      });
    }
    box.appendChild(scroll);
    return box;
  }

  // ── usage face ──
  function usageFace() {
    const a = app();
    const u = a && a.usage;
    const wrap = el('div', 'cx-usage');
    if (!a || !a.caps || a.caps.usage === false) {
      wrap.appendChild(el('div', 'cx-state', t('codex_usage_unsupported', 'This copy of Codex does not report usage. Updating Codex adds it.')));
      return wrap;
    }
    if (!u) { wrap.appendChild(el('div', 'cx-state', t('codex_usage_reading', 'Reading usage from Codex…'))); return wrap; }
    const stats = el('div', 'cx-stats');
    const stat = (label, value) => {
      const s = el('div', 'cx-stat');
      s.appendChild(el('div', 'cx-stat-v', value));
      s.appendChild(el('div', 'cx-stat-k', label));
      stats.appendChild(s);
    };
    stat(t('codex_today', 'Today'), hTok(u.today));
    stat(t('codex_7d', '7 days'), hTok(u.last7));
    stat(t('codex_30d', '30 days'), hTok(u.last30));
    if (Number.isFinite(u.lifetime)) stat(t('codex_lifetime', 'All time'), hTok(u.lifetime));
    wrap.appendChild(stats);
    const chart = el('div', 'cx-days');
    const max = Math.max(1, ...u.days.map((d) => d.tokens));
    u.days.forEach((d) => {
      const col = el('span', 'cx-day' + (d.tokens ? '' : ' is-zero'));
      col.style.height = Math.max(2, Math.round((d.tokens / max) * 100)) + '%';
      col.title = d.date + ' · ' + hTok(d.tokens);
      chart.appendChild(col);
    });
    wrap.appendChild(chart);
    // Tokens for the whole account, every device and app that uses it, which is
    // what Codex itself reports. Said once, so the numbers are not read as "this PC".
    const foot = [t('codex_usage_scope', 'Tokens for your whole account, as Codex reports them.')];
    if (Number.isFinite(u.streak) && u.streak > 0) foot.push(t('codex_streak', '{n}-day streak').replace('{n}', String(u.streak)));
    wrap.appendChild(el('div', 'cx-muted', foot.join(' ')));
    return wrap;
  }

  // ── link ──
  async function loadLink(fresh) {
    const d = await api('/api/codex/link' + (fresh ? '?fresh=1' : ''));
    if (d && payload) {
      payload.link = { linked: d.linked, complete: d.complete, unparsable: d.unparsable, trust: d.trust, exists: d.exists, linkedAt: d.linkedAt, repairedAt: d.repairedAt };
      paint();
    }
  }
  async function doLink(on) {
    if (linking) return;
    linking = true;
    paint();
    const d = await api(on ? '/api/codex/link' : '/api/codex/unlink', { method: 'POST' });
    linking = false;
    if (d && payload) payload.link = { linked: d.linked, complete: d.complete, unparsable: d.unparsable, trust: d.trust, exists: d.exists, linkedAt: d.linkedAt, repairedAt: d.repairedAt };
    if (!d || d.ok === false) {
      if (window.XenonToast) window.XenonToast.show({ type: 'warn', title: d && d.error === 'unparsable' ? t('codex_link_unparsable', 'Your Codex hooks.json could not be read, so Xenon left it as it is.') : t('codex_link_failed', 'Could not update the Codex hooks') });
    }
    paint();
  }
  function trustState() {
    const l = link();
    if (!l || !l.linked) return 'off';
    if (!l.trust || l.trust.trusted === null || l.trust.trusted === undefined) return 'unknown';
    return l.trust.trusted ? 'on' : 'untrusted';
  }
  function linkPanelView() {
    const box = el('div', 'cx-panel');
    const top = el('div', 'cx-top');
    top.appendChild(el('span', 'cx-name-t', t('codex_link_title', 'Connect Codex')));
    const close = el('button', 'cx-btn is-quiet', t('codex_close', 'Close'));
    close.type = 'button';
    close.addEventListener('click', () => { linkPanel = false; paint(); });
    top.appendChild(close);
    box.appendChild(top);
    const l = link();
    const st = trustState();
    const p = (k, fb) => box.appendChild(el('p', 'cx-p', t(k, fb)));
    if (l && l.unparsable) p('codex_link_unparsable', 'Your Codex hooks.json could not be read, so Xenon left it as it is.');
    if (st === 'off') {
      p('codex_link_what', 'Xenon adds five small hooks to Codex: they tell this screen when a session starts, works and stops, and let you answer approvals here. Your own hooks stay as they are, and a copy of the file is kept.');
      p('codex_link_trust_after', 'Codex runs a new hook only after you trust it. After connecting, open Codex and type /hooks to trust the Xenon hooks.');
    } else if (st === 'on') {
      p('codex_link_ok', 'Connected. Codex runs the Xenon hooks: sessions and approvals appear here.');
    } else {
      p('codex_link_trust', 'One step left: open Codex, type /hooks and trust the Xenon hooks. Until then Codex does not run them.');
      if (st === 'unknown') p('codex_link_trust_unknown', 'Xenon cannot check this right now; if sessions do not appear here, the hooks are not trusted yet.');
    }
    p('codex_link_new_sessions', 'Hooks reach the sessions started after this step.');
    const acts = el('div', 'cx-panel-acts');
    if (st === 'off') {
      const b = el('button', 'cx-btn is-go', t('codex_connect', 'Connect'));
      b.type = 'button'; b.disabled = linking;
      b.addEventListener('click', () => doLink(true));
      acts.appendChild(b);
    } else {
      const chk = el('button', 'cx-btn', t('codex_check_again', 'Check again'));
      chk.type = 'button';
      chk.addEventListener('click', () => loadLink(true));
      acts.appendChild(chk);
      const b = el('button', 'cx-btn is-quiet', t('codex_disconnect', 'Disconnect'));
      b.type = 'button'; b.disabled = linking;
      b.addEventListener('click', () => doLink(false));
      acts.appendChild(b);
    }
    box.appendChild(acts);
    return box;
  }

  // ── header ──
  function currentFace() {
    try { return localStorage.getItem(FACE_KEY) === 'usage' ? 'usage' : 'live'; } catch { return 'live'; }
  }
  function setFace(f) {
    try { localStorage.setItem(FACE_KEY, f); } catch { /* private mode */ }
    paint();
  }
  function header() {
    const top = el('div', 'cx-top');
    const name = el('button', 'cx-name');
    name.type = 'button';
    const st = trustState();
    name.appendChild(el('span', 'cx-link-mark is-' + st));
    name.appendChild(el('span', 'cx-name-t', 'Codex'));
    name.title = st === 'on' ? t('codex_linked', 'Connected to Codex') : t('codex_link_title', 'Connect Codex');
    name.addEventListener('click', () => { linkPanel = true; paint(); loadLink(true); });
    top.appendChild(name);
    const faces = el('div', 'cx-faces');
    [['live', t('claude_face_live', 'Live')], ['usage', t('claude_face_usage', 'Usage')]].forEach(([id, label]) => {
      const b = el('button', 'cx-face' + (currentFace() === id ? ' is-on' : ''), label);
      b.type = 'button';
      b.setAttribute('aria-pressed', currentFace() === id ? 'true' : 'false');
      b.addEventListener('click', () => setFace(id));
      faces.appendChild(b);
    });
    top.appendChild(faces);
    const r = el('button', 'cx-btn is-quiet cx-refresh', refreshing ? '…' : '↻');
    r.type = 'button';
    r.title = t('codex_refresh', 'Read again from Codex');
    r.setAttribute('aria-label', r.title);
    r.disabled = refreshing;
    r.addEventListener('click', refresh);
    top.appendChild(r);
    return top;
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    paint();
    const d = await api('/api/codex?refresh=1');
    refreshing = false;
    if (d) payload = d;
    paint();
  }

  // The one sentence a tile with no data source says, instead of loading forever.
  function appStateLine() {
    const a = app();
    if (!a) return t('codex_reading', 'Reading Codex…');
    if (a.state === 'missing') return t('codex_missing', 'Codex is not installed on this computer. Install the ChatGPT app, the Codex extension for your editor, or the codex command, then sign in.');
    if (a.state === 'signedOut') return t('codex_signed_out', 'Codex is not signed in. Open Codex and sign in with your ChatGPT account.');
    if (a.state === 'error') return t('codex_error', 'Codex did not answer. Xenon tries again in a moment.') + (a.reason ? ' (' + a.reason + ')' : '');
    return '';
  }

  function build() {
    const wrap = el('div', 'cx-wrap');
    if (linkPanel) { wrap.appendChild(linkPanelView()); return wrap; }
    if (thread) {
      // A card waiting on you still comes first, even over an open conversation.
      const pendNow = approvalsOn() ? approvals().filter((a) => !a.urgent) : [];
      if (pendNow.length) {
        const box = el('div', 'cx-decs');
        box.appendChild(decisionCard(pendNow[0], false));
        wrap.appendChild(box);
      }
      wrap.appendChild(threadView());
      return wrap;
    }
    wrap.appendChild(header());
    const l = link();
    if (l && l.repairedAt && trustState() !== 'on') {
      wrap.appendChild(el('div', 'cx-notice is-warn', t('codex_link_repaired', 'The Codex hooks were updated because Xenon or Node moved. Open Codex, type /hooks and trust them again.')));
    }
    const pend = approvalsOn() ? approvals().filter((a) => !a.urgent) : [];
    if (pend.length) {
      const box = el('div', 'cx-decs');
      if (pend.length > 1) box.classList.add('is-pair');
      pend.slice(0, 2).forEach((a) => box.appendChild(decisionCard(a, false)));
      if (pend.length > 2) box.appendChild(el('div', 'cx-muted', t('claude_more_waiting', '{n} more waiting').replace('{n}', String(pend.length - 2))));
      wrap.appendChild(box);
    }
    // No plan data can come (not installed, signed out, not answering): say so
    // in one sentence. Sessions reported by the hooks still show, because they
    // do not depend on the plan side, but the plan panel does not pretend to load.
    const a = app();
    const blocked = !a || a.state === 'missing' || a.state === 'signedOut' || a.state === 'error';
    if (blocked) {
      const line = appStateLine();
      if (!sessions().length) { wrap.appendChild(el('div', 'cx-state', line)); return wrap; }
      wrap.appendChild(el('div', 'cx-notice', line));
      const only = el('div', 'cx-livegrid is-single');
      only.appendChild(sessionsPanel());
      wrap.appendChild(only);
      return wrap;
    }
    if (currentFace() === 'usage') { wrap.appendChild(usageFace()); return wrap; }
    const grid = el('div', 'cx-livegrid');
    grid.appendChild(sessionsPanel());
    grid.appendChild(limitsPanel());
    wrap.appendChild(grid);
    return wrap;
  }

  // ── painting ──
  function tick() {
    // Own attribute names (data-cx-*): the Claude tile's ticker rewrites its countdown
    // attributes across the WHOLE page and reads the reset time as seconds, so sharing
    // its names made the two tiles overwrite each other every second
    // (test/tile-ticker-attrs.test.mjs).
    const nodes = document.querySelectorAll('.codex-widget-mount [data-cx-reset-at], .codex-widget-mount [data-cx-expires-at], .cx-overlay [data-cx-expires-at]');
    nodes.forEach((n) => {
      if (n.dataset.cxResetAt) n.textContent = dur(Number(n.dataset.cxResetAt) - Date.now());
      else n.textContent = (n.dataset.tpl || '{t}').replace('{t}', mmss(Number(n.dataset.cxExpiresAt) - Date.now()));
    });
    if (!nodes.length) stopTicker();
  }
  function startTicker() { if (!ticker) ticker = setInterval(tick, 1000); }
  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

  function paint() {
    if (press.pressing) { press.defer(); return; }
    arming.forget(approvals().map((a) => a.id));
    tiles().forEach((tile) => {
      const mount = tile.querySelector('.codex-widget-mount');
      if (!mount || isParked(tile)) return;
      const kept = AK.keepScroll(mount, SCROLLERS);
      mount.replaceChildren(build());
      AK.restoreScroll(mount, SCROLLERS, kept);
      // A conversation that just loaded opens on its latest message; after
      // that a push keeps wherever the reader scrolled to.
      const th = mount.querySelector('.cx-thread');
      if (th && threadPinBottom) th.scrollTop = th.scrollHeight;
    });
    if (thread && !thread.loading) threadPinBottom = false;
    syncOverlay();
    const a = app();
    if (approvals().length || (a && a.limits)) startTicker(); else stopTicker();
  }

  // ── topbar marker ──
  // Absent when nothing is happening; a quiet mark while a session works; an
  // amber dot when one is waiting for you. A prompt glyph, not OpenAI's mark:
  // this is Xenon working with Codex, not an OpenAI surface.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function glyph() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 12');
    svg.setAttribute('class', 'cx-tb-mark');
    svg.setAttribute('aria-hidden', 'true');
    const p1 = document.createElementNS(SVG_NS, 'path');
    p1.setAttribute('d', 'M2 2.5 6.5 6 2 9.5');
    const p2 = document.createElementNS(SVG_NS, 'path');
    p2.setAttribute('d', 'M8.5 9.5H14');
    p2.setAttribute('class', 'cx-tb-caret');
    svg.append(p1, p2);
    return svg;
  }
  function syncTopbar() {
    const host = document.getElementById('clock-codex');
    if (!host) return;
    if (!topbarOn()) {
      if (!host.hidden) { host.hidden = true; host.replaceChildren(); }
      topbarSig = '';
      return;
    }
    const live = sessions().filter((s) => !s.ended && !s.resting);
    const working = live.filter((s) => s.state === 'running').length;
    const pending = approvals().length;
    const sig = working + '|' + pending;
    if (sig === topbarSig) return;
    topbarSig = sig;
    if (!working && !pending) { host.hidden = true; host.replaceChildren(); return; }
    host.hidden = false;
    const chip = el('span', 'cx-tb ' + (pending ? 'is-waiting' : 'is-working'));
    chip.appendChild(glyph());
    if (pending) chip.appendChild(el('span', 'cx-tb-alert'));
    else if (working > 1) chip.appendChild(el('span', 'cx-tb-n', String(working)));
    const parts = [];
    if (pending) parts.push(t('codex_bar_waiting', 'Codex wants your OK'));
    if (working) parts.push(t('codex_bar_working', 'Codex is working'));
    chip.title = parts.join(' · ');
    chip.setAttribute('role', 'img');
    chip.setAttribute('aria-label', chip.title);
    host.replaceChildren(chip);
  }

  function renderNow() {
    syncTopbar();
    if (!tiles().length) syncOverlay();
    else paint();
  }

  async function seed() {
    if (seedInflight) return;
    seedInflight = true;
    try {
      const d = await api('/api/codex');
      if (d) payload = d;
    } finally { seedInflight = false; }
    paint();
  }

  // ── public ──
  function renderWidgets() {
    if (!tiles().length) {
      seeded = false;
      stopTicker();
      if (threadTimer) { clearTimeout(threadTimer); threadTimer = null; }
      thread = null;
      // The overlay survives: a pending approval stays answerable from any page.
      if (!approvals().length) closeOverlay();
      return;
    }
    paint();
    if (!seeded) { seeded = true; seed(); }
  }
  function onSSE(data) {
    if (!data) return;
    payload = data;
    if (press.pressing) { press.defer(); return; }
    renderNow();
  }
  function onSettingsChanged() {
    if (!approvalsOn()) closeOverlay();
    topbarSig = '';
    syncTopbar();
    paint();
  }
  window.addEventListener('xenon:page-change', () => { if (tiles().length) paint(); });

  window.CodexWidget = { renderWidgets, onSSE, onSettingsChanged };
})();
