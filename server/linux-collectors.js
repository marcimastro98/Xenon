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
// Requirements on Linux (each degrades to the previous "--" behaviour if the
// tool is absent): nvidia-smi for GPU, wmctrl + xdotool + x11-utils for the app
// switcher (X11 sessions), pipewire + wireplumber (pw-dump, wpctl) for audio.

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');

// Promise wrapper around execFile with a hard timeout; resolves stdout (never
// rejects for our callers - collectors degrade to null on any failure).
function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || ''));
    });
  });
}

const isNum = (s) => /^-?\d+(\.\d+)?$/.test(String(s).trim());

// --- GPU: nvidia-smi, matching gpu.ps1's field order and byte units ----------
// gpu.ps1 queried: utilization.gpu,temperature.gpu,memory.used,memory.total,name
// and converted MiB -> bytes (value * 1048576). We reproduce that exactly.
async function gpu() {
  try {
    const out = await run('nvidia-smi',
      ['--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,name',
       '--format=csv,noheader,nounits'], 5000);
    const first = out.trim().split('\n')[0] || '';
    const p = first.split(',').map((s) => s.trim());
    if (p.length < 5) return { gpu: null, gpuTemp: null, gpuName: null, vramUsed: null, vramTotal: null };
    return {
      gpu: isNum(p[0]) ? Math.round(Number(p[0])) : null,
      gpuTemp: isNum(p[1]) ? Math.round(Number(p[1])) : null,
      vramUsed: isNum(p[2]) ? Math.round(Number(p[2])) * 1048576 : null,
      vramTotal: isNum(p[3]) ? Math.round(Number(p[3])) * 1048576 : null,
      gpuName: p.slice(4).join(', ').trim() || null,
    };
  } catch {
    return { gpu: null, gpuTemp: null, gpuName: null, vramUsed: null, vramTotal: null };
  }
}

// --- Disks: df, matching getAllDisksInfo()'s drive object shape --------------
// Real filesystems only: skip pseudo/virtual mounts (tmpfs, overlay, snap loops,
// docker, /boot/efi noise is kept as it is a genuine volume). Bytes throughout.
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
async function disks() {
  try {
    const out = await run('df',
      ['-B1', '--output=source,target,fstype,size,used,avail'], 5000);
    const lines = out.trim().split('\n').slice(1); // drop header
    const seen = new Set();
    const drives = [];
    for (const line of lines) {
      const c = line.trim().split(/\s+/);
      if (c.length < 6) continue;
      const source = c[0];
      const target = c[1];
      const fstype = c[2];
      const total = Number(c[3]);
      const used = Number(c[4]);
      const free = Number(c[5]);
      if (PSEUDO_FS.has(fstype) || fstype.startsWith('fuse.')) continue;
      if (skipMount(target)) continue;
      if (!(total > 0)) continue;
      if (seen.has(source)) continue; // dedupe bind mounts / btrfs subvolumes
      seen.add(source);
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
    return drives.length ? drives : null;
  } catch {
    return null;
  }
}

// --- CPU temperature: k10temp/coretemp under /sys/class/hwmon ----------------
// Returns { cpuTemp: number|null } to match the CPU_TEMP_SCRIPT collector.
function cpuTemp() {
  try {
    const base = '/sys/class/hwmon';
    for (const d of fs.readdirSync(base)) {
      const dir = `${base}/${d}`;
      let name = '';
      try { name = fs.readFileSync(`${dir}/name`, 'utf8').trim(); } catch { continue; }
      if (name !== 'k10temp' && name !== 'coretemp') continue;
      for (let i = 1; i <= 8; i++) {
        const input = `${dir}/temp${i}_input`;
        if (!fs.existsSync(input)) continue;
        let label = '';
        try { label = fs.readFileSync(`${dir}/temp${i}_label`, 'utf8').trim(); } catch { }
        if (/Tctl|Tdie|Tccd|Package|Core 0/i.test(label) || i === 1) {
          const milli = Number(fs.readFileSync(input, 'utf8').trim());
          if (Number.isFinite(milli)) return { cpuTemp: Math.round((milli / 1000) * 10) / 10 };
        }
      }
    }
  } catch { }
  return { cpuTemp: null };
}

// --- Network: ping (1.1.1.1) + /proc/net/dev, matching network.ps1 shape -----
// Returns { ping, latency, rxBytes, txBytes, fps, gpuLatency }. server.js turns
// the rx/tx byte counters into down/up bandwidth via its own inter-poll delta.
function readNetBytes() {
  let rx = 0;
  let tx = 0;
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const iface = line.slice(0, idx).trim();
      // Physical NICs only: skip loopback, containers, bridges, tunnels, VPNs.
      if (/^(lo|veth|docker|br-|virbr|tun|tap|wg|vmnet|vboxnet|zt|ppp|bond|dummy)/.test(iface)) continue;
      const f = line.slice(idx + 1).trim().split(/\s+/);
      if (f.length < 9) continue;
      rx += Number(f[0]) || 0;  // Receive bytes
      tx += Number(f[8]) || 0;  // Transmit bytes
    }
  } catch { }
  return { rx, tx };
}
async function pingStats() {
  try {
    // 3 echoes to 1.1.1.1, mirroring network.ps1. ping's own summary line gives
    // min/avg/max/mdev; ping=avg, latency=jitter (max-min), same as the PS script.
    const out = await run('ping', ['-c', '3', '-W', '1', '-n', '1.1.1.1'], 5000);
    const m = out.match(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\s*ms/);
    if (m) {
      const min = Number(m[1]);
      const avg = Number(m[2]);
      const max = Number(m[3]);
      return { ping: Math.round(avg), latency: Math.round(max - min) };
    }
  } catch { }
  return { ping: null, latency: null };
}
async function network() {
  const [{ ping, latency }, { rx, tx }] = await Promise.all([
    pingStats(), Promise.resolve(readNetBytes()),
  ]);
  return { ping, latency, rxBytes: rx, txBytes: tx, fps: null, gpuLatency: null };
}

// --- Open windows / app switcher: wmctrl + xdotool (X11) --------------------
// Xenon's /windows endpoint (list/focus/close) drives its "Open applications"
// widget through a Windows helper (windows.ps1, Win32 EnumWindows), so on Linux
// it errored ("No open windows found"). We reproduce the same JSON contract the
// PowerShell path emits:
//   list  -> { windows: [ { id, title, app, path, active, minimized, icon } ] }
//   focus -> { ok }
//   close -> { ok, app, path }  (or { ok:false, error:'protected'|'not_found', app })
// ids are DECIMAL strings (server.js validates /^\d{1,24}$/), matching the HWND
// contract; here they are the X11 window id in decimal.

// Ensure X access even when the server was launched without a session env.
function xEnv() {
  const env = { ...process.env };
  if (!env.DISPLAY) env.DISPLAY = ':0';
  if (!env.XAUTHORITY) {
    try { env.XAUTHORITY = `/run/user/${process.getuid()}/gdm/Xauthority`; } catch { }
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

// WM_CLASS classes we never surface/close: the desktop shell and our own kiosk.
const PROTECTED_CLASSES = new Set(['gnome-shell', 'Gnome-shell', 'xfdesktop', 'plasmashell']);

function appFromExe(pid) {
  try {
    const exe = fs.readlinkSync(`/proc/${pid}/exe`);
    return { path: exe, name: exe.split('/').filter(Boolean).pop() || '' };
  } catch {
    return { path: '', name: '' };
  }
}

// One xprop read per window: WM_CLASS (nicer app label) + _NET_WM_STATE (hidden).
async function windowProps(hexId) {
  const out = await runX('xprop', ['-id', hexId, 'WM_CLASS', '_NET_WM_STATE'], 3000);
  const minimized = !!(out && out.includes('_NET_WM_STATE_HIDDEN'));
  let cls = '';
  if (out) {
    // WM_CLASS(STRING) = "instance", "Class"  -> take the Class (2nd) string.
    const m = out.match(/WM_CLASS\(STRING\)\s*=\s*"(?:[^"]*)",\s*"([^"]*)"/) ||
              out.match(/WM_CLASS\(STRING\)\s*=\s*"([^"]*)"/);
    if (m) cls = m[1];
  }
  return { minimized, cls };
}

async function listWindows() {
  const [raw, activeRaw] = await Promise.all([
    runX('wmctrl', ['-lp'], 5000),
    runX('xdotool', ['getactivewindow'], 3000),
  ]);
  if (!raw) return { windows: [] };
  const activeDec = activeRaw ? Number(String(activeRaw).trim()) : -1;

  // wmctrl -lp: "<id> <desktop> <pid> <host> <title...>". host is one token, so
  // the first four fields are unambiguous and the remainder is the title.
  const rows = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
    if (!m) continue;
    const hexId = m[1];
    const pid = m[3];
    const title = (m[5] || '').trim();
    if (!title) continue; // untitled utility/override-redirect windows
    rows.push({ hexId, pid, title, dec: parseInt(hexId, 16) });
  }

  const props = await Promise.all(rows.map((r) => windowProps(r.hexId)));
  const windows = [];
  rows.forEach((r, i) => {
    const p = props[i];
    if (PROTECTED_CLASSES.has(p.cls)) return; // hide the desktop shell
    const exe = appFromExe(r.pid);
    windows.push({
      id: String(r.dec),
      title: r.title,
      app: p.cls || exe.name || 'App',
      path: exe.path,
      active: r.dec === activeDec,
      minimized: p.minimized,
      icon: null, // no icon extraction on Linux; the UI falls back to an initial
    });
  });

  // Match the PowerShell ordering: active first, then app name, then title; cap 24.
  windows.sort((a, b) =>
    (b.active - a.active) ||
    a.app.localeCompare(b.app) ||
    a.title.localeCompare(b.title));
  return { windows: windows.slice(0, 24) };
}

async function focusWindow(decId) {
  const ok = await runX('xdotool', ['windowactivate', String(decId)], 5000);
  return { ok: ok !== null };
}

async function closeWindow(decId) {
  const hex = '0x' + Number(decId).toString(16);
  const pid = (await runX('xdotool', ['getwindowpid', String(decId)], 3000) || '').trim();
  const exe = pid ? appFromExe(pid) : { path: '', name: '' };
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

// --- Audio: PipeWire (pw-dump for reads, wpctl for reads+writes) ------------
// Xenon's audio mixer drives everything through SoundVolumeView.exe (a Windows
// NirSoft tool) - on Linux those spawns fail (EACCES/ENOENT), so the Volume
// section shows "audio unavailable". We reproduce two things:
//   - readSoundVolumeRows() -> rows in SoundVolumeView's /scomma column layout
//     (the F.* indices), so _getAudioInfoRaw()/'/audio/apps' work unchanged.
//   - svvShim() -> translates the inline `execFile(SVV, ...)` write calls
//     (/SetVolume, /Mute, /Unmute, /Switch, /ChangeVolume, /SetDefault) to wpctl.
// System is PipeWire (no pactl); wpctl volume is linear 0..1 == the value the
// user sees, so percent = round(v*100) round-trips cleanly.

function audioEnv() {
  const env = { ...process.env };
  if (!env.XDG_RUNTIME_DIR) {
    try { env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`; } catch { }
  }
  return env;
}
function audioRun(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, env: audioEnv(), windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''));
    });
  });
}

// "Volume: 0.43" or "Volume: 0.43 [MUTED]" -> { volume: 0..100, muted }.
async function nodeVolume(id) {
  const out = await audioRun('wpctl', ['get-volume', String(id)], 3000);
  if (!out) return { volume: 0, muted: false };
  const m = out.match(/Volume:\s*([\d.]+)/);
  return { volume: m ? Math.round(parseFloat(m[1]) * 100) : 0, muted: /MUTED/.test(out) };
}

// Parse pw-dump into audio nodes we care about.
async function pwNodes() {
  const raw = await audioRun('pw-dump', [], 5000);
  if (!raw) return null;
  let dump;
  try { dump = JSON.parse(raw); } catch { return null; }

  let defSink = '';
  let defSource = '';
  const sinks = [];
  const sources = [];
  const outStreams = [];
  const inStreams = [];

  for (const o of dump) {
    if (o.type === 'PipeWire:Interface:Metadata' &&
        o.props && o.props['metadata.name'] === 'default') {
      for (const m of (o.metadata || [])) {
        if (m.key === 'default.audio.sink' && m.value) defSink = m.value.name || '';
        if (m.key === 'default.audio.source' && m.value) defSource = m.value.name || '';
      }
    }
    if (o.type !== 'PipeWire:Interface:Node') continue;
    const p = (o.info && o.info.props) || {};
    const cls = p['media.class'];
    const node = {
      id: o.id,
      name: p['node.name'] || '',
      desc: p['node.description'] || p['node.nick'] || p['node.name'] || 'Audio device',
      appName: p['application.name'] || '',
      binary: p['application.process.binary'] || '',
      pid: p['application.process.id'] || '',
      mediaName: p['media.name'] || '',
    };
    if (cls === 'Audio/Sink') sinks.push(node);
    else if (cls === 'Audio/Source' && !node.name.endsWith('.monitor')) sources.push(node);
    else if (cls === 'Stream/Output/Audio') outStreams.push(node);
    else if (cls === 'Stream/Input/Audio') inStreams.push(node);
  }
  return { defSink, defSource, sinks, sources, outStreams, inStreams };
}

// Build rows matching SoundVolumeView's /scomma columns (see F.* in server.js).
async function audioRows() {
  const n = await pwNodes();
  if (!n) return [];
  const all = [...n.sinks, ...n.sources, ...n.outStreams, ...n.inStreams];
  const vols = await Promise.all(all.map((x) => nodeVolume(x.id)));
  const volById = new Map(all.map((x, i) => [x.id, vols[i]]));

  const rows = [];
  const row = () => new Array(22).fill('');
  const F = { NAME: 0, TYPE: 1, DIR: 2, DEVICE_NAME: 3, DEFAULT: 4, STATE: 7, MUTED: 8, VOL_PCT: 10, CLI_ID: 18, PROC_PATH: 19, PROC_ID: 20, WINDOW_TITLE: 21 };

  const addDevice = (node, dir, isDefault) => {
    const v = volById.get(node.id) || { volume: 0, muted: false };
    const r = row();
    r[F.NAME] = node.desc;
    r[F.TYPE] = 'Device';
    r[F.DIR] = dir; // Render | Capture
    r[F.DEVICE_NAME] = node.desc;
    r[F.DEFAULT] = isDefault ? dir : '';
    r[F.STATE] = 'Active';
    r[F.MUTED] = v.muted ? 'Yes' : 'No';
    r[F.VOL_PCT] = String(v.volume);
    r[F.CLI_ID] = String(node.id);
    rows.push(r);
  };
  const addApp = (node, dir) => {
    const v = volById.get(node.id) || { volume: 0, muted: false };
    const r = row();
    // Bare binary name (no path/backslash) so server's split('\\').pop() yields it.
    const proc = node.binary || (node.appName || 'app').toLowerCase().replace(/\s+/g, '');
    r[F.NAME] = node.appName || proc;
    r[F.TYPE] = 'Application';
    r[F.DIR] = dir;
    r[F.STATE] = 'Active';
    r[F.MUTED] = v.muted ? 'Yes' : 'No';
    r[F.VOL_PCT] = String(v.volume);
    r[F.CLI_ID] = String(node.id);
    r[F.PROC_PATH] = proc; // durable target; svvShim maps "<proc>.exe" back to nodes
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

// Resolve a SoundVolumeView write target to one or more PipeWire node ids.
async function resolveAudioTargets(target) {
  const t = String(target || '').trim();
  if (/^\d+$/.test(t)) return [Number(t)];
  const n = await pwNodes();
  if (!n) return [];
  if (t === 'DefaultCaptureDevice' || t === 'DefaultRenderDevice') {
    const want = t === 'DefaultCaptureDevice' ? n.defSource : n.defSink;
    const list = t === 'DefaultCaptureDevice' ? n.sources : n.sinks;
    const hit = list.find((x) => x.name === want);
    return hit ? [hit.id] : [];
  }
  // App target: "<binary>.exe" or a bare name -> every matching stream node.
  const name = t.replace(/\.exe$/i, '').toLowerCase();
  const streams = [...n.outStreams, ...n.inStreams];
  const ids = streams
    .filter((s) => (s.binary || '').toLowerCase() === name ||
                   (s.appName || '').toLowerCase().replace(/\s+/g, '') === name ||
                   (s.appName || '').toLowerCase().includes(name))
    .map((s) => s.id);
  return ids;
}

// Translate one SoundVolumeView invocation to wpctl. args mirror the SVV CLI.
async function audioSet(args) {
  const action = args[0];
  if (action === '/scomma') return; // reads are served by audioRows()
  const ids = await resolveAudioTargets(args[1]);
  for (const id of ids) {
    if (action === '/SetVolume') {
      const pct = Math.max(0, Math.min(100, parseInt(args[2], 10) || 0));
      await audioRun('wpctl', ['set-volume', String(id), (pct / 100).toFixed(3)], 3000);
    } else if (action === '/ChangeVolume') {
      const step = parseInt(args[2], 10) || 0;
      const arg = `${Math.abs(step) / 100}${step < 0 ? '-' : '+'}`;
      await audioRun('wpctl', ['set-volume', String(id), arg], 3000);
    } else if (action === '/Mute') {
      await audioRun('wpctl', ['set-mute', String(id), '1'], 3000);
    } else if (action === '/Unmute') {
      await audioRun('wpctl', ['set-mute', String(id), '0'], 3000);
    } else if (action === '/Switch') {
      await audioRun('wpctl', ['set-mute', String(id), 'toggle'], 3000);
    } else if (action === '/SetDefault') {
      await audioRun('wpctl', ['set-default', String(id)], 3000);
    }
  }
}

// Drop-in for the inline `execFile(SVV, ...)` calls: same (args, ...cb) contract.
// callArgs is the full arguments object of the intercepted execFile call.
function svvShim(callArgs) {
  const argsArray = Array.isArray(callArgs[1]) ? callArgs[1] : [];
  const last = callArgs[callArgs.length - 1];
  const cb = typeof last === 'function' ? last : null;
  audioSet(argsArray)
    .then(() => { if (cb) cb(null, '', ''); })
    .catch((e) => { if (cb) cb(e); });
}

module.exports = { gpu, disks, cpuTemp, network, windows, audioRows, svvShim };
