'use strict';
// ── Claude Code / Codex building widgets: the dashboard's side ──────────────
// The xenon-mcp bridge pairs and calls through the server (server/mcp-dev.js);
// this page is where the person says yes to a pairing, and where the tools
// learn what only the dashboard knows: is the widget on screen and where, what
// the sandbox refused, what went wrong while it ran. It also places a widget
// the tools just installed, exactly as Bit's create_widget does.
//
// Only a dashboard on THIS machine takes part: a paired phone neither approves
// a pairing nor answers (the server refuses its requests to these paths too).
(function () {
  const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'];
  if (!LOOPBACK.includes(window.location.hostname)) {
    window.McpDev = Object.freeze({ listen() {} });
    return;
  }
  const BASE = (typeof SERVER === 'string' ? SERVER : '') + '/api/mcp/dev/';
  const tr = (key, fallback) => (typeof t === 'function' ? t(key, fallback) : fallback);
  const post = (sub, body) => fetch(BASE + sub, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => null);
  const open = new Map();   // pairId → backdrop
  const expiry = new Map(); // pairId → timer that closes it when the server forgets it

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // The same dialog look as a widget's permissions: a name, what it may do,
  // what it may not, and two buttons. Closing it any other way is a No.
  function showPair(p) {
    if (!p || typeof p.id !== 'string' || open.has(p.id)) return;
    const bd = el('div', 'cw-perm-backdrop cw-perm-backdrop--pair');
    const panel = el('div', 'cw-perm');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.appendChild(el('div', 'cw-perm-title', tr('mcp_pair_title', 'Let this tool build widgets?')));
    const who = el('div', 'cw-perm-pkg');
    who.appendChild(el('span', 'cw-perm-name', String(p.name || 'MCP')));
    panel.appendChild(who);
    panel.appendChild(el('div', 'cw-perm-desc', tr('mcp_pair_desc', 'It can read the Widget SDK, install the widgets you make together, put them on this page, and see what goes wrong in them and a picture of their tile.')));
    panel.appendChild(el('div', 'cw-perm-note', tr('mcp_pair_note', 'It never approves a widget\'s permissions: you still do that here. Allow it only if you just connected it yourself. You can remove it in Settings, Widgets.')));
    const row = el('div', 'cw-perm-actions-row');
    const no = el('button', 'cw-btn', tr('cw_cancel', 'Cancel'));
    no.type = 'button';
    const yes = el('button', 'cw-btn cw-btn--primary', tr('cw_allow', 'Allow'));
    yes.type = 'button';
    const decide = (allow) => {
      closePair(p.id);
      post('pair/answer', { id: p.id, allow });
    };
    no.addEventListener('click', () => decide(false));
    yes.addEventListener('click', () => decide(true));
    bd.addEventListener('click', (ev) => { if (ev.target === bd) decide(false); });
    bd.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') decide(false); });
    row.append(no, yes);
    panel.appendChild(row);
    bd.appendChild(panel);
    document.body.appendChild(bd);
    open.set(p.id, bd);
    // The server forgets an unanswered pairing after a while; the dialog goes too.
    const left = Number(p.expiresInMs);
    if (Number.isFinite(left) && left > 0) expiry.set(p.id, setTimeout(() => closePair(p.id), left));
    yes.focus();
  }

  function closePair(id) {
    const bd = open.get(id);
    if (!bd) return;
    open.delete(id);
    clearTimeout(expiry.get(id));
    expiry.delete(id);
    bd.remove();
  }

  async function place(q, CW) {
    // A hidden window leaves it to the one the person is looking at.
    if (document.visibilityState !== 'visible') return;
    // Every visible dashboard reloads the new files; only the first to answer
    // puts the widget on its page, so two windows never place it twice.
    if (typeof CW.refreshPackages === 'function') await CW.refreshPackages();
    if (typeof CW.renderWidgets === 'function') CW.renderWidgets();
    const r = await post('report', { reqId: q.reqId, data: { ready: true } });
    if (!r || !r.accepted) return;
    const placed = typeof CW.placeCreated === 'function' ? await CW.placeCreated(String(q.id)) : null;
    // Then show its page: on a full page it lands on a new one, and a widget
    // already on a tile may sit on another page.
    if (typeof CW.devShow === 'function') requestAnimationFrame(() => CW.devShow(String(q.id), typeof placed === 'string' ? placed : null));
  }

  function issues(id, CW) {
    const at = CW.devLookup(id);
    const blocked = CW.getSandboxIssues(id);
    const errors = CW.getRuntimeErrors(id);
    const perf = (CW.getPerfStats() || {})[id] || null;
    // found picks the dashboard that knows this widget; onScreen is whether its
    // tile is in view right now (a tile on another page still reports perf).
    return { found: at.found || blocked.length > 0 || errors.length > 0 || !!perf, onScreen: at.found === true, approved: at.approved, blocked, errors, perf };
  }

  function answer(q) {
    const CW = window.CustomWidget;
    if (!q || typeof q.reqId !== 'string' || typeof q.id !== 'string' || !CW) return;
    if (q.kind === 'place') { place(q, CW); return; }
    if (q.kind === 'where' && typeof CW.devLookup === 'function') { post('report', { reqId: q.reqId, data: CW.devLookup(q.id) }); return; }
    if (q.kind === 'issues' && typeof CW.devLookup === 'function') post('report', { reqId: q.reqId, data: issues(q.id, CW) });
  }

  // ── Settings, Widgets: connect a tool, see and remove the connected ones ──
  const CONNECT_TEXT = {
    ok: ['settings_mcp_connected', 'Done. Open a new session there and ask it to build a widget.'],
    already: ['settings_mcp_already', 'Already connected.'],
    not_installed: ['settings_mcp_not_installed', 'It is not installed on this PC.'],
    failed: ['settings_mcp_failed', 'Could not add it. Add the server below by hand instead.'],
  };

  function say(kind) {
    const line = document.getElementById('settings-mcp-state');
    if (!line) return;
    const [key, fallback] = CONNECT_TEXT[kind] || CONNECT_TEXT.failed;
    line.textContent = tr(key, fallback);
    line.hidden = false;
  }

  async function connect(btn) {
    btn.disabled = true;
    const r = await post('connect', { provider: btn.dataset.mcpConnect });
    btn.disabled = false;
    if (!r || !r.ok) say(r && r.error === 'not_installed' ? 'not_installed' : 'failed');
    else say(r.already ? 'already' : 'ok');
  }

  async function revoke(id) {
    await post('revoke', { id });
    renderClients();
  }

  function clientRow(c) {
    const li = el('li', 'settings-memory-item');
    li.appendChild(el('span', 'settings-memory-text', String(c.name || 'MCP')));
    const del = el('button', 'settings-memory-del', '×');
    del.type = 'button';
    del.setAttribute('aria-label', tr('settings_mcp_remove', 'Remove'));
    del.addEventListener('click', () => revoke(c.id));
    li.appendChild(del);
    return li;
  }

  async function renderClients() {
    const list = document.getElementById('settings-mcp-clients');
    if (!list) return;
    let clients;
    try {
      const j = await fetch(BASE + 'clients').then((r) => r.json());
      clients = Array.isArray(j && j.clients) ? j.clients : [];
    } catch { return; /* server away: keep what is shown */ }
    list.replaceChildren(...clients.map(clientRow));
    const empty = document.getElementById('settings-mcp-empty');
    if (empty) empty.hidden = clients.length > 0;
  }

  function initSettings() {
    const card = document.getElementById('settings-mcp-dev');
    if (!card) return;
    card.hidden = false;
    card.querySelectorAll('[data-mcp-connect]').forEach((btn) => btn.addEventListener('click', () => connect(btn)));
    renderClients();
  }

  const parse = (e) => { try { return JSON.parse(e.data); } catch { return null; } };
  function listen(es) {
    es.addEventListener('mcp_dev_pair', (e) => showPair(parse(e)));
    es.addEventListener('mcp_dev_pair_done', (e) => { const d = parse(e); if (d) closePair(d.id); });
    es.addEventListener('mcp_dev_query', (e) => answer(parse(e)));
    es.addEventListener('mcp_dev_clients', () => renderClients());
    // A pairing asked for before this page was open still waits for an answer.
    es.addEventListener('open', () => {
      fetch(BASE + 'pairs').then((r) => r.json()).then((j) => ((j && j.pairs) || []).forEach(showPair)).catch(() => { /* no server yet */ });
      renderClients();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSettings, { once: true });
  else initSettings();

  window.McpDev = Object.freeze({ listen });
})();
