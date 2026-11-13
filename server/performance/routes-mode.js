// What the engine answers about Performance Mode: its numbers, the power plan, Core Shield, its
// saved state, the plan the assistant proposes, the recent processes, and one of its actions
// run.

const { processesWanted } = require('./feeds-wanted.js');
const { readBody } = require('../http/read-body.js');
const perfScreen = require('../perf-screen.js');
const aiLocal = require('../ai-local.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /api/processes/history': async (_req, _res, { json }, { _processesHistory }) => {
    // The recent `processes` readings, as ages rather than clock times (the
    // reader may be a paired phone with its own clock). A pure read of what the
    // SSE stream already carried, so it widens nothing on the paired-device
    // door; empty when no package holds the grant, exactly like the stream.
    json({ ok: true, items: processesWanted() ? _processesHistory.toWire() : [] });
  },

  'GET /api/performance/stats': async (_req, _res, { json }, { perfStats }) => {
    // Read-only system snapshot for Performance Mode: memory pressure + the top
    // processes by RAM with a CPU% estimate. Feeds the optimization sheet (per-app
    // memory chips), the deterministic preselect, and the AI planner.
    try   { json(await perfStats()); }
    catch (e) { json({ ok: false, error: e.message }); }
  },

  'GET /api/performance/powerplan': async (_req, _res, { json }, { perfSession }) => {
    // Performance Mode: read the active Windows power scheme so the client can
    // remember it before switching, then restore it on exit. Fully reversible.
    try   { json(perfSession.plan ? await perfSession.plan.get() : { ok: false, error: 'unsupported_platform' }); }
    catch (e) { json({ ok: false, error: e.message }); }
  },

  'POST /api/performance/powerplan': async (req, res, { json }, { perfSession }) => {
    // Switch to a known high-performance plan ('high'/'ultimate') or restore a
    // previously-saved scheme by GUID. Anything else is rejected here and in power-plan.js.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const value = String(body.value || '').trim();
      const isPreset = value === 'high' || value === 'ultimate';
      const isGuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
      if (!isPreset && !isGuid) { res.writeHead(400); res.end('Invalid power plan'); return; }
      json(perfSession.plan ? await perfSession.plan.set(value) : { ok: false, error: 'unsupported_platform' });
    } catch (e) { json({ ok: false, error: e.message }); }
  },

  'GET /api/performance/shield': async (_req, _res, { json }, { perfSession }) => {
    // Read-only: whether Core Shield can run on this PC, for the sheet and Settings,
    // and which apps it moved this session, for the note at the end.
    try   { json({ ok: true, ...(await perfSession.shield.status()) }); }
    catch (e) { json({ ok: false, error: e.message }); }
  },

  'POST /api/performance/state': async (req, res, { json, err500 }, { updatePerformanceSetting }) => {
    // The driver page's save of the `performance` block (an optimize session
    // started or ended with no dashboard). Nothing else in the settings moves.
    let perf = null;
    try { perf = perfScreen.stateFrom(JSON.parse(await readBody(req) || '{}')); } catch (e) { perf = null; }
    if (!perf) { res.writeHead(400); res.end('Invalid performance settings'); return; }
    try {
      const saved = await updatePerformanceSetting(perf);
      json({ ok: true, rev: saved.rev });
    } catch (e) { err500(e.message); }
  },

  'POST /api/performance/plan': async (req, _res, { json }, { _aiPerformancePlan, perfStats, readHubSettings }) => {
    // AI planner for Performance Mode: returns { explanation, closeApps } curated
    // for the current activity, or { ok:false } so the client falls back to the
    // deterministic flow. The AI only picks among the open apps it's given.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const settings = (await readHubSettings().catch(() => null)) || {};
      const provider = aiLocal.sanitizeProvider(body.provider);
      const opts = (body.opts && typeof body.opts === 'object') ? body.opts : {};
      // Measure here (server-side) so the plan reasons on real RAM/CPU numbers;
      // a failed probe degrades to the old name-only prompt.
      const stats = await perfStats().catch(() => null);
      const plan = await _aiPerformancePlan({
        activity: String(body.activity || 'other'),
        appNames: Array.isArray(body.apps) ? body.apps : [],
        opts,
        provider,
        key: String(body.key || settings.geminiApiKey || '').trim(),
        model: aiLocal.sanitizeModel(body.model || settings.ollamaModel),
        ollamaUrl: body.ollamaUrl || settings.ollamaUrl,
        hardwareScan: settings.hardwareScan,
        lang: String(body.lang || 'en'),
        stats: (stats && stats.ok) ? stats : null,
      });
      if (!plan) { json({ ok: false }); return; }
      json({ ok: true, plan });
    } catch (e) { json({ ok: false, error: e.message }); }
  },

  'POST /actions/perf': async (req, _res, { json, err500 }, { perfRegistry }) => {
    // Performance Mode system actions (guided app close/relaunch). Allowlisted
    // and validated inside perfRegistry — never an arbitrary command.
    try {
      const action = JSON.parse(await readBody(req) || '{}');
      json(await perfRegistry.run(action));
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
