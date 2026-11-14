// Reads the sound devices, the volume and the levels of this computer.

const { F } = require('./svv-csv.js');
const { audioCache } = require('./device-cache.js');
const { resolveAppIcons } = require('../programs/app-icons.js');
const { audioReads } = require('./read-state.js');
const { readSoundVolumeRows } = require('./volume-rows.js');
const { _maybeRebindSttDevice } = require('../ai/stt-start.js');

async function _getAudioInfoRaw() {
  const allRows = await readSoundVolumeRows();

  // ── Device-level (master) ────────────────────────────────────
  const deviceRows = allRows.filter(f => f[F.TYPE] === 'Device' && f[F.STATE] === 'Active');
  const speakers   = deviceRows.filter(f => f[F.DIR] === 'Render');
  const mics       = deviceRows.filter(f => f[F.DIR] === 'Capture');

  const defSpk = speakers.find(f => f[F.DEFAULT] === 'Render') || speakers[0];
  const defMic = mics.find(f => f[F.DEFAULT] === 'Capture')    || mics[0];

  if (defSpk) { audioCache.speakerId = defSpk[F.CLI_ID]; audioCache.speakerName = defSpk[F.NAME]; audioCache.speakerVolume = parseInt(defSpk[F.VOL_PCT]) || audioCache.speakerVolume; }
  if (defMic) { audioCache.micId = defMic[F.CLI_ID]; audioCache.micLabel = defMic[F.NAME]; _maybeRebindSttDevice(); }

  const toDevice = (f, isDefault) => ({
    name:      f[F.DEVICE_NAME],
    label:     f[F.NAME],
    id:        f[F.CLI_ID],
    isDefault,
    volume:    parseInt(f[F.VOL_PCT]) || 0,
    muted:     f[F.MUTED] === 'Yes',
  });

  // ── Application-level sessions ───────────────────────────────
  // Show only sessions that are currently Active — this mirrors the Windows 11
  // Volume Mixer, which lists an app while it actually holds an audio stream and
  // drops it otherwise. Keeping Inactive sessions surfaced apps that Windows
  // hides (e.g. RtkUWP, Explorer), so we filter them out here. Requiring a real
  // exe path also excludes the "System Sounds" pseudo-sessions (empty Process
  // Path). Dedupe per process path (an app can open one session per tab/stream).
  // The exe basename (e.g. "spotify", "icue") is the most reliable label: the
  // client runs it through prettyAppName for friendly names, sidestepping bad
  // session metadata like "Qt6" that some apps report in the NAME column.
  const procName = f => ((f[F.PROC_PATH] || '').split('\\').pop() || '').replace(/\.exe$/i, '');

  // Browser processes whose audio-session window title reveals the actual site
  // (Twitch / YouTube / SoundCloud …). SMTC only reports the host browser, so we
  // forward this title — for browser sessions only — and the client resolves the
  // real source from it. Non-browser titles are never sent (keeps the payload
  // lean and avoids surfacing unrelated window titles).
  const BROWSER_PROC_RE = /^(?:chrome|msedge|firefox|brave|opera|vivaldi)$/i;

  const collectApps = dir => {
    const sessions = allRows.filter(f =>
      f[F.TYPE] === 'Application' &&
      f[F.DIR]  === dir &&
      f[F.PROC_PATH] &&
      f[F.STATE] === 'Active'
    );
    const byPath = new Map();
    for (const f of sessions) {
      const key = f[F.PROC_PATH].toLowerCase();
      const existing = byPath.get(key);
      // Prefer an Active session over an Inactive one for the visible row.
      if (!existing || (f[F.STATE] === 'Active' && existing[F.STATE] !== 'Active')) {
        byPath.set(key, f);
      }
    }
    return [...byPath.values()].map(f => {
      const proc = procName(f);
      return {
        name:   f[F.NAME] || f[F.WINDOW_TITLE] || proc || 'App',
        proc,
        id:     f[F.CLI_ID],
        path:   f[F.PROC_PATH],
        volume: parseInt(f[F.VOL_PCT]) || 0,
        muted:  f[F.MUTED] === 'Yes',
        icon:   null,
        win:    BROWSER_PROC_RE.test(proc) ? (f[F.WINDOW_TITLE] || '') : '',
      };
    });
  };

  const speakerApps = collectApps('Render');
  const micApps     = collectApps('Capture');

  // Resolve icons from the exe path (cached; only slow on first appearance).
  const allPaths = [...speakerApps, ...micApps].map(a => a.path);
  if (allPaths.length) {
    const icons = await resolveAppIcons(allPaths);
    let i = 0;
    speakerApps.forEach(a => { a.icon = icons[i++]; delete a.path; });
    micApps.forEach(a => { a.icon = icons[i++]; delete a.path; });
  }

  return {
    speaker:     defSpk ? toDevice(defSpk, true) : null,
    mic:         defMic ? toDevice(defMic, true)  : null,
    speakers:    speakers.map(f => toDevice(f, f === defSpk)),
    mics:        mics.map(f => toDevice(f, f === defMic)),
    speakerApps,
    micApps,
  };
}

async function getAudioInfo() {
  if (audioReads.pending) return audioReads.pending;
  const p = _getAudioInfoRaw();
  audioReads.pending = p;
  try { return await p; } finally { if (audioReads.pending === p) audioReads.pending = null; }
}

module.exports = { _getAudioInfoRaw, getAudioInfo };
