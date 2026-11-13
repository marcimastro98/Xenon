// What the engine answers for the vitals tile: its saved state, a reminder and what Bit can do
// on this PC to make it felt, the pop-up it shows, and a roast.

const { readBody, readBodyBuffer } = require('../http/read-body.js');
const { vitalsPetCfg } = require('./pet-config.js');
const gameDetect = require('../gamedetect.js');
const { _idleProbe } = require('../system/idle-seconds.js');
const { _vitalsNagLast } = require('./nag-last.js');
const { lockWorkstation } = require('../system/lock-workstation.js');
const { hub } = require('../settings/current.js');
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
  'POST /api/vitals/state': async (req, res, { json, err500 }, { saveVitalsState }) => {
    let body = null;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { body = null; }
    try {
      const out = await saveVitalsState(body);
      if (!out.ok) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); return; }
      json(out);
    } catch (e) { err500(e.message); }
  },

  'POST /api/vitals/nag': async (req, _res, { json }, { vitalsNag }) => {
    // Bit's PC-side nag actions (vitals-pet.js). Defense in depth — each rung
    // re-checks its own strict opt-in from the SERVER settings mirror (a forged
    // loopback request can never exceed what the user enabled), respects the
    // in-game truce, requires FRESH real input for minimize/lock (never punish
    // an empty chair), and rate-limits itself. The overlay script is one-shot
    // and self-terminating (≤30s), so there is nothing to stop at shutdown.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const action = String(body && body.action || '');
      const pet = vitalsPetCfg();
      if (!pet) { json({ ok: false, error: 'pet_disabled' }); return; }
      let gaming = false;
      try { gaming = gameDetect.isGaming(); } catch { gaming = false; }
      if (gaming && pet.quietInGame !== false) { json({ ok: false, error: 'in_game' }); return; }
      const now = Date.now();
      const idleFresh = _idleProbe.at > 0 && (now - _idleProbe.at) < 60000 && typeof _idleProbe.sec === 'number';
      const presentNow = idleFresh && _idleProbe.sec < 240;
      const text = body && typeof body.text === 'string' ? body.text : '';
      const lang = body && typeof body.lang === 'string' ? body.lang : '';
      const mood = body && typeof body.mood === 'string' ? body.mood : '';
      if (action === 'overlay') {
        if (pet.monitors !== true) { json({ ok: false, error: 'not_enabled' }); return; }
        if (now - _vitalsNagLast.overlay < 40000) { json({ ok: false, error: 'cooldown' }); return; }
        const shown = await vitalsNag.popup({ text, mood, lang, all: body && body.all === true });
        if (shown.ok) _vitalsNagLast.overlay = now;
        json(shown);
      } else if (action === 'minimize') {
        if (pet.minimize !== true) { json({ ok: false, error: 'not_enabled' }); return; }
        if (!presentNow) { json({ ok: false, error: 'away' }); return; }
        if (now - _vitalsNagLast.minimize < 4 * 60000) { json({ ok: false, error: 'cooldown' }); return; }
        // An honest answer: where nothing can hide the windows, Bit must not
        // say it did (vitals-pet.js reads `ok`).
        const hidden = await vitalsNag.hide({ text, lang });
        if (hidden.ok) _vitalsNagLast.minimize = now;
        json(hidden);
      } else if (action === 'lock') {
        if (pet.lock !== true) { json({ ok: false, error: 'not_enabled' }); return; }
        if (!presentNow) { json({ ok: false, error: 'away' }); return; }
        if (now - _vitalsNagLast.lock < 10 * 60000) { json({ ok: false, error: 'cooldown' }); return; }
        _vitalsNagLast.lock = now;
        // Make the attribution unmissable on the PC itself: flash Bit's "I'm
        // locking this" popup on every monitor FIRST, then lock a few seconds
        // later — otherwise the lock screen swallows the message and the
        // user never learns it was Bit. Falls back to an immediate lock if the
        // client sent no text (older dashboards).
        if (text) await vitalsNag.popup({ text, mood, lang, all: true });
        setTimeout(() => { lockWorkstation().catch(() => {}); }, text ? 3500 : 0);
        json({ ok: true });
      } else {
        json({ ok: false, error: 'unknown_action' });
      }
    } catch (e) { json({ ok: false, error: e.message }); }
  },

  'GET /api/vitals/caps': async (_req, _res, { json }, { vitalsNag }) => {
    // Which of Bit's PC-side steps work on this PC (vitals-nag.js): Settings
    // hides the ones that cannot, with the reason, instead of offering them.
    try { json({ ok: true, ...(await vitalsNag.capabilities()) }); } catch (e) { json({ ok: false, error: e.message }); }
  },

  'GET /api/vitals/popup': async (_req, _res, { json }, { vitalsNag }) => {
    // The popup Bit is showing now, for the app's alerts window that opened
    // just to show it and missed the SSE push (js/screen-alerts.js).
    json({ ok: true, popup: vitalsNag.current() });
  },

  'POST /api/vitals/roast': async (req, _res, { json }, { _geminiOneShot, geminiKeyFor, readHubSettings, roastSparks }) => {
    // Bit's opt-in AI roasts: ONE short in-character line generated by the
    // user's configured Xenon AI provider from real context (which vital died,
    // for how long, streak, gaming, time of day, now playing, weather). The
    // client hard-times-out and falls back to the offline phrase bank on ANY
    // failure or empty result, so this is best-effort by design. POST-only,
    // never a JSONP candidate; the Gemini key travels in the body exactly like
    // /api/ai/summarize (established pattern). Keys are never logged.
    try {
      // Server-side opt-in re-check (same spirit as /api/vitals/nag): a forged
      // loopback request can't burn the user's AI quota unless they actually
      // enabled Bit AND AI roasts in Settings.
      const vitalsCfg = hub.settings && hub.settings.vitals;
      const petCfg = (vitalsCfg && vitalsCfg.enabled !== false && vitalsCfg.pet) ? vitalsCfg.pet : null;
      if (!petCfg || petCfg.enabled !== true || petCfg.aiRoasts !== true) { json({ text: '' }); return; }
      const raw = await readBodyBuffer(req, 32 * 1024);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const provider = aiLocal.sanitizeProvider(body.provider);
      const apiKey = await geminiKeyFor(body.key);
      // Every context string is length-bounded and stripped of control chars
      // before it goes anywhere near a prompt.
      const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
      const uiLang = clean(body.lang, 5).toLowerCase().slice(0, 2);
      const langName = aiLangName(uiLang, 'English');
      const tone = ['soft', 'spicy', 'savage'].includes(body.tone) ? body.tone : 'spicy';
      const TONE_DESC = {
        soft: 'a gentle, warm nudge',
        spicy: 'sarcastic and cheeky',
        savage: 'merciless and absurd, but never genuinely cruel',
      };
      const ctx = body.ctx && typeof body.ctx === 'object' ? body.ctx : {};
      const KIND_DESC = {
        zero: 'one of the meters just hit zero: roast the user into fixing it',
        nag: 'the meter is STILL at zero: nag again from a fresh angle',
        welcomeback: 'the user just finished a game session during which a meter died: congratulate and roast',
        return: 'the user just came back to the PC after being away: welcome them back with a wink',
      };
      const kindDesc = KIND_DESC[clean(ctx.kind, 20)] || KIND_DESC.nag;
      const facts = [];
      const vitalName = clean(ctx.vital, 40);
      if (vitalName) facts.push('neglected meter: ' + vitalName);
      const min = Math.max(0, Math.min(100000, Math.round(Number(ctx.min) || 0)));
      if (min > 0) facts.push('minutes in this state: ' + min);
      const streak = Math.max(0, Math.min(100000, Math.round(Number(ctx.streak) || 0)));
      if (streak > 1) facts.push('current self-care streak: ' + streak + ' days');
      if (ctx.gaming === true) facts.push('the user is gaming right now');
      const timeOfDay = clean(ctx.timeOfDay, 20);
      if (timeOfDay) facts.push('time of day: ' + timeOfDay);
      const media = clean(ctx.media, 80);
      if (media) facts.push('now playing: ' + media);
      const weather = clean(ctx.weather, 60);
      if (weather) facts.push('weather outside: ' + weather);
      const sysText = 'You are Bit, an 8-bit pixel guardian who lives on the user\'s PC dashboard and guards their self-care meters (hydration, energy, movement, eye rest, posture). '
        + `Write exactly ONE line in ${langName}, maximum 140 characters. No quotes, no emoji, no preamble, no explanations. `
        + `Tone: ${TONE_DESC[tone]}. Funny, like a friend teasing: never a bully. Situation: ${kindDesc}.`;
      const userText = 'Context:\n' + (facts.length ? facts.join('\n') : '(no extra context)') + '\n\nBit\'s one-liner:';
      let text = '';
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
        if (result && result.text) text = String(result.text);
      } else if (provider === 'localapi') {
        const settings = await readHubSettings().catch(() => null);
        text = await localServerOneShot(settings, sysText, userText, 100).catch(() => '');
      } else if (provider === 'openai' || provider === 'anthropic') {
        const settings = await readHubSettings().catch(() => null);
        const mod = provider === 'openai' ? aiOpenai : aiAnthropic;
        const provKey = provider === 'openai' ? (settings && settings.openaiApiKey) : (settings && settings.anthropicApiKey);
        const provModel = providerModelFor(provider, 'chat', settings);
        if (provKey) text = await mod.oneShot({ apiKey: provKey, model: provModel, systemText: sysText, userText, maxTokens: 100 }).catch(() => '');
      } else if (provider === 'xenon') {
        // Only within the Sparks a day the user chose for roasts (none by default).
        text = await roastSparks.spend(petCfg.roastSparksCap, async () => {
          let credits = NaN;
          const out = await aiXenon.oneShot({
            dataDir: DATA_DIR, systemText: sysText, userText, maxTokens: 100, use: 'roast',
            onUsage: (_tokens, u) => { credits = u && u.credits; },
          });
          return { text: out, credits };
        });
      } else if (aiCli.isCliProvider(provider)) {
        // Bit speaks up on its own, so it never spends the user's Claude Code /
        // Codex subscription: an empty line sends the client to its phrase bank.
        text = '';
      } else {
        if (apiKey) text = await _geminiOneShot(apiKey, [{ text: userText }], sysText, 100).catch(() => '');
      }
      json({ text: clean(text, 200) });
    } catch (e) { json({ error: e.message }); }
  },
};

module.exports = { branches };
