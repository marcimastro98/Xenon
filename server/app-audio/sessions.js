'use strict';

// Which audio sessions a per-app volume or mute change reaches.
//
// One app can hold an output session and a microphone session at the same time
// (Discord, a call, OBS). SoundVolumeView's process-name target ("Discord.exe")
// reaches every session of that process, so the microphone slider moved the
// app's output too, and the other way round. The Command-Line Friendly ID does
// not tell them apart either: on a headset both read
// "<headset>\Application\Discord". The Item ID does, because it carries the
// endpoint, so each direction is set on its own. On Linux a row's id is the
// PipeWire node, which is already a single stream.

const ITEM_ID = 17;              // SoundVolumeView /scomma 'Item ID' column
const FRESH_MS = 10000;          // older session lists are read again before use
const DIRS = { render: 'Render', capture: 'Capture' };

// A bare process name with a .exe suffix: the durable identifier the Deck stores.
// A blank app name yields a blank target, never the bare ".exe", which the Linux
// matcher reads as "every stream on the machine" once the suffix is stripped.
// Callers refuse an empty target instead of aiming at everything.
function appAudioTarget(app) {
  const base = String(app || '').split(/[\\/]/).pop().trim();
  if (!base) return '';
  return /\.exe$/i.test(base) ? base : base + '.exe';
}

// 'render' | 'capture' (any case) to the row's spelling, '' when not one of them.
function normDir(dir) {
  return DIRS[String(dir || '').toLowerCase()] || '';
}

// Every application session in the rows, with the one id that reaches it alone.
function appSessions(rows, F) {
  const out = [];
  for (const f of Array.isArray(rows) ? rows : []) {
    if (!f || f[F.TYPE] !== 'Application' || !f[F.PROC_PATH]) continue;
    const target = String(f[ITEM_ID] || f[F.CLI_ID] || '').trim();
    const proc = appAudioTarget(f[F.PROC_PATH]).toLowerCase();
    if (target && proc) out.push({ proc, dir: f[F.DIR], target });
  }
  return out;
}

// The ids to change for one app in one direction (output when none is named).
// A caller that named the direction gets only those sessions, or none. One that
// did not (a Deck key, the music tile) means the app's sound: an app with no
// output session falls back to its process name, as before.
function sessionTargets(sessions, app, dir) {
  const proc = appAudioTarget(app);
  if (!proc) return [];
  const want = proc.toLowerCase();
  const named = normDir(dir);
  const side = named || 'Render';
  const hits = sessions.filter((s) => s.proc === want && s.dir === side).map((s) => s.target);
  if (hits.length || named) return [...new Set(hits)];
  return [proc];
}

// readRows: () => Promise<rows>, the same SoundVolumeView rows the audio read uses.
function createAppSessions({ readRows, F, now = Date.now }) {
  let sessions = [];
  let at = 0;
  function remember(rows) { sessions = appSessions(rows, F); at = now(); }
  async function reread() {
    try { remember(await readRows()); return true; } catch { return false; /* keep the last list */ }
  }
  async function targets(app, dir) {
    const fresh = now() - at > FRESH_MS && await reread();
    const found = sessionTargets(sessions, app, dir);
    // A session opened since the last read (the mic of a call just joined).
    if (!found.length && !fresh && await reread()) return sessionTargets(sessions, app, dir);
    return found;
  }
  return { remember, targets };
}

module.exports = { appAudioTarget, normDir, appSessions, sessionTargets, createAppSessions, FRESH_MS };
