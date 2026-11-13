// What the engine answers about sound: whether the levels are read, the watch and the programs
// that play.

const { audioLevelsWanted } = require('./levels-wanted.js');
const audioLevels = require('../audio-levels.js');
const { readSoundVolumeRows } = require('./volume-rows.js');
const { F } = require('./svv-csv.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /audio/levels/status': async (_req, _res, { json }) => {
    // Read-only: why the meters are (or are not) running, so Settings can explain
    // a switch that appears to do nothing instead of leaving the user guessing.
    json({
      ok: true,
      wanted: audioLevelsWanted(),
      platform: process.platform,   // meters exist on Windows only; Settings says so elsewhere
      available: audioLevels.available(),
      running: audioLevels.isRunning(),
      failure: audioLevels.failure(),
      minVersion: audioLevels.minVersion(),
    });
  },

  'GET /audio/watch': async (_req, _res, { json }) => {
    // "A Volume or Microphone panel is on screen". The prefix check at the top of
    // this handler has already re-armed the 8 second audio tick, which is all this
    // route is for: the dashboard sends it every 30 seconds while a mixer is in view
    // and not at all while none is. It reads nothing and spawns nothing, so a mixer
    // left on screen all day costs one empty request every half minute.
    json({ ok: true });
  },

  'GET /audio/apps': async (_req, _res, { json }) => {
    // Broader app list for the Deck editor's app picker: every application audio
    // session (active OR inactive) that has a real exe, deduped by process name.
    // Wider than /audio (which only surfaces apps currently producing sound) so a
    // key can be configured for an app that isn't playing right now.
    try {
      const rows = await readSoundVolumeRows();
      const SYS_RE = /^(audiodg|rtkuwp|system|dwm|explorer|searchhost|shellexperiencehost|startmenuexperiencehost|textinputhost|applicationframehost|nvcontainer)$/i;
      const procOf = f => ((f[F.PROC_PATH] || '').split('\\').pop() || '').replace(/\.exe$/i, '');
      const seen = new Map();
      for (const f of rows) {
        if (f[F.TYPE] !== 'Application' || !f[F.PROC_PATH]) continue;
        const proc = procOf(f);
        if (!proc || SYS_RE.test(proc)) continue;
        const key = proc.toLowerCase();
        if (!seen.has(key)) seen.set(key, { proc, name: f[F.NAME] || f[F.WINDOW_TITLE] || proc });
      }
      json({ ok: true, apps: [...seen.values()] });
    } catch (e) { json({ ok: false, apps: [], error: e.message }); }
  },
};

module.exports = { branches };
