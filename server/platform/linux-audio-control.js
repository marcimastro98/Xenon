'use strict';
// Sound on Linux: the rows the mixer shows, the commands that change a volume, and whether a
// sound tool is there.

const { held } = require('./linux-held.js');
const {
  audioRun, pwNodes, buildAudioRows, AUDIO_ROWS_TTL_MS, resolveTargets, AUDIO_PROBE_RETRY_MS,
} = require('./linux-audio.js');

async function audioRows() {
  const now = Date.now();
  if (held.audioRowsCache.rows && (now - held.audioRowsCache.at) < AUDIO_ROWS_TTL_MS) {
    return held.audioRowsCache.rows;
  }
  const rows = buildAudioRows(await pwNodes());
  held.audioRowsCache = { rows, at: Date.now() };
  return rows;
}

// Map one SoundVolumeView invocation onto wpctl. args mirror the SVV CLI.
// Throws when the target matched nothing, so the caller reports a failure
// rather than confirming an action that never reached the audio server.
async function audioCommand(args) {
  const list = Array.isArray(args) ? args : [];
  const action = list[0];
  if (action === '/scomma') return; // reads are served by audioRows()
  const n = await pwNodes();
  const ids = resolveTargets(n, list[1]);
  if (!ids.length) throw new Error(`no audio node matches "${list[1]}"`);
  // Drop the cached rows: a volume or mute change must be visible on the very
  // next read, not up to a TTL later.
  held.audioRowsCache = { rows: null, at: 0 };
  for (const id of ids) {
    if (action === '/SetVolume') {
      const pct = Math.max(0, Math.min(100, parseInt(list[2], 10) || 0));
      await audioRun('wpctl', ['set-volume', String(id), (pct / 100).toFixed(3)], 3000);
    } else if (action === '/ChangeVolume') {
      const step = parseInt(list[2], 10) || 0;
      await audioRun('wpctl', ['set-volume', String(id), `${Math.abs(step) / 100}${step < 0 ? '-' : '+'}`], 3000);
    } else if (action === '/Mute') {
      await audioRun('wpctl', ['set-mute', String(id), '1'], 3000);
    } else if (action === '/Unmute') {
      await audioRun('wpctl', ['set-mute', String(id), '0'], 3000);
    } else if (action === '/Switch') {
      await audioRun('wpctl', ['set-mute', String(id), 'toggle'], 3000);
    } else if (action === '/SetDefault') {
      await audioRun('wpctl', ['set-default', String(id)], 3000);
    } else {
      throw new Error(`unsupported audio action "${action}"`);
    }
  }
}

async function audioAvailable() {
  if (held.audioProbe !== null) {
    const ok = await held.audioProbe;
    if (ok || Date.now() - held.audioProbeAt <= AUDIO_PROBE_RETRY_MS) return ok;
  }
  held.audioProbeAt = Date.now();
  held.audioProbe = pwNodes().then(() => true).catch(() => false);
  return held.audioProbe;
}

module.exports = { audioRows, audioCommand, audioAvailable };
