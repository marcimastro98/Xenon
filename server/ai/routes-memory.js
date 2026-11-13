// What the engine answers about what the assistant remembers and has done: its memory, the
// running summary of a long conversation, the list of its actions, undoing one, and a Deck
// action it proposed that the user approves or cancels.

const { readBodyBuffer, readBody } = require('../http/read-body.js');
const aiRateStore = require('../ai-rate-store.js');
const remoteActions = require('../remote-actions.js');
const { readDeckStore } = require('../deck/store-read.js');
const aiLocal = require('../ai-local.js');
const { aiLangName } = require('./prompt-language.js');
const { localServerOneShot } = require('./local-server-one-shot.js');
const aiOpenai = require('../ai-openai.js');
const aiAnthropic = require('../ai-anthropic.js');
const { providerModelFor } = require('./provider-models.js');
const aiXenon = require('../ai-xenon-credits.js');
const { DATA_DIR } = require('../engine/paths.js');
const aiCli = require('../ai-cli.js');
const gameDetect = require('../gamedetect.js');
const { listScreens } = require('../screens/list-screens.js');
const { companionState } = require('./companion-state.js');
const fpsMonitor = require('../fps-monitor.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /api/ai/memory': async (_req, _res, { json }, { aiMemory, readHubSettings }) => {
    // Persistent AI memory — list what Xenon remembers about the user (for the
    // Settings → Funzioni AI viewer). Local data; loopback-guarded like all routes.
    try {
      const s = await readHubSettings().catch(() => null);
      json({ enabled: !(s && s.aiMemory === false), facts: aiMemory.list() });
    } catch (e) { json({ enabled: true, facts: [], error: e.message }); }
  },

  'POST /api/ai/memory': async (req, _res, { json }, { aiMemory }) => {
    // Add a fact by hand from Settings (the AI adds facts via remember_fact).
    try {
      const raw = await readBodyBuffer(req, 4 * 1024);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      json(await aiMemory.add(String(body.text || body.fact || '')));
    } catch (e) { json({ ok: false, error: e.message }); }
  },

  'DELETE /api/ai/memory': async (req, _res, { json }, { aiMemory }) => {
    // Remove one fact (by id) or clear everything ({ all: true }).
    try {
      const raw = await readBodyBuffer(req, 4 * 1024);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      json(body.all === true ? await aiMemory.clear() : await aiMemory.remove(String(body.id || body.text || '')));
    } catch (e) { json({ ok: false, error: e.message }); }
  },

  'GET /api/ai/actions': async (_req, _res, { json }, { aiActionLog }) => {
    // Recent AI actions + the latest still-undoable one (for the chat's "undo"
    // affordance and a "what did you just do" view). Local, loopback-guarded.
    const last = aiActionLog.lastUndoable();
    json({ actions: aiActionLog.list(), last: last ? { id: last.id, label: last.label, name: last.name } : null });
  },

  'POST /api/ai/actions/undo': async (req, _res, { json }, { aiActionLog, performAiUndo }) => {
    // Undo an AI action by id, or the most recent undoable one when no id given.
    try {
      const raw = await readBodyBuffer(req, 4 * 1024);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const entry = body.id ? aiActionLog.get(String(body.id)) : aiActionLog.lastUndoable();
      if (!entry) { json({ ok: false, error: 'not_found' }); return; }
      const r = await performAiUndo(entry);
      if (r.ok) aiActionLog.markUndone(entry.id);
      json(r);
    } catch (e) { json({ ok: false, error: e.message }); }
  },

  'POST /ai/deck-run': async (req, _res, { json, err500, isRemote }, { _deckConfirms, deckRegistry, ratingVotes }) => {
    // A Deck action Bit proposed and the user approved on the card. The action
    // comes from the server's own store by nonce, never from this body.
    try {
      const { nonce } = JSON.parse(await readBody(req) || '{}');
      const action = _deckConfirms.take(nonce);
      if (!action) { json({ ok: false, error: 'expired' }); return; }
      if (action.type === aiRateStore.TYPE) { json(await ratingVotes.vote(action)); return; }
      if (isRemote) {
        const verdict = remoteActions.remoteMayRun(action, await readDeckStore());
        if (!verdict.ok) { json({ ok: false, error: verdict.error }); return; }
      }
      json(await deckRegistry.run(action));
    } catch (e) { err500(e.message); }
  },

  'POST /ai/deck-cancel': async (req, _res, { json, err500 }, { _deckConfirms }) => {
    try {
      const { nonce } = JSON.parse(await readBody(req) || '{}');
      _deckConfirms.cancel(nonce);
      json({ ok: true });
    } catch (e) { err500(e.message); }
  },

  'POST /api/ai/summarize': async (req, _res, { json }, { _geminiOneShot, cliOneShot, geminiKeyFor, readHubSettings }) => {
    // Rolling conversation summary: fold older turns (that scrolled out of the
    // client's window) into a compact running summary the next /api/ai turn
    // injects as context. Provider-aware; best-effort — on any failure the
    // client keeps its raw history under the hard cap.
    try {
      const raw = await readBodyBuffer(req, 256 * 1024);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const provider = aiLocal.sanitizeProvider(body.provider);
      const apiKey = await geminiKeyFor(body.key);
      const prev = String(body.prevSummary || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
      const turns = Array.isArray(body.messages) ? body.messages.slice(0, 60) : [];
      const uiLang = String(body.lang || '').toLowerCase().slice(0, 2);
      const langName = aiLangName(uiLang, 'English');
      // Flatten the turns to plain "Role: text" lines (text parts only — images
      // and audio are not carried in history anyway).
      const transcript = turns.map((m) => {
        if (!m || !Array.isArray(m.parts)) return '';
        const txt = m.parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join(' ').trim();
        return txt ? `${m.role === 'model' ? 'Assistant' : 'User'}: ${txt}` : '';
      }).filter(Boolean).join('\n').slice(0, 8000);
      if (!transcript) { json({ summary: prev }); return; }
      const sysText = `You maintain a running summary of a conversation between a user and Xenon (a dashboard assistant). Update the summary so it captures the durable context: what the user wants, decisions made, facts they shared, and any open thread, written in ${langName}. Be concise (at most ~8 short sentences). Output ONLY the updated summary, with no preamble.`;
      const userText = (prev ? `Current summary:\n${prev}\n\n` : '') + `New conversation turns to fold in:\n${transcript}\n\nUpdated summary:`;
      let summary = prev;
      if (provider === 'ollama') {
        const settings = await readHubSettings().catch(() => null);
        const baseUrl = aiLocal.sanitizeOllamaUrl(body.ollamaUrl || (settings && settings.ollamaUrl));
        const concreteModel = aiLocal.resolveModel(aiLocal.sanitizeModel(body.model), settings && settings.hardwareScan);
        const result = await aiLocal.localChat({
          baseUrl, model: concreteModel, geminiTools: [],
          history: [{ role: 'user', parts: [{ text: userText }] }],
          systemText: sysText,
          executeTool: async () => ({ fnResult: {}, clientActions: [] }),
        }).catch(() => null);
        if (result && result.text) summary = String(result.text).trim().slice(0, 2000);
      } else if (provider === 'localapi') {
        const settings = await readHubSettings().catch(() => null);
        const out = await localServerOneShot(settings, sysText, userText, 400).catch(() => '');
        if (out) summary = String(out).trim().slice(0, 2000);
      } else if (provider === 'openai' || provider === 'anthropic') {
        const settings = await readHubSettings().catch(() => null);
        const mod = provider === 'openai' ? aiOpenai : aiAnthropic;
        const provKey = provider === 'openai' ? (settings && settings.openaiApiKey) : (settings && settings.anthropicApiKey);
        const provModel = providerModelFor(provider, 'chat', settings);
        if (!provKey) { json({ summary: prev }); return; }
        const out = await mod.oneShot({ apiKey: provKey, model: provModel, systemText: sysText, userText, maxTokens: 400 }).catch(() => '');
        if (out) summary = String(out).trim().slice(0, 2000);
      } else if (provider === 'xenon') {
        const out = await aiXenon.oneShot({ dataDir: DATA_DIR, systemText: sysText, userText, maxTokens: 400, use: 'summary' }).catch(() => '');
        if (out) summary = String(out).trim().slice(0, 2000);
      } else if (aiCli.isCliProvider(provider)) {
        const out = await cliOneShot(provider, sysText, userText).catch(() => '');
        if (out) summary = String(out).trim().slice(0, 2000);
      } else {
        if (!apiKey) { json({ summary: prev }); return; }
        const out = await _geminiOneShot(apiKey, [{ text: userText }], sysText, 400).catch(() => '');
        if (out) summary = String(out).trim().slice(0, 2000);
      }
      json({ summary });
    } catch (e) { json({ error: e.message }); }
  },

  'POST /api/companion/insight': async (req, res, { json, err500 }, { captureScreenshot, completeWithUserAi, userAiVisionBlocker }) => {
    // Game Companion (opt-in, Settings → Funzioni AI): capture the primary
    // screen and ask the AI set for Bit (Sparks, the user's key, a seeing
    // Ollama model) for a short in-game insight. Each call costs one vision
    // request, so the client only calls it on demand (overlay opened or manual
    // refresh) — never on a background timer while hidden.
    const companionFail = (status, error) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error }));
    };
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const blocked = await userAiVisionBlocker();
      if (blocked) { companionFail(400, blocked); return; }
      const langName = aiLangName(body.lang, 'English');
      const question = String(body.question || '').trim().slice(0, 300);
      let fgProc = '';
      try { fgProc = gameDetect.getForegroundProcess() || ''; } catch {}
      const screens = await listScreens();
      const primary = screens.find(s => s.primary) || screens[0];
      const shot = await captureScreenshot(primary);
      const sysText = 'You are Xenon\'s Game Companion, shown to the user while they play (on a second screen, or as a card over the game). You receive a live screenshot of their game.';
      const task = question
        ? `The user asks: «${question}». Answer their question, grounded in what you see on screen. Reply in ${langName}: short plain sentences, no markdown, no preamble.`
        : `Identify the game and the current in-game situation, then give ONE concrete, immediately useful tip (strategy, mechanic, objective, build…). Reply in ${langName}: 2-3 short plain sentences, no markdown, no preamble. If the screen is clearly not a game, briefly say what you see instead.`;
      const { text, sparks } = await completeWithUserAi({
        use: 'insight', system: sysText,
        user: `Live screenshot of the user's primary monitor${fgProc ? ` (foreground process: "${fgProc}")` : ''}. ${task}`,
        image: { mimeType: 'image/jpeg', data: shot },
        maxTokens: 512,
      });
      if (!text) throw new Error('empty companion answer');
      if (Number.isFinite(sparks)) companionState.lastSparks = sparks;
      let fps = null;
      try { fps = fpsMonitor.getCurrentFps(); } catch { fps = null; }
      json({ text, process: fgProc, fps, ...(Number.isFinite(sparks) ? { sparks } : {}) });
    } catch (e) {
      // Out of Sparks is the user's to fix, so it is named; the rest is logged.
      if (e && e.code === 'no_credits') { companionFail(402, 'no_credits'); return; }
      if (e && e.code === 'no_vision') { companionFail(400, 'no_vision'); return; }
      err500(e.message);
    }
  },
};

module.exports = { branches };
