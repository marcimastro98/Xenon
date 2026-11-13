// What the engine answers about the voice and the messages of the assistant: speaking a text
// and stopping, the wake word, the models to choose from, the cost of a Game Companion look,
// and the messages behind its card.

const aiLocal = require('../ai-local.js');
const aiModels = require('../ai-models.js');
const aiLocalServer = require('../ai-local-server.js');
const { GEMINI_MODEL_KEYS } = require('./gemini-model-keys.js');
const { PROVIDER_MODEL_KEYS, providerModelFor } = require('./provider-models.js');
const { readBodyBuffer, readBody } = require('../http/read-body.js');
const aiCli = require('../ai-cli.js');
const aiOpenai = require('../ai-openai.js');
const https = require('node:https');
const { pcmToWav } = require('../wav/pcm-to-wav.js');
const { hub } = require('../settings/current.js');
const wakeWord = require('../wakeword.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /bit/messages': async (_req, _res, { json, err500, urlObj }, { bitMessages }) => {
    // The inbox behind Bit's card: what has been said, and the one message this
    // screen may show now. `surface=screen` is the alerts window of "widgets only".
    try { json(await bitMessages.view(urlObj.searchParams.get('surface'))); } catch (e) { err500(e.message); }
  },

  'GET /api/companion/cost': async (_req, _res, { json, err500 }, { companionLookSparks, readHubSettings }) => {
    // Read-only: what a Game Companion look costs, in Sparks, when Bit runs on
    // Sparks; null on any other AI (the user's own key or plan, nothing to show).
    try {
      const settings = await readHubSettings().catch(() => null) || {};
      const onSparks = aiLocal.sanitizeProvider(settings.aiProvider) === 'xenon';
      json({ ok: true, sparks: onSparks ? companionLookSparks() : null });
    } catch (e) { err500(e.message); }
  },

  'GET /api/ai/models': async (_req, _res, { json, urlObj }, { readHubSettings }) => {
    // Live model list for the picker, fetched from each provider's own models
    // API with the user's key so it always reflects what that provider currently
    // offers. Degrades to whatever the cache holds (never an error page) when
    // there is no key or the call fails.
    //
    // `resolved` is the half the UI cannot compute for itself: it says which
    // concrete id each `auto` role lands on right now. A sentinel the panel
    // cannot explain is a setting the user has no way to reason about.
    try {
      const prov = aiLocal.sanitizeProvider(urlObj.searchParams.get('provider'));
      const settings = await readHubSettings().catch(() => null);
      const s = settings || {};
      if (prov === 'ollama') {
        // The local provider has no key and no remote resolution: what it can
        // offer is the curated download catalog plus what is already installed.
        await aiModels.refreshOllamaCatalog({ force: urlObj.searchParams.has('refresh') });
        json({ models: [], catalog: aiModels.ollamaCatalog() });
        return;
      }
      if (prov === 'localapi') {
        // Whatever the server on this PC says it has, right now: the panel's
        // status line and model list both come from this answer.
        json(await aiLocalServer.catalog(aiLocalServer.configFrom(s)));
        return;
      }
      const keyFor = { gemini: s.geminiApiKey, openai: s.openaiApiKey, anthropic: s.anthropicApiKey };
      const apiKey = String(keyFor[prov] || '').trim();
      if (apiKey) {
        await aiModels.refresh(prov, apiKey, { force: urlObj.searchParams.has('refresh') });
      }
      const stored = {};
      const roles = (aiModels.PROVIDERS[prov] && aiModels.PROVIDERS[prov].ROLES) || {};
      for (const role of Object.keys(roles)) {
        stored[role] = prov === 'gemini' ? s[GEMINI_MODEL_KEYS[role]] : s[(PROVIDER_MODEL_KEYS[prov] || {})[role]];
      }
      json(aiModels.catalog(prov, stored, apiKey));
    } catch (e) {
      json({ models: [], resolved: {}, families: [], error: e.message });
    }
  },

  'POST /api/tts': async (req, res, _context, { AI_MODELS, getFfmpegPath, readHubSettings }) => {
    try {
      const ttsRaw = await readBodyBuffer(req, 64 * 1024);
      const ttsBody = JSON.parse(ttsRaw.toString('utf8') || '{}');
      const apiKey = String(ttsBody.key || '').trim().slice(0, 200);
      const rawText = String(ttsBody.text || '').trim().slice(0, 1000);
      // Default to a male Gemini voice; the client may override via `voice`.
      const voice = String(ttsBody.voice || 'Charon').replace(/[^A-Za-z]/g, '').slice(0, 30) || 'Charon';
      const ttsProvider = aiLocal.sanitizeProvider(ttsBody.provider);
      const ttsLang = String(ttsBody.lang || 'en').slice(0, 5);
      if (!rawText) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_params' })); return;
      }
      // Non-Gemini providers return a ready WAV. Ollama and Claude use the free
      // local Edge neural TTS, and so do Xenon credits; ChatGPT uses OpenAI TTS
      // (server-only key).
      if (ttsProvider === 'ollama' || ttsProvider === 'localapi' || ttsProvider === 'anthropic' || ttsProvider === 'xenon' || ttsProvider === 'openai' || aiCli.isCliProvider(ttsProvider)) {
        try {
          let wavBuf;
          if (ttsProvider === 'openai') {
            const s = await readHubSettings().catch(() => null);
            const oKey = String((s && s.openaiApiKey) || '').trim();
            if (!oKey) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'missing_key' })); return; }
            wavBuf = await aiOpenai.tts({ apiKey: oKey, text: rawText, model: providerModelFor('openai', 'tts', s) });
          } else {
            wavBuf = await aiLocal.localTts(rawText, ttsLang, getFfmpegPath());
          }
          if (!wavBuf || !wavBuf.length) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no_audio' })); return; }
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(wavBuf.length), 'Cache-Control': 'no-store' });
          res.end(wavBuf); return;
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message })); return;
        }
      }
      if (!apiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_params' })); return;
      }
      const ttsPayload = JSON.stringify({
        contents: [{ parts: [{ text: rawText }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      });
      process.stdout.write(`[TTS] request voice=${voice} chars=${rawText.length}\n`);
      const _ttsStart = Date.now();
      const ttsModel = AI_MODELS.tts;
      const askGemini = () => new Promise((resolve, reject) => {
        const ttsReq = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/${ttsModel}:generateContent?key=${encodeURIComponent(apiKey)}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ttsPayload), 'User-Agent': 'Xenon/2.0' },
        }, (ttsRes) => {
          let d = '';
          ttsRes.on('data', c => { d += c; });
          ttsRes.on('end', () => {
            process.stdout.write(`[TTS] Gemini HTTP ${ttsRes.statusCode} in ${Date.now() - _ttsStart}ms\n`);
            try {
              const parsed = JSON.parse(d);
              if (parsed.error) {
                process.stdout.write(`[TTS] Gemini error: ${parsed.error.message || JSON.stringify(parsed.error).slice(0, 160)}\n`);
                return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
              }
              const part = parsed?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
              if (!part || !part.data) return reject(new Error('no audio data in TTS response'));
              resolve(part);
            } catch (e) { reject(e); }
          });
        });
        ttsReq.on('error', reject);
        ttsReq.setTimeout(60000, () => { ttsReq.destroy(); reject(new Error('TTS timeout')); });
        ttsReq.write(ttsPayload);
        ttsReq.end();
      });

      // Gemini TTS runs on a preview model, and a preview model is a thing that
      // gets retired. Losing the assistant's voice outright over that would be a
      // hard failure where a soft one exists: the local Edge neural voice is
      // already installed, already used by two other providers on the lines
      // above, and needs no key. So a Gemini TTS failure degrades to it instead
      // of answering 500 — the voice changes, the feature keeps working.
      let inlineData;
      try {
        inlineData = await askGemini();
      } catch (err) {
        process.stdout.write(`[TTS] Gemini failed (${err.message}): falling back to the local voice\n`);
        if (/not found|not supported|NOT_FOUND|404/i.test(String(err.message || ''))) {
          aiModels.markMissing('gemini', ttsModel);
        }
        const localWav = await aiLocal.localTts(rawText, ttsLang, getFfmpegPath()).catch(() => null);
        if (localWav && localWav.length) {
          res.writeHead(200, {
            'Content-Type': 'audio/wav', 'Content-Length': String(localWav.length),
            'Cache-Control': 'no-store', 'X-Xenon-Tts-Fallback': 'local',
          });
          res.end(localWav);
          return;
        }
        throw err;
      }
      const pcmBytes = Buffer.from(inlineData.data, 'base64');
      const rateMatch = String(inlineData.mimeType || '').match(/rate=(\d+)/);
      const sampleRate = rateMatch ? parseInt(rateMatch[1]) : 24000;
      const wavBuf = pcmToWav(pcmBytes, sampleRate);
      process.stdout.write(`[TTS] OK wav=${wavBuf.length} bytes rate=${sampleRate}\n`);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(wavBuf.length), 'Cache-Control': 'no-store' });
      res.end(wavBuf);
    } catch (e) {
      process.stdout.write(`[TTS] FAIL ${e.message}\n`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  },

  'POST /api/speak': async (req, res, _context, { geminiKeyFor, speakOnServer }) => {
    // Server-side voice output (Windows SAPI) — instant and focus-independent.
    // Resolves when speech finishes so the client knows when to re-open listening.
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const text = String(b.text || '').slice(0, 2000);
      const langp = String(b.lang || 'en').slice(0, 5);
      const key = await geminiKeyFor(b.key);
      if (!text) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'missing_text' })); return; }
      const speakProvider = aiLocal.sanitizeProvider(b.provider);
      await speakOnServer(text, langp, key, speakProvider);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
    }
  },

  'POST /api/speak/stop': async (req, res, _context, { stopServerSpeak }) => {
    try { await readBody(req); } catch {}
    stopServerSpeak();
    res.writeHead(204); res.end();
  },

  'GET /api/wake/status': async (_req, res, _context, { _whisperReady }) => {
    // Settings → Xenon AI wake-word row: is the toggle on, is whisper installed,
    // is the listener actually running right now.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      enabled: !!(hub.settings && hub.settings.wakeWord && hub.settings.wakeWord.enabled),
      whisper: _whisperReady(),
      listening: wakeWord.isActive(),
    }));
  },
};

module.exports = { branches };
