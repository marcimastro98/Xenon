// What the engine answers about sound: whether the levels are read, the watch and the programs
// that play.

const { audioLevelsWanted } = require('./levels-wanted.js');
const audioLevels = require('../audio-levels.js');
const { readSoundVolumeRows } = require('./volume-rows.js');
const { F } = require('./svv-csv.js');
const { readBody } = require('../http/read-body.js');
const { appAudioTarget } = require('./app-target.js');
const { createHelperUpdate } = require('../helper-update.js');
const { HELPER_EXE } = require('../engine/paths.js');
const { APP_VERSION } = require('../updates/app-version.js');
const startupLog = require('../startup-log.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
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

  'POST|GET /audio/app/volume': async (req, _res, { json, err500, urlObj }, { svvExec }) => {
    try {
      let id, level, proc;
      if (req.method === 'GET') {
        id = urlObj.searchParams.get('id');
        proc = urlObj.searchParams.get('proc');
        level = parseInt(urlObj.searchParams.get('level'));
      } else {
        ({ id, level, proc } = JSON.parse(await readBody(req)));
      }
      // Prefer the durable process-name target over the session CLI id, which
      // SoundVolumeView rotates across app restarts (a stale id is a silent miss).
      const target = proc ? appAudioTarget(proc) : String(id || '').trim();
      // Checked AFTER normalisation, never on the raw fields: proc="   " (or
      // ".exe") passed the old `!id && !proc` test and reduced to a target the
      // Linux matcher read as "every audio stream on this machine".
      if (!target) { err500('Missing id'); return; }
      const vol = Math.max(0, Math.min(100, parseInt(level)));
      // Natural behaviour: 0 = silent (muted) for that app, >0 = audible.
      svvExec(['/SetVolume', target, String(vol)])
        .then(() => svvExec([vol === 0 ? '/Mute' : '/Unmute', target]))
        .then(() => json({ ok: true, level: vol }), e => err500(e.message));
    } catch (e) { err500(e.message); }
  },

  'POST|GET /audio/app/mute': async (req, _res, { json, err500, urlObj }, { svvExec }) => {
    try {
      let id, muted, proc;
      if (req.method === 'GET') {
        id = urlObj.searchParams.get('id');
        proc = urlObj.searchParams.get('proc');
        muted = urlObj.searchParams.get('muted');
      } else {
        ({ id, muted, proc } = JSON.parse(await readBody(req)));
      }
      // Prefer the durable process-name target over the volatile session CLI id.
      const target = proc ? appAudioTarget(proc) : String(id || '').trim();
      // See /audio/app/volume: an empty target used to select every stream.
      if (!target) { err500('Missing id'); return; }
      // Explicit state (deterministic) when the client tells us; else toggle.
      const action = muted === undefined || muted === null
        ? '/Switch'
        : ((muted === true || muted === 'true' || muted === '1') ? '/Mute' : '/Unmute');
      svvExec([action, target]).then(() => json({ ok: true }), e => err500(e.message));
    } catch (e) { err500(e.message); }
  },

  'POST /audio/levels/install-helper': async (req, _res, { json }, { helperArrived, helperInstall }) => {
    // "Install Xenon Helper", under the wave switch in Settings. The boot heal
    // only ever replaces a helper that is already there, so one that never
    // arrived had no way in short of re-running the setup. This is the same
    // verified download (signed SHA256SUMS, pinned key, fail closed), for this
    // version's release. A paired device cannot reach it (remote-access.js).
    try {
      await readBody(req);
      if (process.platform !== 'win32') { json({ ok: false, status: 'unsupported' }); return; }
      if (!helperInstall.running) {
        helperInstall.running = createHelperUpdate({ helperExe: HELPER_EXE, appVersion: APP_VERSION }).install()
          .finally(() => { helperInstall.running = null; });
      }
      const status = await helperInstall.running;
      const ok = status === 'installed' || status === 'up-to-date';
      startupLog.write('helper install from Settings: ' + status);
      if (ok) helperArrived();
      json({ ok, status });
    } catch (e) { json({ ok: false, status: 'error', detail: String(e && e.message || e) }); }
  },
};

module.exports = { branches };
