// What the engine does while a Claude Code session talks to it: an event from the session, its
// messages, a permission it asks for, a question, the end of a turn, the commands of the
// session, and the answer, reply or decision the user gives.

const { readBody } = require('../http/read-body.js');
const { hub } = require('../settings/current.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /api/claude/event': async (req, res, _context, { _claudeBridge, _claudeBridgeAuth }) => {
    // Ingest from Claude Code: the statusline payload (X-Xenon-Source: statusline)
    // or a non-blocking lifecycle hook. Answers 204 with NO body on purpose — a
    // hook response body is parsed as a decision, and this endpoint must never
    // accidentally influence what Claude Code does.
    if (!_claudeBridgeAuth(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
    try {
      const data = JSON.parse(await readBody(req));
      if (String(req.headers['x-xenon-source'] || '') === 'statusline') _claudeBridge.applyStatus(data);
      else _claudeBridge.applyHook(data);
    } catch { /* a malformed event must never fail the caller's tool call */ }
    res.writeHead(204); res.end();
  },

  'POST /api/claude/mod': async (req, res, { json }, { _claudeBridge, _claudeBridgeAuth, _claudeModReply }) => {
    // The Xenon mod for Claude Code (integrations/claude-code/): its feed of
    // subagent models, context and quota. Same token as the hooks. Unlike a
    // hook, the mod reads this body, so it may answer; nothing in it acts on
    // Claude Code.
    if (!_claudeBridgeAuth(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
    let accepted = false;
    let needCommands = false;
    try {
      const body = JSON.parse(await readBody(req));
      accepted = _claudeBridge.applyMod(body);
      // This server restarted since the mod last sent its command list, and the
      // mod only resends a list that changed: ask for it, or the tile's "/" is empty.
      needCommands = accepted && body.kind === 'hello' && _claudeBridge.wantsCommandList(body.sessionId);
    } catch { /* malformed: answered as not accepted */ }
    json({ ..._claudeModReply(), accepted, needCommands });
  },

  'GET /api/claude/mod': async (req, res, { json }, { _claudeBridgeAuth, _claudeModReply }) => {
    // The mod's /xenon command: does the hub hear this install at all.
    if (!_claudeBridgeAuth(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
    json(_claudeModReply());
  },

  'POST /api/claude/mod/permission': async (req, res, { json }, { _claudeBridgeAuth, _claudeHoldPermission }) => {
    // The mod's approvals: the same card as /api/claude/permission, held only
    // for the short wait the user chose in the mod (10-120 s). The mod runs
    // before Claude Code's own PermissionRequest hook, so an explicit tap here
    // settles the call and the hook never fires; anything else answers
    // { decision: null } and the mod lets Claude Code go on, which reaches the
    // hook, which takeHandBack turns into the terminal prompt. Like the hook
    // route, it can never approve on its own. The mod sends only the one field
    // the card shows (command, path, URL…), never file content or a prompt.
    if (!_claudeBridgeAuth(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
    if (hub.settings && hub.settings.claudeWidget
      && hub.settings.claudeWidget.approvals === false) {
      req.resume();
      json({ decision: null });
      return;
    }
    try {
      const body = JSON.parse(await readBody(req));
      const data = body && body.v === 1 && typeof body.sessionId === 'string' ? {
        session_id: body.sessionId,
        tool_name: body.tool,
        tool_input: body.input,
        cwd: body.cwd,
      } : null;
      if (!data || data.tool_name === 'AskUserQuestion' || data.tool_name === 'ExitPlanMode') { json({ decision: null }); return; }
      const ttlMs = Math.max(10, Math.min(120, Number(body.waitSec) || 30)) * 1000;
      const decision = await _claudeHoldPermission(res, data, { ttlMs, fromMod: true });
      if (res.writableEnded || res.destroyed) return;
      json({ decision });
    } catch { try { if (!res.writableEnded && !res.destroyed) json({ decision: null }); } catch { /* caller already gone */ } }
  },

  'POST /api/claude/mod/inbox': async (req, res, _context, { _claudeBridgeAuth, _claudeInbox }) => {
    // The mod (0.3.0+) asking, from a timer in an interactive session, whether
    // the tile has a message for it. Held open until one is queued or the hold
    // runs out (claude-inbox.js), and a session with a request held here is
    // what the tile offers "goes into the open session" for. The answer is
    // { text } or {}: only an idle session is handed anything, and only once
    // (claude-bridge.js, takeForTerminal). The text is never logged.
    if (!_claudeBridgeAuth(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
    let sessionId = '';
    try {
      const body = JSON.parse(await readBody(req, 4096));
      if (body && body.v === 1 && typeof body.sessionId === 'string') sessionId = body.sessionId;
    } catch { /* malformed: refused below as a bad session */ }
    if (res.writableEnded || res.destroyed) return;
    const held = _claudeInbox.hold(sessionId, res);
    if (held === 'bad_session') { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Bad session'); }
    else if (held === 'busy') { res.writeHead(429, { 'Content-Type': 'text/plain' }); res.end('Busy'); }
  },

  'POST /api/claude/question': async (req, res, { json }, { _claudeBridge, _claudeBridgeAuth }) => {
    // A question from Claude, answered on the touchscreen.
    //
    // This is a PreToolUse hook scoped to AskUserQuestion, and it blocks the
    // same way the permission route does. The answer is returned as an ALLOW
    // whose updatedInput is the tool's own input with `answers` filled in, so
    // the tool runs and hands Claude the choice as its normal result — what the
    // terminal would have produced (claude-bridge.js, header note 2).
    //
    // Every non-answer path is an empty object: the tool then runs and asks in
    // the terminal, exactly as it would if Xenon were not installed. Nothing
    // here can invent a choice the user did not make.
    if (!_claudeBridgeAuth(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
    if (hub.settings && hub.settings.claudeWidget
      && hub.settings.claudeWidget.questions === false) {
      req.resume();
      json({});
      return;
    }
    try {
      const data = JSON.parse(await readBody(req));
      const ask = _claudeBridge.askQuestion(data);
      if (!ask) { json({}); return; }               // unreadable, or too many waiting
      const onGone = () => _claudeBridge.cancel(ask.id);
      res.on('close', onGone);
      const out = await ask.promise;
      res.off('close', onGone);
      if (res.writableEnded || res.destroyed) return;
      if (out.verdict === 'answer' && out.updatedInput) {
        // For an allow the reason is shown to the user, not to Claude: it is
        // the line in the terminal that says where the answer came from.
        json({ hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'allow',
          permissionDecisionReason: 'Answered on the Xenon dashboard',
          updatedInput: out.updatedInput,
        } });
      } else {
        json({});                                    // skipped or timed out → the terminal asks
      }
    } catch { try { if (!res.writableEnded && !res.destroyed) json({}); } catch { /* caller already gone */ } }
  },

  'POST /api/claude/turn-end': async (req, res, { json }, { _claudeBridge, _claudeBridgeAuth, _claudeInbox }) => {
    // The Stop hook, and the ONE ingest endpoint allowed to answer with a
    // decision. /api/claude/event stays inert (204, no body) precisely so that
    // the ability to influence a session lives in one named place instead of
    // being a property any lifecycle event might quietly acquire.
    //
    // What it does: records the end of the turn like any other event, then, if
    // the user typed a follow-up on the dashboard while Claude was working,
    // hands it over as { decision: 'block', reason }. Claude does not stop — the
    // text arrives as a new instruction in the SAME session. With nothing
    // queued it answers {} and the turn ends normally, which is also the loop
    // guard: takeFollowUp() clears the queue, so a second Stop finds it empty.
    if (!_claudeBridgeAuth(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
    try {
      const data = JSON.parse(await readBody(req));
      _claudeBridge.applyHook(data);
      const sid = String(data && data.session_id || '');
      const reason = _claudeBridge.takeFollowUp(sid);
      json(reason ? { decision: 'block', reason } : {});
      // A command typed on the tile during the turn waits for the terminal: hand
      // it to the mod's parked request now, not when that request times out.
      if (!reason && sid) setImmediate(() => { try { _claudeInbox.wake(sid); } catch { /* next ask takes it */ } });
    } catch { try { if (!res.writableEnded && !res.destroyed) json({}); } catch { /* caller already gone */ } }
  },

  'POST /api/claude/answer': async (req, _res, { json, err500 }, { _claudeBridge }) => {
    // The touchscreen answering a question. Browser-originated, so CSRF-guarded
    // rather than token-gated, like /decide. `selections` is one array of option
    // labels per question; the bridge matches them against the options Claude
    // itself published and refuses anything else. `typed` is one string per
    // question: the "Other" box, or a text/number answer — the user's own words,
    // as the terminal's "Other" row would send them.
    try {
      const body = JSON.parse(await readBody(req));
      const id = String(body && body.id || '');
      const ok = body && body.skip === true
        ? _claudeBridge.skipQuestion(id)
        : _claudeBridge.answer(id,
          Array.isArray(body && body.selections) ? body.selections : [],
          Array.isArray(body && body.typed) ? body.typed : []);
      json({ ok });
    } catch (e) { err500(e.message); }
  },

  'POST /api/claude/reply': async (req, _res, { json, err500 }, { _claudeBridge, _claudeInbox }) => {
    // A follow-up typed on the dashboard for a live session. It is QUEUED, not
    // sent, and the tile shows that state, because "sent" would be a lie until
    // it arrives. Two delivery points (claude-bridge.js, queueFollowUp): the end
    // of the running turn, via /api/claude/turn-end, or, for an idle session
    // whose mod is listening, the mod, woken here so it arrives at once.
    //
    // An idle session with no mod listening will never fire Stop again, so
    // nothing here could deliver it: it is refused (session_idle), and the tile
    // offers a resume run instead, the same conversation continued as a run.
    try {
      const body = JSON.parse(await readBody(req));
      const sessionId = String(body && body.sessionId || '');
      if (body && body.cancel === true) { json({ ok: _claudeBridge.cancelFollowUp(sessionId) }); return; }
      const out = _claudeBridge.queueFollowUp(sessionId, String(body && body.text || ''));
      if (out.ok && out.via === 'terminal') _claudeInbox.wake(sessionId);
      json(out);
    } catch (e) { err500(e.message); }
  },

  'POST /api/claude/decide': async (req, _res, { json, err500 }, { _claudeBridge }) => {
    // The touchscreen answering a pending request. Browser-originated, so it is
    // CSRF-guarded rather than token-gated.
    try {
      const body = JSON.parse(await readBody(req));
      // mode/feedback only mean something for a plan card; the bridge ignores
      // them for any other request.
      const ok = _claudeBridge.decide(String(body && body.id || ''), body && body.behavior === 'allow' ? 'allow' : 'deny', {
        mode: typeof (body && body.mode) === 'string' ? body.mode : '',
        feedback: typeof (body && body.feedback) === 'string' ? body.feedback : '',
      });
      // ok:false means the request already expired or was answered on another
      // surface — the widget tells the user rather than silently doing nothing.
      json({ ok });
    } catch (e) { err500(e.message); }
  },

  'GET /api/claude/session-commands': async (_req, _res, { json, err500, urlObj }, { _claudeBridge }) => {
    // The slash commands an OPEN session lists (its mod reports the terminal's
    // own typeahead), for the tile's "/" list. Names and one line each; null
    // when that session's mod is too old to report them.
    try { json({ commands: _claudeBridge.commandListFor(urlObj.searchParams.get('session') || '') }); }
    catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
