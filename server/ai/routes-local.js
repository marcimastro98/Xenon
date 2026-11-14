// What the engine answers about the AI that runs on this computer: whether it is there,
// fetching a model, installing Whisper.

const aiLocal = require('../ai-local.js');
const { readBody } = require('../http/read-body.js');
const aiModels = require('../ai-models.js');
const { whisperProbe } = require('./whisper-probe.js');
const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /api/ai-local/status': async (_req, res, { json }, { readHubSettings }) => {
    try {
      const settings = await readHubSettings().catch(() => null);
      const baseUrl = aiLocal.sanitizeOllamaUrl(settings && settings.ollamaUrl);
      const status = await aiLocal.localStatus(baseUrl, SERVER_DIR);
      json({ status });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  },

  'POST /api/ai-local/pull': async (req, res, _context, { readHubSettings }) => {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const model = aiLocal.sanitizeModel(body.model);
      const settings = await readHubSettings().catch(() => null);
      // Resolve 'auto' exactly as the chat path does (resolveModel + hardwareScan)
      // so the model we pull is the same one the chat will request — otherwise
      // 'auto' could download qwen2.5:3b while chat asks for qwen2.5:7b → 404.
      // Use the persisted scan, or probe now if the user never ran a manual scan,
      // so the safety gate below always has real hardware figures to reason about.
      let scan = settings && settings.hardwareScan;
      if (!scan || typeof scan !== 'object') { scan = await aiLocal.scanHardware().catch(() => null); }
      const concrete = aiLocal.resolveModel(model, scan);
      // SAFETY GATE — refuse the download (never pull) when the hardware can't run
      // the model. Incompatible machines are blocked outright; otherwise the model
      // must fit either VRAM or RAM. This keeps a weak PC from downloading gigabytes
      // only to crash the GPU on the first inference.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      if (scan && scan.tier === 'incompatible') {
        res.write(`data: ${JSON.stringify({ error: 'Il tuo hardware non è adatto all’AI locale (serve almeno ~8 GB di RAM o ~4 GB di VRAM). Non è stato scaricato nulla: usa Xenon AI in cloud (Gemini).', done: true })}\n\n`);
        return res.end();
      }
      // A model the local table does not know can still be gated, using the
      // requirements the download catalog published for it. The local table wins
      // where it has an entry, and junk figures are dropped rather than trusted
      // (see _sanitizedReq in ai-local.js) — a remote file may raise the bar for
      // a model we never sized, never lower it for one we did.
      const safety = aiLocal.modelSafety(concrete, scan, aiModels.ollamaRequirements(concrete));
      if (!safety.ok) {
        res.write(`data: ${JSON.stringify({ error: safety.reason, done: true })}\n\n`);
        return res.end();
      }
      const baseUrl = aiLocal.sanitizeOllamaUrl(settings && settings.ollamaUrl);
      await aiLocal.pullModel(baseUrl, concrete, (p) => {
        res.write(`data: ${JSON.stringify(p)}\n\n`);
      });
      res.write(`data: ${JSON.stringify({ status: 'success', done: true })}\n\n`);
      res.end();
    } catch (e) {
      try { res.write(`data: ${JSON.stringify({ error: e.message, done: true })}\n\n`); res.end(); }
      catch { res.writeHead(500); res.end(); }
    }
  },

  'POST /api/ai-local/whisper-install': async (req, res, _context, { refreshWakeWordWatch }) => {
    try {
      await readBody(req);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      await aiLocal.installWhisper(SERVER_DIR, (p) => {
        res.write(`data: ${JSON.stringify(p)}\n\n`);
      });
      res.write(`data: ${JSON.stringify({ status: 'success', done: true })}\n\n`);
      res.end();
      // Whisper just became available → drop the negative probe cache and let
      // the wake word start if enabled.
      whisperProbe.lastAt = 0;
      refreshWakeWordWatch();
    } catch (e) {
      try { res.write(`data: ${JSON.stringify({ error: e.message, done: true })}\n\n`); res.end(); }
      catch { res.writeHead(500); res.end(); }
    }
  },
};

module.exports = { branches };
