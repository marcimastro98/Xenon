// What the engine answers for streaming: the actions, triggers and globals of Streamer.bot, the
// sources of OBS, and the streaming setup saved.

const { readBody } = require('../http/read-body.js');
const { streamingLive } = require('./live.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /obs/sources': async (_req, _res, { json }, { deckObs }) => {
    try {
      const d = await deckObs.request('GetInputList', {});
      const inputs = Array.isArray(d.inputs) ? d.inputs : [];
      // Prefer audio inputs (mic / desktop / app audio); if the kind filter matches
      // none, fall back to every input so the user can still pick one.
      const audio = inputs.filter((i) => /audio|wasapi|coreaudio|pulse|sndio|alsa/i.test(i.inputKind || ''));
      const sources = (audio.length ? audio : inputs).map((i) => i.inputName).filter(Boolean);
      json({ ok: true, sources });
    } catch (e) {
      json({ ok: false, sources: [], error: String((e && e.message) || e) });
    }
  },

  'GET /streamerbot/actions': async (_req, _res, { json }, { deckSb }) => {
    // Live list of Streamer.bot actions for the Deck editor + Settings card. The
    // editor stores each key's action by id (stable across renames); the name is
    // only the label. Returns {ok:false} (not an error) when streamer.bot is off.
    try {
      const d = await deckSb.request('GetActions', {});
      const actions = (Array.isArray(d.actions) ? d.actions : [])
        .map((a) => ({ id: String(a.id || ''), name: String(a.name || '') }))
        .filter((a) => a.id);
      json({ ok: true, actions });
    } catch (e) {
      json({ ok: false, actions: [], error: String((e && e.message) || e) });
    }
  },

  'GET /streamerbot/codetriggers': async (_req, _res, { json }, { deckSb }) => {
    // Live list of Streamer.bot CODE triggers for the Deck editor picker. Stored on
    // a key by trigger name (what ExecuteCodeTrigger takes). Response shape varies by
    // build, so accept `triggers` or `codeTriggers`. {ok:false} when streamer.bot is off.
    try {
      const d = await deckSb.request('GetCodeTriggers', {});
      const raw = Array.isArray(d.triggers) ? d.triggers : (Array.isArray(d.codeTriggers) ? d.codeTriggers : []);
      const triggers = raw
        .map((a) => ({ name: String((a && (a.name || a.triggerName)) || ''), group: String((a && (a.category || a.group)) || '') }))
        .filter((a) => a.name);
      json({ ok: true, triggers });
    } catch (e) {
      json({ ok: false, triggers: [], error: String((e && e.message) || e) });
    }
  },

  'GET /streamerbot/globals': async (_req, _res, { json }, { deckSb }) => {
    // Live list of Streamer.bot global-variable NAMES for the Deck editor's
    // "reflect a global" picker. A key stores the name; its on/off then follows the
    // live value pushed over the `streamerbot` SSE event. {ok:false} when off.
    try {
      const globals = await deckSb.listGlobals();
      json({ ok: true, globals });
    } catch (e) {
      json({ ok: false, globals: [], error: String((e && e.message) || e) });
    }
  },

  'POST /stream/config': async (req, _res, { json, err500 }, { saveStreamConfig }) => {
    // Save the streaming app credentials pasted in Settings → Streaming (so the
    // user never edits stream-config.json by hand) and re-create the providers.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      await saveStreamConfig(body);
      json({ ok: true });
    } catch (e) { err500(e.message); }

  // ── Discord voice integration (local RPC/IPC — needs the Discord desktop app) ─
  },

  'GET /obs/scenes': async (_req, _res, { json }, { deckObs, refreshObsWatch }) => {
    try {
      const d = await deckObs.request('GetSceneList', {});
      // A successful probe means the OBS widget is present AND local OBS answered —
      // arm the live watch + preview even when the host field was left blank.
      if (!streamingLive.obsWanted) { streamingLive.obsWanted = true; refreshObsWatch(); }
      json({ ok: true, current: d.currentProgramSceneName || '', scenes: (d.scenes || []).map((s) => s.sceneName).filter(Boolean) });
    } catch (e) {
      json({ ok: false, scenes: [], error: String((e && e.message) || e) });
    }
  },

  'GET /streamerbot/activity': async (_req, _res, { json }, { buildSbState }) => {
    // Seed for the Streamer.bot widget: connection flag, live globals and the recent
    // activity buffer. New events then stream live over the `streamerbot_event` SSE
    // event; connection/globals over `streamerbot`. No Streamer.bot call here — it's
    // all in-memory — so it's cheap and safe when Streamer.bot is offline.
    try {
      const st = await buildSbState();
      json(Object.assign({ ok: true, recent: streamingLive.streamerbotActivity }, st));
    } catch (e) {
      json({ ok: false, recent: [], configured: false, connected: false, globals: {}, error: String((e && e.message) || e) });
    }
  },
};

module.exports = { branches };
