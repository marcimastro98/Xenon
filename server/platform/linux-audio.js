'use strict';
// Linux sound through PipeWire: what pw-dump lists turned into the rows the volume mixer draws,
// and which node a volume command is aimed at.

const { execFile } = require('node:child_process');

// --- Audio: PipeWire (pw-dump for reads, wpctl for writes) ------------------
// Xenon's audio mixer drives everything through SoundVolumeView.exe (a Windows
// NirSoft tool). We reproduce two things:
//   - audioRows()     -> rows in SoundVolumeView's /scomma column layout (the
//     F.* indices), so _getAudioInfoRaw() and /audio/apps work unchanged.
//   - audioCommand()  -> translates one SoundVolumeView invocation (/SetVolume,
//     /ChangeVolume, /Mute, /Unmute, /Switch, /SetDefault) into wpctl.
//
// Volumes come out of the pw-dump payload itself rather than a wpctl call per
// node. Note the scale: PipeWire stores CUBIC volume in channelVolumes, and
// what wpctl prints (and what the user sees) is its cube root. Reading
// channelVolumes directly without the cbrt would report 7% for a sink actually
// sitting at 42%.
const cubicToLinear = (v) => Math.cbrt(Math.max(0, Number(v) || 0));

function audioEnv() {
  const env = { ...process.env };
  if (!env.XDG_RUNTIME_DIR) {
    try { env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`; } catch { /* no getuid */ }
  }
  return env;
}
function audioRun(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, env: audioEnv(), windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || ''));
    });
  });
}

// Parse a pw-dump payload into the audio nodes we care about, with volume.
function parsePwDump(raw) {
  let dump;
  try { dump = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(dump)) return null;

  let defSink = '';
  let defSource = '';
  const sinks = [];
  const sources = [];
  const outStreams = [];
  const inStreams = [];

  for (const o of dump) {
    if (o && o.type === 'PipeWire:Interface:Metadata' &&
        o.props && o.props['metadata.name'] === 'default') {
      for (const m of (o.metadata || [])) {
        if (m.key === 'default.audio.sink' && m.value) defSink = m.value.name || '';
        if (m.key === 'default.audio.source' && m.value) defSource = m.value.name || '';
      }
    }
    if (!o || o.type !== 'PipeWire:Interface:Node') continue;
    const info = o.info || {};
    const p = info.props || {};
    const cls = p['media.class'];

    // Volume + mute live in the Props param on the node itself.
    let volume = 0;
    let muted = false;
    const propsParam = ((info.params || {}).Props || [])[0];
    if (propsParam) {
      muted = propsParam.mute === true;
      const cv = propsParam.channelVolumes;
      if (Array.isArray(cv) && cv.length) volume = Math.round(cubicToLinear(cv[0]) * 100);
      else if (propsParam.volume != null) volume = Math.round(cubicToLinear(propsParam.volume) * 100);
    }

    const node = {
      id: o.id,
      name: p['node.name'] || '',
      desc: p['node.description'] || p['node.nick'] || p['node.name'] || 'Audio device',
      appName: p['application.name'] || '',
      binary: p['application.process.binary'] || '',
      pid: p['application.process.id'] || '',
      mediaName: p['media.name'] || '',
      running: info.state === 'running',
      volume,
      muted,
    };
    if (cls === 'Audio/Sink') sinks.push(node);
    else if (cls === 'Audio/Source' && !node.name.endsWith('.monitor')) sources.push(node);
    else if (cls === 'Stream/Output/Audio') outStreams.push(node);
    else if (cls === 'Stream/Input/Audio') inStreams.push(node);
  }
  return { defSink, defSource, sinks, sources, outStreams, inStreams };
}

async function pwNodes() {
  // Let the spawn failure propagate: a missing pw-dump must surface as "audio
  // unavailable", not as an empty (but apparently working) mixer.
  const parsed = parsePwDump(await audioRun('pw-dump', [], 5000));
  if (!parsed) throw new Error('pw-dump returned unparseable output');
  return parsed;
}

// SoundVolumeView /scomma column indices (see the F.* map in server.js).
const F = { NAME: 0, TYPE: 1, DIR: 2, DEVICE_NAME: 3, DEFAULT: 4, STATE: 7, MUTED: 8, VOL_PCT: 10, CLI_ID: 18, PROC_PATH: 19, PROC_ID: 20, WINDOW_TITLE: 21 };

// Build rows matching SoundVolumeView's /scomma layout from parsed pw-dump data.
function buildAudioRows(n) {
  const rows = [];
  const row = () => new Array(22).fill('');

  const addDevice = (node, dir, isDefault) => {
    const r = row();
    r[F.NAME] = node.desc;
    r[F.TYPE] = 'Device';
    r[F.DIR] = dir; // Render | Capture
    r[F.DEVICE_NAME] = node.desc;
    r[F.DEFAULT] = isDefault ? dir : '';
    r[F.STATE] = 'Active';
    r[F.MUTED] = node.muted ? 'Yes' : 'No';
    r[F.VOL_PCT] = String(node.volume);
    r[F.CLI_ID] = String(node.id);
    rows.push(r);
  };
  const addApp = (node, dir) => {
    const r = row();
    // Bare binary name (no path separator) so server's split('\\').pop() yields it.
    const proc = node.binary || (node.appName || 'app').toLowerCase().replace(/\s+/g, '');
    r[F.NAME] = node.appName || proc;
    r[F.TYPE] = 'Application';
    r[F.DIR] = dir;
    r[F.STATE] = 'Active';
    r[F.MUTED] = node.muted ? 'Yes' : 'No';
    r[F.VOL_PCT] = String(node.volume);
    r[F.CLI_ID] = String(node.id);
    r[F.PROC_PATH] = proc; // durable target; audioCommand maps "<proc>.exe" back
    r[F.PROC_ID] = String(node.pid || '');
    r[F.WINDOW_TITLE] = node.mediaName || '';
    rows.push(r);
  };

  n.sinks.forEach((s) => addDevice(s, 'Render', s.name === n.defSink));
  n.sources.forEach((s) => addDevice(s, 'Capture', s.name === n.defSource));
  n.outStreams.forEach((s) => addApp(s, 'Render'));
  n.inStreams.forEach((s) => addApp(s, 'Capture'));
  return rows;
}

// A stopped stream is an app with its output open and no sound: paused, as on Windows.
function markStopped(rows, outStreams) {
  const stopped = new Set(outStreams.filter((stream) => !stream.running).map((stream) => String(stream.id)));
  return rows.map((row) => {
    if (row[F.TYPE] !== 'Application' || row[F.DIR] !== 'Render' || !stopped.has(row[F.CLI_ID])) return row;
    const copy = [...row];
    copy[F.STATE] = 'Inactive';
    return copy;
  });
}

// Rows are rebuilt at most this often: several dashboard surfaces can ask for
// audio on the same tick, and each rebuild forks pw-dump.
const AUDIO_ROWS_TTL_MS = 900;

// A paused player keeps its stream open and the mixer still lists it; only a running
// stream is sound coming out.
async function soundingRows() {
  const nodes = await pwNodes();
  return markStopped(buildAudioRows(nodes), nodes.outStreams);
}

// Resolve a SoundVolumeView write target to one or more PipeWire node ids.
function resolveTargets(n, target) {
  const t = String(target || '').trim();
  if (/^\d+$/.test(t)) return [Number(t)];
  if (t === 'DefaultCaptureDevice' || t === 'DefaultRenderDevice') {
    const capture = t === 'DefaultCaptureDevice';
    const want = capture ? n.defSource : n.defSink;
    const list = capture ? n.sources : n.sinks;
    const hit = list.find((x) => x.name === want);
    return hit ? [hit.id] : [];
  }
  // App target: "<binary>.exe" or a bare name -> every matching stream node.
  const name = t.replace(/\.exe$/i, '').toLowerCase();
  // An empty name must match NOTHING. The substring fallback below ends in
  // `.includes(name)`, and `''.includes('')` is true, so a blank target used to
  // select every stream on the machine — a `/audio/app/mute` with proc="   " or
  // any svvExec fired before cachedSpeakerId was resolved would have muted the
  // whole system. The caller turns an empty list into a reported failure, which
  // is what the two sibling collectors do with the same input.
  if (!name) return [];
  return [...n.outStreams, ...n.inStreams]
    .filter((s) => (s.binary || '').toLowerCase() === name ||
                   (s.appName || '').toLowerCase().replace(/\s+/g, '') === name ||
                   (s.appName || '').toLowerCase().includes(name))
    .map((s) => s.id);
}

// Cheap capability probe for /actions: is a usable PipeWire mixer present?
// A YES is cached forever, a NO only for a cooldown: the backend's login
// service can win the race against PipeWire at session start, and a failure
// cached for the whole uptime would hide every audio Deck key until the next
// reboot — "not ready yet" and "not installed" are indistinguishable here, so
// only the answer that cannot change is allowed to stick.
const AUDIO_PROBE_RETRY_MS = 60000;

module.exports = {
  cubicToLinear, audioEnv, audioRun, parsePwDump, pwNodes, F, buildAudioRows, markStopped,
  AUDIO_ROWS_TTL_MS, soundingRows, resolveTargets, AUDIO_PROBE_RETRY_MS,
};
