// linux-collectors.js - Linux data sources for Xenon's Windows-only collectors.
//
// Xenon is Windows-first: its GPU / disk / CPU-temperature / network collectors
// shell out to PowerShell and WMI (gpu.ps1, network.ps1, Get-CimInstance ...),
// the app switcher drives a Win32 EnumWindows helper, and the volume mixer
// drives SoundVolumeView.exe. None of those exist on Linux, so the system tiles
// render "--", the app switcher reports "No open windows found", and the mixer
// reports "audio unavailable".
//
// This module provides native Linux equivalents (nvidia-smi, df,
// /sys/class/hwmon, /proc/net/dev, ping, wmctrl/xdotool/xprop, PipeWire) that
// return the SAME shapes the Windows collectors produced, so the existing
// caching, merge, bandwidth-delta and CSV-column logic in server.js is
// untouched. server.js only calls in when process.platform === 'linux'; the
// Windows code paths are unchanged.
//
// Everything here is async: these run on the SSE sensor path, so there is no
// synchronous filesystem access anywhere in this file.
//
// Requirements on Linux (each degrades to the previous "--" behaviour if the
// tool is absent): nvidia-smi for GPU, wmctrl + xdotool + x11-utils for the app
// switcher (X11 sessions), pipewire + wireplumber (pw-dump, wpctl) for audio.

'use strict';

const { execFile } = require('child_process');
const fsp = require('fs').promises;

// Promise wrapper around execFile with a hard timeout; resolves stdout.
function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || ''));
    });
  });
}

const isNum = (s) => /^-?\d+(\.\d+)?$/.test(String(s).trim());

// Split on LF or CRLF. Worth being explicit about why: `\r` counts as a line
// terminator in JS regex, so `.` does not match it, and a pattern anchored with
// `$` fails on a CRLF line entirely instead of merely capturing a trailing
// character. These parsers read tool output on Linux, but the fixtures behind
// them are files that a Windows checkout can convert, so the parsers accept both.
const splitLines = (text) => String(text || '').split(/\r?\n/);

// Run an async mapper over items with at most `limit` in flight. Promise.all on
// a whole window list forks that many processes at once; a desktop with many
// windows would spike to one xprop per window in a single tick.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// --- GPU: nvidia-smi, matching gpu.ps1's field order and byte units ----------
// gpu.ps1 queried: utilization.gpu,temperature.gpu,memory.used,memory.total,name
// and converted MiB -> bytes (value * 1048576). We reproduce that exactly.
// KNOWN LIMIT: NVIDIA only. AMD (amdgpu) and Intel expose their counters through
// sysfs rather than a query tool, so those cards still report nulls here.
const EMPTY_GPU = { gpu: null, gpuTemp: null, gpuName: null, vramUsed: null, vramTotal: null };
function parseGpu(out) {
  const first = splitLines(String(out || '').trim())[0] || '';
  const p = first.split(',').map((s) => s.trim());
  if (p.length < 5) return { ...EMPTY_GPU };
  return {
    gpu: isNum(p[0]) ? Math.round(Number(p[0])) : null,
    gpuTemp: isNum(p[1]) ? Math.round(Number(p[1])) : null,
    vramUsed: isNum(p[2]) ? Math.round(Number(p[2])) * 1048576 : null,
    vramTotal: isNum(p[3]) ? Math.round(Number(p[3])) * 1048576 : null,
    gpuName: p.slice(4).join(', ').trim() || null,
  };
}
async function gpu() {
  try {
    return parseGpu(await run('nvidia-smi',
      ['--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,name',
       '--format=csv,noheader,nounits'], 5000));
  } catch {
    return { ...EMPTY_GPU };
  }
}

// --- Disks: df, matching getAllDisksInfo()'s drive object shape --------------
// Real filesystems only: skip pseudo/virtual mounts (tmpfs, overlay, snap loops,
// docker). /boot/efi is kept as it is a genuine volume. Bytes throughout.
const PSEUDO_FS = new Set([
  'tmpfs', 'devtmpfs', 'sysfs', 'proc', 'cgroup', 'cgroup2', 'overlay', 'squashfs',
  'efivarfs', 'devpts', 'mqueue', 'hugetlbfs', 'debugfs', 'tracefs', 'fusectl',
  'configfs', 'securityfs', 'pstore', 'bpf', 'autofs', 'binfmt_misc', 'ramfs',
  'nsfs', 'fuse.portal', 'fuse.gvfsd-fuse',
]);
function skipMount(target) {
  return target.startsWith('/snap/') || target.startsWith('/var/lib/docker') ||
         target.startsWith('/proc') || target.startsWith('/sys') ||
         target.startsWith('/dev') || target.startsWith('/run');
}
// Split out so the parsing is unit-testable against a captured `df` fixture.
function parseDisks(out) {
  const lines = splitLines(String(out || '').trim()).slice(1); // drop header
  const seen = new Set();
  const drives = [];
  for (const line of lines) {
    const c = line.trim().split(/\s+/);
    if (c.length < 6) continue;
    const [source, target, fstype] = c;
    const total = Number(c[3]);
    const used = Number(c[4]);
    const free = Number(c[5]);
    if (PSEUDO_FS.has(fstype) || fstype.startsWith('fuse.')) continue;
    if (skipMount(target)) continue;
    if (!(total > 0)) continue;
    // Key on the pair, not the device. A btrfs (or LVM-thin, or ZFS) layout
    // mounts several subvolumes from ONE source, so deduping on source alone
    // silently drops every mount after the first: on the common
    // /-plus-/home-on-one-device setup, /home disappeared entirely. The pair
    // still collapses a genuinely repeated row. Note that sibling subvolumes
    // share one pool, so their capacities are the same filesystem counted once
    // per mount, not independent space.
    const key = source + '\0' + target;
    if (seen.has(key)) continue;
    seen.add(key);
    const removable = target.startsWith('/media') || target.startsWith('/mnt') ||
                      target.includes('/run/media');
    drives.push({
      drive: target,
      total,
      used,
      free,
      percent: Math.round((used / total) * 100),
      label: target === '/' ? 'System' : target.split('/').filter(Boolean).pop() || '',
      fileSystem: fstype,
      driveType: removable ? 'Removable' : 'Fixed',
    });
  }
  return drives;
}
async function disks() {
  try {
    const out = await run('df', ['-B1', '--output=source,target,fstype,size,used,avail'], 5000);
    const drives = parseDisks(out);
    return drives.length ? drives : null;
  } catch {
    return null;
  }
}

// --- CPU temperature: k10temp/coretemp under /sys/class/hwmon ----------------
// Returns { cpuTemp: number|null } to match the CPU_TEMP_SCRIPT collector.
const readText = async (p) => (await fsp.readFile(p, 'utf8')).trim();
async function cpuTemp() {
  try {
    const base = '/sys/class/hwmon';
    for (const d of await fsp.readdir(base)) {
      const dir = `${base}/${d}`;
      let name = '';
      try { name = await readText(`${dir}/name`); } catch { continue; }
      if (name !== 'k10temp' && name !== 'coretemp') continue;
      for (let i = 1; i <= 8; i++) {
        let raw;
        try { raw = await readText(`${dir}/temp${i}_input`); } catch { continue; }
        let label = '';
        try { label = await readText(`${dir}/temp${i}_label`); } catch { /* unlabelled */ }
        if (/Tctl|Tdie|Tccd|Package|Core 0/i.test(label) || i === 1) {
          const milli = Number(raw);
          if (Number.isFinite(milli)) return { cpuTemp: Math.round((milli / 1000) * 10) / 10 };
        }
      }
    }
  } catch { /* no hwmon, or unreadable */ }
  return { cpuTemp: null };
}

// --- Network: ping (1.1.1.1) + /proc/net/dev, matching network.ps1 shape -----
// Returns { ping, latency, rxBytes, txBytes, fps, gpuLatency }. server.js turns
// the rx/tx byte counters into down/up bandwidth via its own inter-poll delta.
// Physical NICs only: skip loopback, containers, bridges, tunnels, VPNs.
const VIRTUAL_IFACE = /^(lo|veth|docker|br-|virbr|tun|tap|wg|vmnet|vboxnet|zt|ppp|bond|dummy)/;
function parseNetDev(text) {
  let rx = 0;
  let tx = 0;
  const lines = splitLines(text).slice(2);
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const iface = line.slice(0, idx).trim();
    if (VIRTUAL_IFACE.test(iface)) continue;
    const f = line.slice(idx + 1).trim().split(/\s+/);
    if (f.length < 9) continue;
    rx += Number(f[0]) || 0;  // Receive bytes
    tx += Number(f[8]) || 0;  // Transmit bytes
  }
  return { rx, tx };
}
async function readNetBytes() {
  try {
    return parseNetDev(await fsp.readFile('/proc/net/dev', 'utf8'));
  } catch {
    return { rx: 0, tx: 0 };
  }
}
// ping's summary line gives min/avg/max/mdev; ping=avg, latency=jitter (max-min),
// the same two numbers network.ps1 derives from its three echoes.
function parsePing(out) {
  const m = String(out || '').match(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\s*ms/);
  if (!m) return { ping: null, latency: null };
  return { ping: Math.round(Number(m[2])), latency: Math.round(Number(m[3]) - Number(m[1])) };
}
async function pingStats() {
  try {
    return parsePing(await run('ping', ['-c', '3', '-W', '1', '-n', '1.1.1.1'], 5000));
  } catch {
    return { ping: null, latency: null };
  }
}
async function network() {
  const [{ ping, latency }, { rx, tx }] = await Promise.all([pingStats(), readNetBytes()]);
  return { ping, latency, rxBytes: rx, txBytes: tx, fps: null, gpuLatency: null };
}

// --- Open windows / app switcher: wmctrl + xdotool (X11) --------------------
// Xenon's /windows endpoint (list/focus/close) drives its "Open applications"
// widget through a Windows helper (windows.ps1, Win32 EnumWindows). We reproduce
// the same JSON contract the PowerShell path emits:
//   list  -> { windows: [ { id, title, app, path, active, minimized, icon } ] }
//   focus -> { ok }
//   close -> { ok, app, path }  (or { ok:false, error:'protected'|'not_found' })
// ids are DECIMAL strings (server.js validates /^\d{1,24}$/), matching the HWND
// contract; here they are the X11 window id in decimal.
//
// KNOWN LIMIT: X11 only. Wayland has no equivalent unprivileged window-listing
// protocol, so this returns an empty list under a Wayland session.
const MAX_WINDOWS = 24;
// At most this many xprop processes in flight at once.
const XPROP_CONCURRENCY = 8;

// Ensure X access even when the server was launched without a session env.
function xEnv() {
  const env = { ...process.env };
  if (!env.DISPLAY) env.DISPLAY = ':0';
  if (!env.XAUTHORITY) {
    try { env.XAUTHORITY = `/run/user/${process.getuid()}/gdm/Xauthority`; } catch { /* no getuid */ }
  }
  return env;
}
function runX(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, env: xEnv(), windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''));
    });
  });
}

// WM_CLASS classes we never surface/close: the desktop shell itself.
const PROTECTED_CLASSES = new Set(['gnome-shell', 'Gnome-shell', 'xfdesktop', 'plasmashell']);

async function appFromExe(pid) {
  try {
    const exe = await fsp.readlink(`/proc/${pid}/exe`);
    return { path: exe, name: exe.split('/').filter(Boolean).pop() || '' };
  } catch {
    return { path: '', name: '' };
  }
}

// wmctrl -lp: "<id> <desktop> <pid> <host> <title...>". host is one token, so
// the first four fields are unambiguous and the remainder is the title.
function parseWmctrl(raw) {
  const rows = [];
  for (const line of splitLines(raw)) {
    const m = line.match(/^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
    if (!m) continue;
    const title = (m[5] || '').trim();
    if (!title) continue; // untitled utility/override-redirect windows
    rows.push({ hexId: m[1], pid: m[3], title, dec: parseInt(m[1], 16) });
  }
  return rows;
}

// WM_CLASS(STRING) = "instance", "Class" -> take the Class (2nd) string.
function parseWindowProps(out) {
  const minimized = !!(out && out.includes('_NET_WM_STATE_HIDDEN'));
  let cls = '';
  if (out) {
    const m = out.match(/WM_CLASS\(STRING\)\s*=\s*"(?:[^"]*)",\s*"([^"]*)"/) ||
              out.match(/WM_CLASS\(STRING\)\s*=\s*"([^"]*)"/);
    if (m) cls = m[1];
  }
  return { minimized, cls };
}
async function windowProps(hexId) {
  return parseWindowProps(await runX('xprop', ['-id', hexId, 'WM_CLASS', '_NET_WM_STATE'], 3000));
}

async function listWindows() {
  const [raw, activeRaw] = await Promise.all([
    runX('wmctrl', ['-lp'], 5000),
    runX('xdotool', ['getactivewindow'], 3000),
  ]);
  if (!raw) return { windows: [] };
  const activeDec = activeRaw ? Number(String(activeRaw).trim()) : -1;

  const rows = parseWmctrl(raw);
  // Resolve the executable first: /proc readlink is cheap and needs no process.
  // Sorting and capping on that name means we spawn xprop for at most
  // MAX_WINDOWS windows instead of one per window on the whole desktop.
  const withExe = await Promise.all(rows.map(async (r) => ({
    ...r, exe: await appFromExe(r.pid), active: r.dec === activeDec,
  })));
  withExe.sort((a, b) =>
    (b.active - a.active) ||
    a.exe.name.localeCompare(b.exe.name) ||
    a.title.localeCompare(b.title));
  const capped = withExe.slice(0, MAX_WINDOWS);

  const props = await mapLimit(capped, XPROP_CONCURRENCY, (r) => windowProps(r.hexId));
  const windows = [];
  capped.forEach((r, i) => {
    const p = props[i];
    if (PROTECTED_CLASSES.has(p.cls)) return; // hide the desktop shell
    windows.push({
      id: String(r.dec),
      title: r.title,
      app: p.cls || r.exe.name || 'App',
      path: r.exe.path,
      active: r.active,
      minimized: p.minimized,
      icon: null, // no icon extraction on Linux; the UI falls back to an initial
    });
  });

  // Re-sort on the final labels (WM_CLASS is nicer than the binary name), which
  // is the ordering the PowerShell path emits: active first, then app, then title.
  windows.sort((a, b) =>
    (b.active - a.active) ||
    a.app.localeCompare(b.app) ||
    a.title.localeCompare(b.title));
  return { windows };
}

async function focusWindow(decId) {
  const ok = await runX('xdotool', ['windowactivate', String(decId)], 5000);
  return { ok: ok !== null };
}

async function closeWindow(decId) {
  const hex = '0x' + Number(decId).toString(16);
  const pid = (await runX('xdotool', ['getwindowpid', String(decId)], 3000) || '').trim();
  const exe = pid ? await appFromExe(pid) : { path: '', name: '' };
  const props = await windowProps(hex);
  if (PROTECTED_CLASSES.has(props.cls)) {
    return { ok: false, error: 'protected', app: props.cls };
  }
  // wmctrl -c sends the EWMH _NET_CLOSE_WINDOW request: a graceful close the app
  // can still veto (save prompt), mirroring the Windows CloseMainWindow path.
  const out = await runX('wmctrl', ['-i', '-c', hex], 5000);
  return { ok: out !== null, app: props.cls || exe.name || '', path: exe.path };
}

async function windows(action, id) {
  if (action === 'focus') return focusWindow(id);
  if (action === 'close') return closeWindow(id);
  return listWindows();
}

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

// Rows are rebuilt at most this often: several dashboard surfaces can ask for
// audio on the same tick, and each rebuild forks pw-dump.
const AUDIO_ROWS_TTL_MS = 900;
let audioRowsCache = { rows: null, at: 0 };

async function audioRows() {
  const now = Date.now();
  if (audioRowsCache.rows && (now - audioRowsCache.at) < AUDIO_ROWS_TTL_MS) {
    return audioRowsCache.rows;
  }
  const rows = buildAudioRows(await pwNodes());
  audioRowsCache = { rows, at: Date.now() };
  return rows;
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
  return [...n.outStreams, ...n.inStreams]
    .filter((s) => (s.binary || '').toLowerCase() === name ||
                   (s.appName || '').toLowerCase().replace(/\s+/g, '') === name ||
                   (s.appName || '').toLowerCase().includes(name))
    .map((s) => s.id);
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
  audioRowsCache = { rows: null, at: 0 };
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

// Cheap capability probe for /actions: is a usable PipeWire mixer present?
let _audioProbe = null;
async function audioAvailable() {
  if (_audioProbe === null) {
    _audioProbe = pwNodes().then(() => true).catch(() => false);
  }
  return _audioProbe;
}

module.exports = {
  gpu, disks, cpuTemp, network, windows, audioRows, audioCommand, audioAvailable,
  // exported for unit tests
  parseGpu, parseDisks, parseNetDev, parsePing, parseWmctrl, parseWindowProps,
  parsePwDump, buildAudioRows, resolveTargets, cubicToLinear,
};
