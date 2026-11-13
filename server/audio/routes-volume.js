// What the engine answers about volume and the mixers: the audio state, lowering the volume
// while the assistant speaks and restoring it, the microphone and the speaker chosen, Wave Link
// and Voicemeeter.

const { readBody } = require('../http/read-body.js');
const { audioCache } = require('./device-cache.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /audio': async (_req, _res, { json }, { getAudioInfo }) => {
    // On failure (SoundVolumeView missing/blocked) return an explicit
    // { unavailable } marker with 200 so the polling fallback can render the
    // Volume section's "audio unavailable" notice, matching the SSE path.
    try   { json(await getAudioInfo()); }
    catch { json({ unavailable: true }); }
  },

  'POST /speaker/set': async (req, _res, { json, err500 }, { setDefaultAudioDevice }) => {
    try {
      const { id } = JSON.parse(await readBody(req));
      setDefaultAudioDevice(id).then(() => { audioCache.speakerId = id; json({ ok: true }); }, e => err500(e.message));
    } catch (e) { err500(e.message); }
  },

  'POST /mic/set': async (req, _res, { json, err500 }, { setDefaultAudioDevice, setMicMute }) => {
    try {
      const { id } = JSON.parse(await readBody(req));
      setDefaultAudioDevice(id).then(() => {
        audioCache.micId = id;
        if (audioCache.muted) setMicMute(true);
        json({ ok: true });
      }, e => err500(e.message));
    } catch (e) { err500(e.message); }
  },

  'GET /api/voicemeeter/state': async (_req, _res, { json }, { deckVoicemeeter }) => {
    // What the Deck editor's strip/bus pickers are filled from, and the honest
    // answer when there is nothing to fill them with: `available` says the DLL
    // is there, `running` says the mixer is up, and `reason` names which of the
    // two is missing. Never throws — an absent Voicemeeter is a state.
    try { json(deckVoicemeeter.state()); }
    catch (e) { json({ ok: true, available: false, running: false, reason: 'voicemeeter_unavailable' }); }
  },

  'GET /api/wavelink/state': async (_req, _res, { json, err500 }, { buildWlState }) => {
    // Current Wave Link mixer snapshot (for a tile's first paint before SSE ticks).
    try { json(await buildWlState()); } catch (e) { err500(e.message); }
  },

  'GET /api/wavelink/channels': async (_req, _res, { json }, { deckWaveLink }) => {
    // Channel list for the Deck editor's mixer picker: [{ value: mixId, label }].
    try { json({ channels: await deckWaveLink.listChannels() }); } catch (e) { json({ channels: [] }); }
  },

  'GET /api/wavelink/mixes': async (_req, _res, { json }, { deckWaveLink }) => {
    // Mix list for the editor's mix picker. On Wave Link 2 these are the two
    // synthetic mixes (Local/Stream); on 3.x they are the user's own, named.
    // Either way the picker shows words rather than PCM_IN_01_V_00_SD1.
    try { json({ mixes: await deckWaveLink.listMixes() }); } catch (e) { json({ mixes: [] }); }
  },

  'GET /api/wavelink/icon': async (_req, res, { urlObj }, { deckWaveLink }) => {
    // Wave Link 3 ships a PNG per channel as base64. It is served here, by id,
    // rather than carried in the SSE frame that fires on every fader move.
    // The id is resolved against the client's own cache — no path, no lookup by
    // anything the caller supplies beyond a key we minted.
    try {
      const buf = deckWaveLink.iconFor(urlObj.searchParams.get('id') || '');
      if (!buf) { res.writeHead(404).end(); return; }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': buf.length,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    } catch (e) { res.writeHead(404).end(); }
  },

  'POST /api/wavelink/test': async (_req, _res, { json }, { deckWaveLink }) => {
    // Settings "Test connection": open the socket once and report reachability.
    try { json(await deckWaveLink.test()); } catch (e) { json({ ok: false, error: 'wl_failed' }); }
  },

  'POST /api/volume/duck': async (req, res, _context, { svvExec }) => {
    // Lower system volume before TTS speaks so Xenon's voice is foregrounded.
    try {
      await readBody(req);
      if (!audioCache.ducked && audioCache.speakerId) {
        audioCache.volumeBeforeDuck = audioCache.speakerVolume;
        audioCache.ducked = true;
        svvExec(['/SetVolume', audioCache.speakerId, '20']).catch(() => {});
      }
      res.writeHead(204); res.end();
    } catch { res.writeHead(204); res.end(); }
  },

  'POST /api/volume/restore': async (req, res, _context, { svvExec }) => {
    try {
      await readBody(req);
      if (audioCache.ducked && audioCache.speakerId) {
        const vol = audioCache.volumeBeforeDuck != null ? audioCache.volumeBeforeDuck : 70;
        audioCache.ducked = false;
        audioCache.volumeBeforeDuck = null;
        svvExec(['/SetVolume', audioCache.speakerId, String(vol)]).catch(() => {});
      }
      res.writeHead(204); res.end();
    } catch { res.writeHead(204); res.end(); }
  },
};

module.exports = { branches };
