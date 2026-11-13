// What the engine answers about Claude Code on this PC: the link and its removal, the projects,
// the commands, the history, a file attached, a run and its stop, a folder a run may start in,
// and the budget.

const { withHubSettingsLock } = require('../settings/write-lock.js');
const { readBody, readBodyBuffer } = require('../http/read-body.js');
const claudeUsage = require('../claude-usage.js');
const { hub } = require('../settings/current.js');
const claudeLink = require('../claude-link.js');
const { DATA_DIR } = require('../engine/paths.js');
const claudeRun = require('../claude-run.js');
const claudeAttach = require('../claude-attach.js');
const path = require('node:path');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /api/claude/budget': async (req, _res, { json, err500 }, { readHubSettingsForUpdate, refreshClaude, writeHubSettings }) => {
    // Widget-owned: set the plan / weekly token budget the reactor gauges against
    // (there is no official quota API, so the user picks the ceiling). Persisted in
    // settings.claude via the atomic writer, then a refresh repaints the reactor.
    try {
      await withHubSettingsLock(async () => {          // serialized with every other settings writer
      const body = JSON.parse(await readBody(req));
      const cur = await readHubSettingsForUpdate();
      const patch = { ...(cur.claude && typeof cur.claude === 'object' ? cur.claude : {}) };
      if (body.plan !== undefined) patch.plan = body.plan;
      if (body.weeklyTokenBudget !== undefined) patch.weeklyTokenBudget = body.weeklyTokenBudget;
      const merged = claudeUsage.normalizeClaude(patch);
      const saved = await writeHubSettings({ ...cur, claude: merged });
      hub.settings = saved;
      refreshClaude().catch(() => {});
      json({ ok: true, budget: { weekly: claudeUsage.effectiveWeeklyBudget(saved.claude), plan: saved.claude.plan, weeklyTokenBudget: saved.claude.weeklyTokenBudget }, tile: saved.claude.tile });
      });
    } catch (e) { err500(e.message); }
  },

  'GET /api/claude/link': async (_req, _res, { json, err500 }, { _claudeLinkStatus }) => {
    try { json(await _claudeLinkStatus()); }
    catch (e) { err500(e.message); }
  },

  'POST /api/claude/unlink': async (_req, _res, { json, err500 }, { PORT }) => {
    try { json({ ok: true, ...(await claudeLink.unlink(DATA_DIR, PORT)) }); }
    catch (e) { err500(e.message); }
  },

  'GET /api/claude/projects': async (_req, _res, { json, err500, urlObj }, { _claudeRunner }) => {
    // The places the dashboard is allowed to start work in: read out of Claude
    // Code's own transcripts, so it is exactly the set of projects the user
    // already works in. The client picks one by id — it never sends a path.
    try {
      const list = await _claudeRunner.listProjects(urlObj.searchParams.has('refresh'));
      // What this Claude Code accepts for a run (permission modes, effort), so
      // the prompt box offers only what will take effect.
      const options = await claudeRun.cliOptions();
      json({ projects: list.map(p => ({ id: p.id, name: p.name, path: p.path })), options });
    } catch (e) { err500(e.message); }
  },

  'GET /api/claude/commands': async (_req, _res, { json, err500, urlObj }, { _claudeCommands }) => {
    // Names and one-line descriptions only, for the prompt box's "/" picker.
    try { json({ commands: await _claudeCommands.list(urlObj.searchParams.get('project') || '') }); }
    catch (e) { err500(e.message); }
  },

  'GET /api/claude/history': async (_req, _res, { json, err500 }, { _claudeHistory }) => {
    // Every chat Claude Code keeps on this PC: id, title, project name, size,
    // last activity. Read only when the tile's Chats face asks.
    try { json(await _claudeHistory.list()); }
    catch (e) { err500(e.message); }
  },

  'POST /api/claude/history/delete': async (req, _res, { json, err500 }, { _claudeHistory }) => {
    // Session ids only; the module resolves them against its own listing and
    // sends the files to the Recycle Bin/Trash.
    try {
      const body = JSON.parse(await readBody(req));
      json(await _claudeHistory.remove(body && body.ids));
    } catch (e) { err500(e.message); }
  },

  'POST /api/claude/attach': async (req, _res, { json, err500, urlObj }, { _claudeAttach }) => {
    // One file, raw bytes, with the browser's filename in the query string as a
    // LABEL: the module validates its extension and builds the name that lands
    // on disk, so nothing the page sends is ever used as a path component.
    try {
      const data = await readBodyBuffer(req, claudeAttach.MAX_BYTES);
      json(await _claudeAttach.save(urlObj.searchParams.get('name') || '', data));
    } catch (e) { err500(e.message); }
  },

  'POST /api/claude/run': async (req, _res, { json, err500 }, { _claudeBridge, _claudeRunner }) => {
    // Starts a Claude Code run from the touchscreen. Browser-originated, so it
    // is CSRF-guarded like /decide. The runner refuses anything it cannot vouch
    // for (unknown project, malformed session/model, empty prompt) and never
    // takes a filesystem path from this body.
    try {
      const body = JSON.parse(await readBody(req));
      const resume = String(body && body.resume || '');
      let projectId = String(body && body.projectId || '');
      // Continuing a session: the folder is the session's own, so resolve it
      // here from the live bridge rather than trusting the client to have
      // matched it. The client only ever saw the folder's NAME, which is not
      // unique — two checkouts can both be called `xenon`, and a session Xenon
      // learned about late has no name at all. Matching on the real path picks
      // the right project or none.
      if (resume) {
        const cwd = _claudeBridge.cwdFor(resume);
        if (cwd) {
          const want = path.resolve(cwd).toLowerCase();
          const hit = (await _claudeRunner.listProjects(false))
            .find(p => path.resolve(p.path).toLowerCase() === want);
          if (hit) projectId = hit.id;
        }
      }
      const out = await _claudeRunner.start({
        projectId,
        prompt: String(body && body.prompt || ''),
        model: String(body && body.model || ''),
        mode: String(body && body.mode || ''),
        effort: String(body && body.effort || ''),
        resume,
      });
      json(out);
    } catch (e) { err500(e.message); }
  },

  'POST /api/claude/folder': async (req, _res, { json, err500 }, { _claudeRunner }) => {
    // Adds a folder to the places a run may start in. The only route that takes
    // a path for this: it is validated and stored, never run, and a paired
    // device cannot reach it (REMOTE_ADMIN).
    try {
      const body = JSON.parse(await readBody(req));
      json(await _claudeRunner.addFolder(body && body.path));
    } catch (e) { err500(e.message); }
  },

  'POST /api/claude/run/stop': async (req, _res, { json, err500 }, { _claudeRunner }) => {
    try {
      const body = JSON.parse(await readBody(req));
      json({ ok: _claudeRunner.stop(String(body && body.id || '')) });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
