'use strict';
// Sound on macOS: the devices, the rows the mixer shows, and the commands that change a volume
// or the output.

const { runSoft } = require('./darwin-read.js');
const { held } = require('./darwin-held.js');
const { osa, osaWrite } = require('./darwin-apps.js');
const {
  parseVolumeSettings, parseAudioDevices, AUDIO_DEVICES_TTL_MS, buildAudioRows,
  SAS_MISSING_RETRY_MS, withCurrentOutput, AUDIO_ROWS_TTL_MS, isCaptureTarget, AUDIO_PROBE_RETRY_MS,
} = require('./darwin-audio.js');

function audioDevices() {
  const fresh = held.audioDevicesCache.data && (Date.now() - held.audioDevicesCache.at) < AUDIO_DEVICES_TTL_MS;
  if (fresh) return Promise.resolve(held.audioDevicesCache.data);
  if (!held.audioDevicesInFlight) {
    held.audioDevicesInFlight = runSoft('system_profiler', ['SPAudioDataType', '-json'], 15000)
      .then((out) => {
        const data = out === null ? { outputs: [], inputs: [] } : parseAudioDevices(out);
        held.audioDevicesCache = { data, at: Date.now() };
        return data;
      })
      .catch(() => ({ outputs: [], inputs: [] }))
      .finally(() => { held.audioDevicesInFlight = null; });
  }
  return held.audioDevicesInFlight;
}


async function currentOutputName() {
  if (held.sasMissingAt && Date.now() - held.sasMissingAt < SAS_MISSING_RETRY_MS) return null;
  const out = await runSoft('SwitchAudioSource', ['-c', '-t', 'output'], 3000);
  if (out === null) { held.sasMissingAt = Date.now(); return null; }
  held.sasMissingAt = 0;
  return String(out).trim() || null;
}

async function audioRows() {
  const now = Date.now();
  if (held.audioRowsCache.rows && (now - held.audioRowsCache.at) < AUDIO_ROWS_TTL_MS) {
    return held.audioRowsCache.rows;
  }
  const settings = await osa('get volume settings', 5000);
  // Let a failed read surface: an empty-but-working mixer would be a lie.
  if (settings === null) throw new Error('osascript volume read failed');
  const devices = withCurrentOutput(await audioDevices(), await currentOutputName());
  const rows = buildAudioRows(devices, parseVolumeSettings(settings));
  held.audioRowsCache = { rows, at: Date.now() };
  return rows;
}

// Map one SoundVolumeView invocation onto osascript. args mirror the SVV CLI.
// Throws when the action cannot be performed, so the caller reports a failure
// rather than confirming something that never reached Core Audio.
async function audioCommand(args) {
  const list = Array.isArray(args) ? args : [];
  const action = list[0];
  if (action === '/scomma') return; // reads are served by audioRows()

  const target = String(list[1] || '').trim();
  // A per-app target is the one thing this backend genuinely cannot do; saying
  // so is better than moving the whole system's volume instead.
  if (/\.exe$/i.test(target)) throw new Error('per-app audio needs the native mac helper');

  const devices = await audioDevices();
  const capture = isCaptureTarget(target, devices);
  const scope = capture ? 'input volume' : 'output volume';
  // A level change must be visible on the very next read, not up to a TTL later.
  held.audioRowsCache = { rows: null, at: 0 };

  if (action === '/SetVolume') {
    // The absolute actions need no read-back, and a Deck key held down would
    // otherwise pay for two osascript spawns per repeat instead of one.
    const pct = Math.max(0, Math.min(100, parseInt(list[2], 10) || 0));
    if (capture && pct > 0) held.lastInputVolume = pct;
    await osaWrite(`set volume ${scope} ${pct}`, 5000);
    return;
  }

  // A failed read here is not fatal on its own: the write below is what must
  // report failure, and a null read degrades to a 0 baseline.
  const current = parseVolumeSettings(await osa('get volume settings', 5000) || '');
  const level = capture ? current.input : current.output;

  if (action === '/ChangeVolume') {
    const step = parseInt(list[2], 10) || 0;
    const next = Math.max(0, Math.min(100, (level || 0) + step));
    if (capture && next > 0) held.lastInputVolume = next;
    await osaWrite(`set volume ${scope} ${next}`, 5000);
    return;
  }
  if (action === '/Mute' || action === '/Unmute' || action === '/Switch') {
    const muted = capture ? (level === 0) : current.muted;
    const wantMuted = action === '/Switch' ? !muted : action === '/Mute';
    if (capture) {
      if (wantMuted && level > 0) held.lastInputVolume = level;
      await osaWrite(`set volume input volume ${wantMuted ? 0 : held.lastInputVolume}`, 5000);
    } else {
      await osaWrite(`set volume ${wantMuted ? 'with' : 'without'} output muted`, 5000);
    }
    return;
  }
  if (action === '/SetDefault') {
    // Switching the default device is a Core Audio write with no osascript
    // equivalent. SwitchAudioSource (brew install switchaudio-osx) is the
    // standard shim; without it the action fails honestly.
    const out = await runSoft('SwitchAudioSource',
      ['-t', capture ? 'input' : 'output', '-s', target], 5000);
    if (out === null) throw new Error('device switching needs SwitchAudioSource (brew install switchaudio-osx)');
    held.audioDevicesCache = { data: null, at: 0 };
    return;
  }
  throw new Error(`unsupported audio action "${action}"`);
}

async function audioAvailable() {
  if (held.audioProbe !== null) {
    const ok = await held.audioProbe;
    if (ok || Date.now() - held.audioProbeAt <= AUDIO_PROBE_RETRY_MS) return ok;
  }
  held.audioProbeAt = Date.now();
  held.audioProbe = osa('get volume settings', 5000).then((out) => out !== null);
  return held.audioProbe;
}

module.exports = { audioDevices, currentOutputName, audioRows, audioCommand, audioAvailable };
