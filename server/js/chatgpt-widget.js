'use strict';
// "Ask ChatGPT" tile: a conversation answered on the user's ChatGPT plan.
//
// The answers come from OpenAI's own codex program signed in with that plan
// (server/chatgpt-ask.js says why that is the one honest way in). The tile says
// so where it matters: answers do not show up in the ChatGPT app's history, and
// they draw on the same plan limits, whose usage it shows in the header (read
// from the Codex feed, the same numbers as the Codex tile).
//
// Text safety: the user's words render through textContent; the model's
// through _aiRenderMarkdown (js/ai.js), which escapes first and only emits
// http(s)/mailto links. Nothing else reaches innerHTML.
(function () {
  const el = makeEl;
  const api = apiJson;
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const AK = window.ApprovalKeys;

  let list = [];               // [{ id, title, updatedAt, count, lastRole }]
  let active = [];             // [{ conversationId, forMs }]
  let activeAt = new Map();    // conversationId → local time the turn was seen starting
  const convs = new Map();     // id → full conversation
  let openId = null;           // null = a new conversation
  let view = 'chat';           // 'chat' | 'list'
  let draft = '';
  let sending = false;
  let cli = null;              // /api/ai/cli/status?provider=codex
  let models = null;           // [{ id, label }]
  let plan = null;             // Codex feed `app` (limits for the header)
  let seeded = false;
  let pinnedBottom = true;
  let ticker = null;
  const press = AK.createPressGuard('.chatgpt-widget-mount', () => paint());

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="chatgpt"]')).filter((n) => n.closest('.pager-page'));
  }
  function isParked(tile) {
    const page = tile.closest('.pager-page');
    return !!(page && page.classList.contains('is-parked') && !document.body.classList.contains('layout-editing'));
  }
  function model() {
    const w = (typeof hubSettings === 'object' && hubSettings && hubSettings.chatgptWidget) || null;
    return (w && w.model) || 'default';
  }
  function isBusy(id) { return !!id && active.some((a) => a.conversationId === id); }
  function mmss(ms) { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  const ERR = {
    cli_not_installed: () => t('cg_err_missing', 'Codex is not installed on this computer, so ChatGPT cannot answer here.'),
    cli_not_logged_in: () => t('cg_err_signin', 'Codex is not signed in. Open Codex and sign in with your ChatGPT account.'),
    cli_timeout: () => t('cg_err_timeout', 'No answer in time. Try again, or ask something shorter.'),
    cli_offline: () => t('cg_err_offline', 'Codex could not reach OpenAI. Check the connection and try again.'),
    cli_busy: () => t('cg_err_busy', 'Two answers are already being written. Try again in a moment.'),
    cli_cancelled: () => t('cg_err_cancelled', 'Stopped.'),
  };
  function errText(code) { return (ERR[code] || (() => t('cg_err_failed', 'ChatGPT did not answer. Try again.')))(); }

  // ── data ──
  async function loadList() {
    const d = await api('/api/chatgpt');
    if (d) applyList(d);
  }
  function applyList(d) {
    if (Array.isArray(d.conversations)) list = d.conversations;
    if (Array.isArray(d.active)) {
      const ids = new Set(d.active.map((a) => a.conversationId));
      for (const a of d.active) if (!activeAt.has(a.conversationId)) activeAt.set(a.conversationId, Date.now() - (a.forMs || 0));
      for (const id of Array.from(activeAt.keys())) if (!ids.has(id)) activeAt.delete(id);
      active = d.active;
    }
    if (d.changed && d.changed.id) convs.set(d.changed.id, d.changed);
    for (const id of Array.from(convs.keys())) if (!list.some((c) => c.id === id)) convs.delete(id);
    if (openId && !list.some((c) => c.id === openId)) openId = null;
  }
  async function loadConversation(id) {
    const d = await api('/api/chatgpt/conversation?id=' + encodeURIComponent(id));
    if (d && d.ok && d.conversation) { convs.set(id, d.conversation); paint(); }
  }
  async function loadCli() {
    const [s, m] = await Promise.all([api('/api/ai/cli/status?provider=codex'), api('/api/ai/cli/models?provider=codex')]);
    if (s) cli = s;
    if (m && Array.isArray(m.models)) models = m.models;
    paint();
  }

  // ── actions ──
  async function send() {
    const text = draft.trim();
    if (!text || sending || isBusy(openId)) return;
    sending = true;
    paint();
    const d = await api('/api/chatgpt/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: openId || undefined, text }),
    });
    sending = false;
    if (d && d.ok) {
      draft = '';
      openId = d.conversationId;
      pinnedBottom = true;
      if (!activeAt.has(openId)) activeAt.set(openId, Date.now());
      if (!active.some((a) => a.conversationId === openId)) active = active.concat({ conversationId: openId, forMs: 0 });
      await loadConversation(openId);
    } else if (window.XenonToast) {
      window.XenonToast.show({ type: 'warn', title: d && d.error === 'busy' ? t('cg_busy', 'Still answering the last message') : t('cg_send_failed', 'Could not send the message') });
    }
    paint();
  }
  async function cancel(id) {
    await api('/api/chatgpt/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: id }) });
  }
  async function remove(id) {
    await api('/api/chatgpt/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    convs.delete(id);
    list = list.filter((c) => c.id !== id);
    if (openId === id) openId = null;
    paint();
  }
  function openConversation(id) {
    openId = id;
    view = 'chat';
    pinnedBottom = true;
    if (id && !convs.has(id)) loadConversation(id);
    paint();
  }
  function setModel(m) {
    if (typeof normalizeSettings !== 'function' || typeof saveHubSettings !== 'function') return;
    hubSettings = normalizeSettings({ ...hubSettings, chatgptWidget: { model: m } });
    saveHubSettings();
    paint();
  }

  // ── pieces ──
  // The plan's busiest window, in one short line: it is the same limit the
  // answers draw on, so it belongs next to the box you type into.
  function planLine() {
    const lim = plan && plan.limits && Array.isArray(plan.limits.buckets) ? plan.limits.buckets[0] : null;
    if (!lim) return null;
    const wins = [lim.primary, lim.secondary].filter(Boolean);
    if (!wins.length) return null;
    const w = wins.slice().sort((a, b) => b.pct - a.pct)[0];
    const name = w.windowMins === 300 ? t('codex_win_5h', '5 hours') : w.windowMins === 10080 ? t('codex_win_week', 'Week')
      : (w.windowMins >= 43000 && w.windowMins <= 44700) ? t('codex_win_month', '30 days') : t('codex_win_plan', 'Plan');
    const n = el('span', 'cg-plan' + (w.pct >= 90 ? ' is-crit' : w.pct >= 70 ? ' is-warn' : ''), name + ' ' + w.pct + '%');
    n.title = t('cg_plan_hint', 'Your ChatGPT plan usage, shared with Codex');
    return n;
  }
  function header() {
    const top = el('div', 'cg-top');
    top.appendChild(el('span', 'cg-name', 'ChatGPT'));
    const p = planLine();
    if (p) top.appendChild(p);
    const spacer = el('span', 'cg-spacer');
    top.appendChild(spacer);
    const lb = el('button', 'cg-btn is-quiet' + (view === 'list' ? ' is-on' : ''), t('cg_chats', 'Chats'));
    lb.type = 'button';
    lb.setAttribute('aria-pressed', view === 'list' ? 'true' : 'false');
    lb.addEventListener('click', () => { view = view === 'list' ? 'chat' : 'list'; paint(); });
    top.appendChild(lb);
    const nb = el('button', 'cg-btn', t('cg_new', 'New'));
    nb.type = 'button';
    nb.addEventListener('click', () => { openConversation(null); });
    top.appendChild(nb);
    return top;
  }

  function listView() {
    const box = el('div', 'cg-list');
    const mrow = el('label', 'cg-model');
    mrow.appendChild(el('span', '', t('cg_model', 'Model')));
    const sel = document.createElement('select');
    sel.className = 'cg-select';
    const opts = [{ id: 'default', label: t('cg_model_default', 'Codex default') }].concat((models || []).filter((m) => m && m.id && m.id !== 'default'));
    for (const m of opts) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.label || m.id;
      sel.appendChild(o);
    }
    if (!opts.some((m) => m.id === model())) { const o = document.createElement('option'); o.value = model(); o.textContent = model(); sel.appendChild(o); }
    sel.value = model();
    sel.addEventListener('change', () => setModel(sel.value));
    mrow.appendChild(sel);
    box.appendChild(mrow);
    if (!list.length) {
      box.appendChild(el('div', 'cg-muted', t('cg_no_chats', 'No conversations yet.')));
      return box;
    }
    const scroll = el('div', 'cg-list-scroll');
    for (const c of list) {
      const row = el('div', 'cg-row' + (c.id === openId ? ' is-open' : ''));
      const main = el('button', 'cg-row-main');
      main.type = 'button';
      main.appendChild(el('span', 'cg-row-title', c.title || '…'));
      // timeParts() (utils.js) carries Settings → Time format; a bare locale
      // format would ignore the user's 12/24-hour choice.
      let when = '';
      try { when = new Intl.DateTimeFormat(t('locale'), timeParts({ day: 'numeric', month: 'short' })).format(new Date(c.updatedAt)); } catch { when = ''; }
      main.appendChild(el('span', 'cg-row-sub', (isBusy(c.id) ? t('cg_thinking', 'Thinking') + ' · ' : '') + when));
      main.addEventListener('click', () => openConversation(c.id));
      row.appendChild(main);
      const del = el('button', 'cg-btn is-quiet cg-del', '✕');
      del.type = 'button';
      del.title = t('cg_delete', 'Delete');
      del.setAttribute('aria-label', del.title + ': ' + (c.title || ''));
      del.addEventListener('click', () => remove(c.id));
      row.appendChild(del);
      scroll.appendChild(row);
    }
    box.appendChild(scroll);
    return box;
  }

  function message(m) {
    const row = el('div', 'cg-msg is-' + m.role + (m.error ? ' is-error' : ''));
    if (m.role === 'user') {
      row.appendChild(el('div', 'cg-bubble', m.text));
    } else if (m.error) {
      row.appendChild(el('div', 'cg-bubble', errText(m.error)));
    } else {
      const b = el('div', 'cg-bubble ai-msg-markdown');
      if (typeof _aiRenderMarkdown === 'function') b.innerHTML = _aiRenderMarkdown(m.text);   // escapes, scheme-checked links
      else b.textContent = m.text;
      row.appendChild(b);
    }
    return row;
  }

  function emptyState() {
    const box = el('div', 'cg-empty');
    if (cli && cli.installed === false) box.appendChild(el('p', 'cg-p', errText('cli_not_installed')));
    else if (cli && cli.loggedIn === false) box.appendChild(el('p', 'cg-p', errText('cli_not_logged_in')));
    else box.appendChild(el('p', 'cg-p is-big', t('cg_hello', 'Ask ChatGPT anything.')));
    box.appendChild(el('p', 'cg-p', t('cg_how', 'Answers use your ChatGPT plan through OpenAI Codex on this PC. They are kept here, not in your ChatGPT history.')));
    return box;
  }

  function chatView() {
    const wrap = el('div', 'cg-chat');
    const thread = el('div', 'cg-thread');
    const conv = openId ? convs.get(openId) : null;
    if (!openId) thread.appendChild(emptyState());
    else if (!conv) thread.appendChild(el('div', 'cg-muted', t('cg_loading', 'Loading…')));
    else conv.messages.forEach((m) => thread.appendChild(message(m)));
    if (isBusy(openId)) {
      const row = el('div', 'cg-msg is-assistant is-thinking');
      const b = el('div', 'cg-bubble');
      const label = el('span', 'cg-think', t('cg_thinking', 'Thinking') + ' · ');
      const timer = el('span', 'cg-think-t', mmss(Date.now() - (activeAt.get(openId) || Date.now())));
      timer.dataset.since = String(activeAt.get(openId) || Date.now());
      label.appendChild(timer);
      b.appendChild(label);
      const stop = el('button', 'cg-btn is-quiet', t('cg_stop', 'Stop'));
      stop.type = 'button';
      const id = openId;
      stop.addEventListener('click', () => cancel(id));
      b.appendChild(stop);
      row.appendChild(b);
      thread.appendChild(row);
    }
    thread.addEventListener('scroll', () => { pinnedBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40; });
    wrap.appendChild(thread);

    const form = el('form', 'cg-compose');
    const ta = document.createElement('textarea');
    ta.className = 'cg-input';
    ta.rows = 2;
    ta.maxLength = 8000;
    ta.placeholder = t('cg_placeholder', 'Message ChatGPT');
    ta.value = draft;
    ta.dataset.keep = 'cg-draft';
    const blocked = !!(cli && (cli.installed === false || cli.loggedIn === false));
    ta.disabled = blocked;
    ta.addEventListener('input', () => { draft = ta.value; sendBtn.disabled = !draft.trim() || sending || isBusy(openId); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    const sendBtn = el('button', 'cg-send', t('cg_send', 'Send'));
    sendBtn.type = 'submit';
    sendBtn.disabled = blocked || !draft.trim() || sending || isBusy(openId);
    form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
    form.append(ta, sendBtn);
    wrap.appendChild(form);
    return wrap;
  }

  function build() {
    const wrap = el('div', 'cg-wrap');
    wrap.appendChild(header());
    wrap.appendChild(view === 'list' ? listView() : chatView());
    return wrap;
  }

  function paint() {
    if (press.pressing) { press.defer(); return; }
    tiles().forEach((tile) => {
      const mount = tile.querySelector('.chatgpt-widget-mount');
      if (!mount || isParked(tile)) return;
      const prev = mount.querySelector('.cg-thread');
      const keepTop = prev ? prev.scrollTop : 0;
      const listPrev = mount.querySelector('.cg-list-scroll');
      const keepList = listPrev ? listPrev.scrollTop : 0;
      const focused = document.activeElement && mount.contains(document.activeElement) && document.activeElement.dataset.keep === 'cg-draft';
      let sel = null;
      if (focused) { try { sel = [document.activeElement.selectionStart, document.activeElement.selectionEnd]; } catch { sel = null; } }
      mount.replaceChildren(build());
      const thread = mount.querySelector('.cg-thread');
      if (thread) thread.scrollTop = pinnedBottom ? thread.scrollHeight : keepTop;
      const ls = mount.querySelector('.cg-list-scroll');
      if (ls) ls.scrollTop = keepList;
      if (focused) {
        const ta = mount.querySelector('[data-keep="cg-draft"]');
        if (ta && !ta.disabled) { try { ta.focus({ preventScroll: true }); if (sel) ta.setSelectionRange(sel[0], sel[1]); } catch { /* not focusable */ } }
      }
    });
    if (active.length) startTicker(); else stopTicker();
  }
  function startTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      const nodes = document.querySelectorAll('.chatgpt-widget-mount .cg-think-t');
      nodes.forEach((n) => { n.textContent = mmss(Date.now() - Number(n.dataset.since)); });
      if (!active.length) stopTicker();
    }, 1000);
  }
  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

  // ── public ──
  function renderWidgets() {
    if (!tiles().length) { seeded = false; stopTicker(); return; }
    paint();
    if (!seeded) {
      seeded = true;
      loadList().then(() => { if (!openId && list.length) openConversation(list[0].id); else paint(); });
      loadCli();
    }
  }
  function onSSE(d) {
    if (!d) return;
    applyList(d);
    if (!tiles().length) return;
    if (press.pressing) { press.defer(); return; }
    paint();
  }
  // The Codex feed: only its plan limits are used here, for the header line.
  function onCodex(d) {
    const next = d && d.app ? d.app : null;
    const sig = (x) => JSON.stringify(x && x.limits);
    const changed = sig(next) !== sig(plan);
    plan = next;
    if (changed && tiles().length && !press.pressing) paint();
  }
  window.addEventListener('xenon:page-change', () => { if (tiles().length) paint(); });

  window.ChatGPTWidget = { renderWidgets, onSSE, onCodex };
})();
