// What the engine answers about the disks: the state of a scan and its overview, a folder
// revealed or browsed, a scan and a cleanup with their cancels, the advice of the assistant,
// the reads and writes per disk, and the space developer tools hold with its cleanup.

const { _sdkStreamGranted } = require('../widget-sdk/grants.js');
const { macDiskAccess } = require('../search/mac-disk-access.js');
const { readBody } = require('../http/read-body.js');
const aiLocal = require('../ai-local.js');
const { aiLangName } = require('../ai/prompt-language.js');
const { localServerOneShot } = require('../ai/local-server-one-shot.js');
const aiOpenai = require('../ai-openai.js');
const aiAnthropic = require('../ai-anthropic.js');
const { providerModelFor } = require('../ai/provider-models.js');
const aiXenon = require('../ai-xenon-credits.js');
const { DATA_DIR } = require('../engine/paths.js');
const aiCli = require('../ai-cli.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /api/disks/io': async (_req, _res, { json }, { getDiskIo }) => {
    // Per-disk throughput and IOPS, for the SDK's `diskIo` stream. A read, and
    // a costed one — it is pulled by a widget that is on screen asking, never
    // polled by the server.
    try   { json(await getDiskIo()); }
    catch (e) { json({ ok: false, disks: [], error: String((e && e.message) || e) }); }
  },

  'GET /api/devstorage': async (_req, _res, { json }, { devClean }) => {
    // The SDK `devStorage` stream: how much space developer tools hold, numbers
    // only. Not supporter-gated (the cleanup actions are), but it spawns docker
    // and reg, so it answers only when some package was granted the stream.
    if (!_sdkStreamGranted('devStorage')) { json({ ok: false, error: 'not_granted' }); return; }
    try   { json({ ok: true, ...(await devClean.summary()) }); }
    catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }
  },

  'GET /disk/status': async (_req, _res, { json, err500 }, { diskSpace }) => {
    // Disk widget state: helper presence, scan progress, last summary and —
    // after a scan — the treemap tree, categories, top files and verified
    // duplicates. Read-only; the widget polls this only while a scan runs.
    //
    // `fdaBlocked` rides along for the same reason it does on /index/status:
    // without it, a macOS install that lost Full Disk Access shows the widget's
    // "turn the live index on" card, which is advice for a different problem
    // and leads the user to a setting that is already correct.
    try {
      json({
        ...(await diskSpace.status()),
        fdaBlocked: process.platform === 'darwin' && !macDiskAccess.granted && macDiskAccess.blockedRoots.length > 0,
        // The helper download exists on Windows only (POST /audio/levels/install-helper).
        canInstallHelper: process.platform === 'win32',
      });
    } catch (e) { err500(e.message); }
  },

  'GET /disk/overview': async (_req, _res, { json, err500, urlObj }, { diskSpace }) => {
    // Per-root live overview (Living-Index path): ?i=N indexes the configured
    // roots — the wire never carries a path (Slideshow shape). Read-only
    // compute over the in-RAM index; ?refresh=1 skips the 30s cache.
    // ?stale=1 answers the last persisted overview instead (display only, no
    // ids): what the widget shows while the index rebuilds after a restart.
    try {
      const i = urlObj.searchParams.get('i');
      json(urlObj.searchParams.get('stale') === '1'
        ? await diskSpace.snapshot(i)
        : await diskSpace.overview(i, urlObj.searchParams.get('refresh') === '1'));
    } catch (e) { err500(e.message); }
  },

  'POST /disk/reveal': async (req, _res, { json, err500 }, { diskSpace }) => {
    // "Show in folder" for a file or folder of the current disk overview, by
    // the opaque id it minted. Reveals, never opens: it runs nothing.
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      json(await diskSpace.reveal(body.i, body.id));
    } catch (e) { err500(e.message); }
  },

  'GET /disk/browse': async (_req, _res, { json, err500, urlObj }, { diskSpace }) => {
    // One directory level from the current disk overview. The client returns
    // only the opaque node id minted by diskspace.js — never a filesystem path.
    try {
      json(await diskSpace.browse(urlObj.searchParams.get('i'), urlObj.searchParams.get('node')));
    } catch (e) { err500(e.message); }
  },

  'POST /api/disk/advisor': async (req, _res, { json, err500 }, { _geminiOneShot, cliOneShot, diskSpace, fileSearch, getInstalledApps, readHubSettings }) => {
    // Dedicated, read-only storage analysis for the Disk modal. It receives a
    // root INDEX, obtains the real snapshot server-side and calls the selected
    // provider with NO tools, so it can neither lose `disk_insights` nor run an
    // action. Clicking the modal button is the explicit quota/privacy action.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const rootIndex = Number(body.rootIndex);
      if (!Number.isInteger(rootIndex) || rootIndex < 0) {
        json({ ok: false, error: 'bad_root' }); return;
      }
      const insight = await diskSpace.insights(rootIndex);
      if (!insight || (!insight.totalBytes && !insight.volume)) {
        json({ ok: false, error: 'index_unavailable' }); return;
      }
      const settings = await readHubSettings().catch(() => null);
      const provider = aiLocal.sanitizeProvider(settings && settings.aiProvider);
      const uiLang = String(body.lang || 'en').toLowerCase().slice(0, 2);
      const fullContext = !!(settings && settings.searchSettings &&
        settings.searchSettings.aiFullContext === true);
      const optedContext = {};
      if (fullContext) {
        const clip = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
        const apps = await getInstalledApps().catch(() => []);
        optedContext.installedApplications = apps
          .slice(0, 150).map((app) => clip(app.name, 60)).filter(Boolean);
        const usage = await fileSearch.usageSnapshot().catch(() => null);
        if (usage) {
          optedContext.frequentFolders = (usage.folders || []).slice(0, 12)
            .map((folder) => clip(folder, 160)).filter(Boolean);
          optedContext.recentSearchOpens = (usage.opens || []).slice(0, 12)
            .map((entry) => ({
              name: clip(entry.name, 80),
              lastOpened: Number(entry.last) || 0,
            }));
        }
        if (settings && settings.hardwareScan) {
          optedContext.pcHardwareProfile = settings.hardwareScan;
        }
      }
      const sysText = 'You are Xenon Storage Advisor, a read-only expert embedded in a Windows disk-cleanup interface. ' +
        'Use ONLY the supplied local snapshot; never invent a file, application, age, purpose or saving. Clearly label any inference. ' +
        'You cannot delete or run commands. Write a thorough but practical report in ' + aiLangName(uiLang, 'English') + '. ' +
        'Cover: (1) diagnosis of capacity, free/used/indexed space and any unexplained difference; ' +
        '(2) a priority cleanup plan with exact sizes/counts; (3) for every present category, what creates it, what it is for, ' +
        'why cleaning may or may not be sensible, what is recreated afterwards and practical ways to reduce recurrence; ' +
        '(4) the largest folders/files and likely owning apps only when the names justify that inference; ' +
        '(5) duplicates and what must be checked before choosing a copy; (6) what must not be touched; ' +
        '(7) a short ordered next-action checklist. Distinguish recommended cleanup from choices only the user can make. ' +
        'If the snapshot is capped or incomplete, say so prominently. Never claim personal files are safe to delete.';
      const userText = 'Local storage snapshot selected by the user:\n' +
        JSON.stringify({ disk: insight, ...(fullContext ? { optedInPcContext: optedContext } : {}) }).slice(0, 60000);
      let text = '';
      if (provider === 'ollama') {
        const baseUrl = aiLocal.sanitizeOllamaUrl(settings && settings.ollamaUrl);
        const model = aiLocal.resolveModel(aiLocal.sanitizeModel(settings && settings.ollamaModel), settings && settings.hardwareScan);
        const result = await aiLocal.localChat({
          baseUrl, model, geminiTools: [],
          history: [{ role: 'user', parts: [{ text: userText }] }],
          systemText: sysText,
          executeTool: async () => ({ fnResult: {}, clientActions: [] }),
        }).catch(() => null);
        text = result && result.text ? String(result.text).trim() : '';
      } else if (provider === 'localapi') {
        text = await localServerOneShot(settings, sysText, userText, 1500).catch(() => '');
      } else if (provider === 'openai' || provider === 'anthropic') {
        const mod = provider === 'openai' ? aiOpenai : aiAnthropic;
        const key = provider === 'openai'
          ? settings && settings.openaiApiKey
          : settings && settings.anthropicApiKey;
        const model = providerModelFor(provider, 'chat', settings);
        if (!key) { json({ ok: false, error: 'no_provider' }); return; }
        text = await mod.oneShot({
          apiKey: key, model, systemText: sysText, userText, maxTokens: 1500,
        }).catch(() => '');
      } else if (provider === 'xenon') {
        text = await aiXenon.oneShot({ dataDir: DATA_DIR, systemText: sysText, userText, maxTokens: 1500, use: 'disk' }).catch(() => '');
      } else if (aiCli.isCliProvider(provider)) {
        text = await cliOneShot(provider, sysText, userText, settings).catch(() => '');
      } else {
        const key = settings && settings.geminiApiKey;
        if (!key) { json({ ok: false, error: 'no_provider' }); return; }
        text = await _geminiOneShot(key, [{ text: userText }], sysText, 1500).catch(() => '');
      }
      if (!text) { json({ ok: false, error: 'ai_failed' }); return; }
      json({
        ok: true,
        text: String(text).slice(0, 20000),
        provider,
        fullContext,
      });
    } catch (e) { err500(e.message); }
  },

  'POST /disk/scan': async (req, _res, { json, err500 }, { diskSpace }) => {
    // Start a scan (helper-gated, one at a time, manual only — never
    // automatic). Root is a strictly-validated drive letter. In
    // CSRF_MUTATION_PATHS.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(diskSpace.startScan(body.root));
    } catch (e) { err500(e.message); }
  },

  'POST /disk/scan/cancel': async (_req, _res, { json, err500 }, { diskSpace }) => {
    try { json(diskSpace.cancelScan()); } catch (e) { err500(e.message); }
  },

  'POST /disk/clean': async (req, _res, { json, err500 }, { diskSpace }) => {
    // Start a cleanup. The body carries category + item ids resolved against
    // the server's own enumeration (never paths); every resolved path is
    // re-stated live and re-checked against the guard blocklist, then moved
    // to the RECYCLE BIN by the helper. Returns as soon as the job is accepted
    // ({ ok, started, id } or { ok:false, error:'busy' }); progress streams on
    // the SSE `disk_clean` event and is re-exposed by /disk/status. In
    // CSRF_MUTATION_PATHS.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await diskSpace.clean(body));
    } catch (e) { err500(e.message); }
  },

  'POST /disk/clean/cancel': async (_req, _res, { json, err500 }, { diskSpace }) => {
    // Stop a running cleanup after the current batch (never mid-move). In
    // CSRF_MUTATION_PATHS.
    try { json(diskSpace.cancelClean()); } catch (e) { err500(e.message); }
  },

  'GET /api/devclean/overview': async (_req, _res, { json, err500, urlObj }, { devClean }) => {
    // Read-only: sizes per source with opaque item ids. Runs the docker/reg
    // CLIs and reads Ollama's /api/tags, only when the tile asks (15s cache;
    // ?refresh=1 skips it).
    try { json({ ok: true, ...(await devClean.overview({ refresh: urlObj.searchParams.get('refresh') === '1' })) }); }
    catch (e) { err500(e.message); }
  },

  'POST /api/devclean/run': async (req, _res, { json, err500 }, { devClean }) => {
    // { source: docker|ollama|vscode, ids: [...] } — ids from the overview,
    // never paths or names. A background job; progress on SSE 'devclean'.
    // In CSRF_MUTATION_PATHS.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await devClean.runClean(String(body.source || ''), body.ids));
    } catch (e) { err500(e.message); }
  },

  'POST /api/devclean/compact': async (req, _res, { json, err500 }, { devClean }) => {
    // Compact one WSL/Docker .vhdx (Windows). Starts compact-vhdx.ps1, which
    // raises the UAC prompt and re-validates the disk itself; the item id is
    // the only input. In CSRF_MUTATION_PATHS + REMOTE_ADMIN: never from a
    // paired device.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await devClean.compact(String(body.id || '')));
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
