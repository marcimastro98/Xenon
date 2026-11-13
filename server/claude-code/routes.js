// What the engine answers about a Claude Code session: its transcript, a picture from it, an
// agent and the plan.

const claudeTranscript = require('../claude-transcript.js');
const claudeUsage = require('../claude-usage.js');
const claudeSubagent = require('../claude-subagent.js');
const { claudeState } = require('./tile-state.js');
const { hub } = require('../settings/current.js');
const { readBody } = require('../http/read-body.js');
const claudeLink = require('../claude-link.js');
const { DATA_DIR } = require('../engine/paths.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /api/claude/transcript': async (_req, _res, { json, err500, urlObj }) => {
    // The last turns of one session, so a follow-up is not written blind. Pure
    // read, and the session id is matched against a strict shape before it is
    // ever used to look for a file.
    try {
      const out = await claudeTranscript.readTail(
        claudeUsage.resolveProjectsDir(),
        urlObj.searchParams.get('session') || '',
        { full: urlObj.searchParams.get('full') === '1' });
      json(out);
    } catch (e) { err500(e.message); }
  },

  'GET /api/claude/transcript-image': async (_req, res, { err500, urlObj }) => {
    // One picture from a session's thread, named by the id the transcript reply
    // gave it. The session id is matched against a strict shape and the image id
    // is two numbers; the answer is an allowlisted image type, never a path or HTML.
    try {
      const out = await claudeTranscript.readImage(claudeUsage.resolveProjectsDir(),
        urlObj.searchParams.get('session') || '', urlObj.searchParams.get('id') || '');
      if (!out.ok) { res.writeHead(out.error === 'bad_request' ? 400 : 404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': out.mime,
        'Content-Length': out.data.length,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=3600',
      });
      res.end(out.data);
    } catch (e) { err500(e.message); }
  },

  'GET /api/claude/agent': async (_req, _res, { json, err500, urlObj }) => {
    // One subagent of a session, read from Claude Code's own files: type, label,
    // model, effort, context size and its last tool calls. Ids only, both
    // shape-checked before a path is built; never its prompt or tool results.
    try {
      const out = await claudeSubagent.readAgent(claudeUsage.resolveProjectsDir(),
        urlObj.searchParams.get('session') || '', urlObj.searchParams.get('id') || '');
      json(out);
    } catch (e) { err500(e.message); }
  },

  'GET /api/claude/plan': async (_req, _res, { json, err500, urlObj }) => {
    // The last plan a session wrote, read back from its transcript: the Plan tab
    // asks once when the live feed has none (Xenon started after the plan).
    try {
      json(await claudeTranscript.lastPlan(claudeUsage.resolveProjectsDir(), urlObj.searchParams.get('session') || ''));
    } catch (e) { err500(e.message); }
  },

  'GET /api/claude': async (_req, _res, { json, err500, urlObj }, { _claudeFresh, refreshClaude }) => {
    // Local Claude Code usage aggregate + the budget config the reactor renders.
    // No key, no network — reads ~/.claude transcripts. Ensures the cache is warm
    // (the widget can be opened before any SSE-gated refresh has run).
    try {
      if (urlObj.searchParams.has('refresh') || !claudeState.cache.data) await refreshClaude();
      // Widget just (re)added after a gated-idle stretch: serve the cache now,
      // catch up in background; the SSE push repaints when it lands.
      else if (Date.now() - claudeState.cache.refreshedAt > 5 * 60 * 1000) refreshClaude().catch(() => {});
      json(_claudeFresh());        // never the cached `live` block — see _claudeFresh
    } catch (e) { err500(e.message); }
  },

  'POST /api/claude/permission': async (req, res, { json }, { _claudeBridge, _claudeBridgeAuth, _claudeHoldPermission }) => {
    // The blocking one. Claude Code holds its tool call open while this request
    // is unanswered, so the user can decide on the Xeneon Edge instead of at the
    // keyboard. Every path that is not an explicit tap answers 2xx with an EMPTY
    // object, which means "no decision" and hands the prompt back to Claude
    // Code's own terminal UI — this endpoint can never auto-approve anything.
    if (!_claudeBridgeAuth(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
    // Approval cards switched off in Settings → answer immediately with "no
    // decision". Refusing to QUEUE the request is the whole point: leaving it
    // pending would block the session for the full approval window waiting on a
    // card that is never drawn, which is worse than the prompt the user asked
    // not to see. Same empty answer as a timeout, so the terminal asks instead.
    if (hub.settings && hub.settings.claudeWidget
      && hub.settings.claudeWidget.approvals === false) {
      req.resume();                                  // drain the body we won't read
      json({});
      return;
    }
    try {
      const data = JSON.parse(await readBody(req));
      // AskUserQuestion no longer arrives here: it is intercepted earlier, on
      // PreToolUse, by /api/claude/question — which is the only point at which
      // an answer from the touchscreen can still spare the user the terminal.
      // If one reaches this route anyway (an older link, a hand-edited config),
      // it gets no decision, which is the tool proceeding to ask normally.
      if (data && data.tool_name === 'AskUserQuestion') { json({}); return; }
      // The mod already asked about this call and its wait ran out: the
      // terminal asks now, not a second card (claude-bridge.js, takeHandBack).
      if (_claudeBridge.takeHandBack(data)) { json({}); return; }
      // Whether the plan card offers auto mode depends on it (claude-bridge.js,
      // planChoices). One small read, only for a plan.
      if (data && data.tool_name === 'ExitPlanMode') {
        claudeState.defaultMode = await claudeLink.defaultMode().catch(() => '');
      }
      const decision = await _claudeHoldPermission(res, data);
      if (res.writableEnded || res.destroyed) return;
      json(decision ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } } : {});
    } catch { try { if (!res.writableEnded && !res.destroyed) json({}); } catch { /* caller already gone */ } }
  },

  'POST /api/claude/link': async (_req, _res, { json, err500 }, { PORT }) => {
    // Writes the hub's hooks + statusline into the user's Claude Code
    // settings.json (backed up first, existing statusline chained, not lost).
    try {
      const st = await claudeLink.link(DATA_DIR, PORT);
      claudeState.bridgeToken = await claudeLink.ensureToken(DATA_DIR);
      json({ ok: true, ...st });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
