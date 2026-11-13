// What the engine answers about the assistant: a turn and its stop, the command line
// assistants, the local models, the balance, an action on the PC and the chime.

const { readBody, readBodyBuffer } = require('../http/read-body.js');
const aiTurns = require('../ai-turns.js');
const { _pcControlEnabled } = require('./pc-control-switch.js');
const { _pcActions, PC_ACTION_TTL_MS, PC_ACTION_TIMEOUT_MS } = require('./pc-actions.js');
const { execFile } = require('node:child_process');
const aiCli = require('../ai-cli.js');
const aiXenon = require('../ai-xenon-credits.js');
const { DATA_DIR } = require('../engine/paths.js');
const aiLocal = require('../ai-local.js');
const { chimeRequested } = require('./chime-play.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'POST /api/ai/turn/stop': async (req, _res, { json }) => {
    // The chat's stop button. Only stops: the turn ends at its next tool or
    // round (ai-turns.js), and whoever holds the random id is the chat that sent it.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json({ ok: aiTurns.stop(body.id) });
    } catch { json({ ok: false }); }
  },

  'GET /api/ai/turn': async (_req, _res, { json, urlObj }) => {
    // How far a running AI turn has got, or its answer once sent (ai-turns.js).
    json(aiTurns.status(urlObj.searchParams.get('id')));
  },

  'POST /ai/pc-run': async (req, _res, { json, err500 }) => {
    // Execute a PREVIOUSLY-PROPOSED, user-approved PC command. The command text
    // is looked up by nonce server-side (never taken from the request body), and
    // the feature flag is re-checked here — so this endpoint can only run
    // something the AI proposed AND the user confirmed on the card, and only
    // while PC Control is enabled.
    try {
      const { nonce } = JSON.parse(await readBody(req) || '{}');
      if (!_pcControlEnabled()) { json({ ok: false, error: 'pc_control_disabled' }); return; }
      const entry = nonce && _pcActions.get(String(nonce));
      if (!entry) { json({ ok: false, error: 'expired' }); return; }
      _pcActions.delete(String(nonce)); // single-use
      if (Date.now() - entry.ts > PC_ACTION_TTL_MS) { json({ ok: false, error: 'expired' }); return; }
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', entry.command],
        { timeout: PC_ACTION_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
        (e, stdout, stderr) => {
          const clip = (s) => String(s || '').slice(0, 4000);
          if (e && e.killed) { json({ ok: false, error: 'timeout', stdout: clip(stdout), stderr: clip(stderr) }); return; }
          json({ ok: !e, code: (e && typeof e.code === 'number') ? e.code : 0, stdout: clip(stdout), stderr: clip(stderr), errorMessage: (e && typeof e.code !== 'number') ? e.message : undefined });
        });
    } catch (e) { err500(e.message); }
  },

  'POST /ai/pc-cancel': async (req, _res, { json, err500 }) => {
    // Drop a pending proposal when the user declines the confirmation card.
    try {
      const { nonce } = JSON.parse(await readBody(req) || '{}');
      if (nonce) _pcActions.delete(String(nonce));
      json({ ok: true });
    } catch (e) { err500(e.message); }
  },

  'POST /api/ai/cli/mcp': async (req, res) => {
    // Xenon's tools for a Claude Code / Codex turn, asked for by the MCP bridge
    // (ai-mcp-bridge.js) that the program started. The token names one live
    // turn and dies with it; ai-cli.js refuses everything else, and each call
    // runs through executeAiTool exactly as it does for the other providers.
    try {
      const raw = await readBodyBuffer(req, 256 * 1024);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const out = await aiCli.handleMcp(String(req.headers['x-xenon-mcp-token'] || ''), body);
      res.writeHead(out.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out.body));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_request' }));
    }
  },

  'GET /api/ai/xenon/balance': async (_req, _res, { json }) => {
    // Xenon credits left on this PC's supporter pass, for Settings. Numbers only:
    // the pass and the hub's session token never leave this server.
    json(await aiXenon.balance(DATA_DIR));
  },

  'GET /api/ai/cli/status': async (_req, _res, { json, urlObj }) => {
    // Claude Code / Codex: is the program there, and is the user signed in to
    // it. Asked by Settings; `fresh=1` skips the 30s cache so the answer
    // changes as soon as the user has signed in.
    const provider = aiLocal.sanitizeProvider(urlObj.searchParams.get('provider'));
    if (!aiCli.isCliProvider(provider)) { json({ ok: false, error: 'bad_provider' }); return; }
    try { json(Object.assign({ ok: true }, await aiCli.status(provider, { fresh: urlObj.searchParams.get('fresh') === '1' }))); }
    catch (e) { json({ ok: false, error: 'status_failed' }); }
  },

  'GET /api/ai/cli/models': async (_req, _res, { json, urlObj }) => {
    // The models the program itself offers this account today: Claude Code's
    // own list (its `initialize` answer, what its /model picker shows), Codex's
    // own catalog (`codex debug models`). `fresh=1` when Settings opens, so the
    // picker is never older than the program.
    const provider = aiLocal.sanitizeProvider(urlObj.searchParams.get('provider'));
    if (!aiCli.isCliProvider(provider)) { json({ ok: false, error: 'bad_provider' }); return; }
    try { json({ ok: true, provider, models: await aiCli.models(provider, { fresh: urlObj.searchParams.get('fresh') === '1' }) }); }
    catch (e) { json({ ok: true, provider, models: [] }); }
  },

  'GET /api/ai-local/ollama-autostart': async (_req, res, { json }) => {
    try {
      const enabled = await aiLocal.getOllamaAutostart();
      json({ enabled, supported: aiLocal.ollamaAutostartSupported() });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  },

  'POST /api/ai-local/ollama-autostart': async (req, res, { json }) => {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const result = await aiLocal.setOllamaAutostart(body.enabled === true);
      json(result);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  },

  'POST /api/chime': async (req, res) => {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      chimeRequested(b.kind);
    } catch {}
    res.writeHead(204); res.end();
  },
};

module.exports = { branches };
