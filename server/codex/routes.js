// What the engine answers about Codex and the ChatGPT tile: the state and a thread, an event, a
// permission and its decision, the link and its removal, and the conversations of the tile with
// a question asked, cancelled or deleted.

const { readBody } = require('../http/read-body.js');
const { _codexCfg } = require('./widget-config.js');
const codexBridge = require('../codex-bridge.js');
const codexLink = require('../codex-link.js');
const { DATA_DIR } = require('../engine/paths.js');
const chatgptAsk = require('../chatgpt-ask.js');
const { codexState } = require('./tile-state.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /api/codex': async (_req, _res, { json, err500, urlObj }, { _codexApp, _codexPayload, _syncCodexDemand }) => {
    // The Codex tile's whole state: account side from app-server, live side from
    // the hooks, the link, the tile settings. `?refresh` re-reads the account
    // side now (the tile's refresh button), skipping any read still in flight.
    try {
      _syncCodexDemand();
      if (urlObj.searchParams.has('refresh')) {
        await Promise.all(['limits', 'usage', 'threads'].map((k) => _codexApp.refresh(k).catch(() => {})));
      }
      json(_codexPayload());
    } catch (e) { err500(e.message); }
  },

  'GET /api/codex/thread': async (_req, _res, { json, err500, urlObj }, { _codexApp, _codexBridge }) => {
    // One conversation, as the tile shows it when a row is tapped: requests and
    // final answers, cleaned of attachment paths (codex-appserver.js parseTurns).
    // Only a thread Codex listed to us or a session its hooks reported, so this
    // never reads an arbitrary id.
    try {
      const id = String(urlObj.searchParams.get('id') || '');
      if (!/^[0-9A-Za-z-]{8,64}$/.test(id) || !(_codexApp.knowsThread(id) || _codexBridge.hasSession(id))) {
        json({ ok: false, error: 'not_found' });
        return;
      }
      json(await _codexApp.readThread(id));
    } catch (e) { err500(e.message); }
  },

  'POST /api/codex/event': async (req, res, _context, { _codexBridge, _codexBridgeAuth }) => {
    // A lifecycle hook from Codex, through codex-hook.js. 204 and no body, ever:
    // this endpoint has no say in what Codex does.
    if (!_codexBridgeAuth(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
    try { _codexBridge.applyHook(JSON.parse(await readBody(req))); } catch { /* malformed: ignored */ }
    res.writeHead(204); res.end();
  },

  'POST /api/codex/permission': async (req, res, { json }, { _codexBridge, _codexBridgeAuth }) => {
    // The blocking one: Codex waits on this answer. Every path that is not an
    // explicit tap answers `{}`, which codex-hook.js turns into "no decision"
    // and Codex into its own prompt. This endpoint cannot approve on its own.
    if (!_codexBridgeAuth(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
    if (_codexCfg().approvals === false) { req.resume(); json({}); return; }
    try {
      const pendingReq = _codexBridge.requestPermission(JSON.parse(await readBody(req)));
      if (!pendingReq) { json({}); return; }
      // Codex gave up (Ctrl-C, its own timeout) and killed the hook: drop the card.
      const onGone = () => _codexBridge.cancel(pendingReq.id);
      res.on('close', onGone);
      const out = await pendingReq.promise;
      res.off('close', onGone);
      if (res.writableEnded || res.destroyed) return;
      json(codexBridge.toHookOutput(out));
    } catch { try { if (!res.writableEnded && !res.destroyed) json({}); } catch { /* caller gone */ } }
  },

  'POST /api/codex/decide': async (req, _res, { json, err500 }, { _codexBridge }) => {
    // The touchscreen answering a pending Codex request: allow, deny, or
    // handback ("Answer in Codex": no decision, at once).
    try {
      const body = JSON.parse(await readBody(req));
      const behavior = body && ['allow', 'deny', 'handback'].includes(body.behavior) ? body.behavior : '';
      json({ ok: behavior ? _codexBridge.decide(String(body.id || ''), behavior) : false });
    } catch (e) { err500(e.message); }
  },

  'GET /api/codex/link': async (_req, _res, { json, err500, urlObj }, { _codexLinkStatus }) => {
    try { json(await _codexLinkStatus({ fresh: urlObj.searchParams.has('fresh') })); }
    catch (e) { err500(e.message); }
  },

  'POST /api/codex/unlink': async (_req, _res, { json, err500 }, { _codexChanged, _codexLinkStatus }) => {
    try {
      await codexLink.unlink(DATA_DIR);
      const st = await _codexLinkStatus({ fresh: true });
      _codexChanged();
      json({ ok: true, ...st });
    } catch (e) { err500(e.message); }
  },

  'GET /api/chatgpt': async (_req, _res, { json, err500 }, { _chatgptPayload, _chatgptStore }) => {
    // The conversation list and what is answering right now. Program status
    // and models come from /api/ai/cli/status and /api/ai/cli/models.
    try { await _chatgptStore.load(); json(_chatgptPayload(null)); }
    catch (e) { err500(e.message); }
  },

  'GET /api/chatgpt/conversation': async (_req, _res, { json, err500, urlObj }, { _chatgptStore }) => {
    try {
      await _chatgptStore.load();
      const id = String(urlObj.searchParams.get('id') || '');
      const c = chatgptAsk.isId(id) ? _chatgptStore.get(id) : null;
      if (!c) { json({ ok: false, error: 'not_found' }); return; }
      json({ ok: true, conversation: c });
    } catch (e) { err500(e.message); }
  },

  'POST /api/chatgpt/ask': async (req, _res, { json, err500 }, { _chatgptAsker }) => {
    // Answers at once with the conversation id; the reply arrives over SSE.
    try {
      const body = JSON.parse(await readBody(req));
      json(await _chatgptAsker.ask({ conversationId: body && body.conversationId, text: body && body.text }));
    } catch (e) { err500(e.message); }
  },

  'POST /api/chatgpt/cancel': async (req, _res, { json, err500 }, { _chatgptAsker }) => {
    try {
      const body = JSON.parse(await readBody(req));
      const id = String(body && body.conversationId || '');
      json({ ok: chatgptAsk.isId(id) && _chatgptAsker.cancel(id) });
    } catch (e) { err500(e.message); }
  },

  'POST /api/chatgpt/delete': async (req, _res, { json, err500 }, { _chatgptAsker }) => {
    try {
      const body = JSON.parse(await readBody(req));
      if (body && body.all === true) { await _chatgptAsker.clear(); json({ ok: true }); return; }
      const id = String(body && body.id || '');
      json({ ok: chatgptAsk.isId(id) && await _chatgptAsker.remove(id) });
    } catch (e) { err500(e.message); }
  },

  'POST /api/codex/link': async (_req, _res, { json, err500 }, { PORT, _codexChanged, _codexLinkStatus }) => {
    // Writes Xenon's hooks into the user's Codex hooks.json (backed up first,
    // their own hooks kept in place). Codex runs them only after the user trusts
    // them in /hooks; the answer says whether it has, when Codex can tell us.
    try {
      const st = await codexLink.link(DATA_DIR, PORT);
      codexState.bridgeToken = await codexLink.ensureToken(DATA_DIR, PORT);
      if (st.error) { json({ ok: false, ...st }); return; }
      const fresh = await _codexLinkStatus({ fresh: true });
      _codexChanged();
      json({ ok: true, ...fresh });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
