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
// tool is absent): nvidia-smi for an NVIDIA GPU (AMD and Intel need nothing —
// they are read from /sys/class/drm), wmctrl + xdotool + x11-utils for the app
// switcher (X11 sessions), pipewire + wireplumber (pw-dump, wpctl) for audio,
// playerctl for now-playing (see linux-media.js).

'use strict';

const fsp = require('fs').promises;
const os = require('os');
const { createAppIcons } = require('./linux-app-icons.js');
// Shared with darwin-collectors.js: the delta/aggregation half of the
// `processes` stream is identical on both, and lives in one tested place.
const procStats = require('./process-stats');
require('./packet-loss');

// --- Memory: /proc/meminfo, because os.freemem() means something else here ---
// os.freemem() is MemFree, which excludes the page cache the kernel would hand
// straight back — so `total - free` counts every cached file as used and the
// RAM tile reads far higher than anything the user's own tools show. On Windows
// the same call is ullAvailPhys and already accounts for that, which is why the
// figure was right there and wrong the moment the port reached a second OS.
// MemAvailable is the kernel's own answer to "how much could a new workload
// get", which is exactly the Windows meaning, and it has been in /proc/meminfo
// since 3.14. Where it is missing the classic approximation stands in.
function parseMemInfo(out) {
  const kb = (label) => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\s*kB`, 'm').exec(String(out || ''));
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  if (!total) return null;
  let available = kb('MemAvailable');
  if (available === null) {
    const free = kb('MemFree'), buffers = kb('Buffers'), cached = kb('Cached');
    if (free === null) return null;
    available = free + (buffers || 0) + (cached || 0);
  }
  return { used: Math.max(0, Math.min(total, total - available)), total };
}

async function memory() {
  let raw = null;
  try { raw = await fsp.readFile('/proc/meminfo', 'utf8'); } catch { /* not procfs */ }
  const parsed = raw === null ? null : parseMemInfo(raw);
  return parsed || { used: os.totalmem() - os.freemem(), total: os.totalmem() };
}

const { run, mapLimit, readText } = require('./platform/linux-read.js');

const {
  EMPTY_GPU, parseGpu, rc6Busy, parseSysfsGpu, betterGpuCandidate, sysfsGpu, NVIDIA_SMI_RETRY_MS,
} = require('./platform/linux-gpu.js');

let nvidiaSmiMissingAt = 0;

async function nvidiaGpu() {
  if (Date.now() - nvidiaSmiMissingAt < NVIDIA_SMI_RETRY_MS) return null;
  try {
    return parseGpu(await run('nvidia-smi',
      ['--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,clocks.gr,clocks.mem,name',
       '--format=csv,noheader,nounits'], 5000));
  } catch (err) {
    if (err && err.code === 'ENOENT') nvidiaSmiMissingAt = Date.now();
    return null;
  }
}

async function gpu() {
  const nvidia = await nvidiaGpu();
  if (nvidia) return nvidia;
  // No NVIDIA driver (or no nvidia-smi): fall through to the kernel's own
  // files, which is the whole AMD story and half of the Intel one.
  try {
    const fromSysfs = await sysfsGpu();
    if (fromSysfs) return fromSysfs;
  } catch { /* fall through to empty */ }
  return { ...EMPTY_GPU };
}

const {
  parseDisks, disks, parseDiskstats, parseMountsFor, diskIo,
} = require('./platform/linux-disks.js');



const {
  parseHwmonFans, pickCpuClockMHz, cpuTemp, HWMON_CHIPS_MAX, hwmonKind, hwmonDevKey,
  parseHwmonReading, HWMON_INDEX_TTL_MS, HWMON_REWALK_MIN_MS, readChipFiles,
} = require('./platform/linux-hwmon.js');


// id → where it was found in the last walk, so a read touches only the files
// asked for. Some of these reads reach real hardware (drivetemp asks the disk),
// which is why read mode never re-walks every chip on each tick.
let _hwmonIndex = new Map();
let _hwmonIndexAt = 0;

async function listSensors() {
  const out = [];
  const index = new Map();
  const base = '/sys/class/hwmon';
  let dirs = [];
  try { dirs = (await fsp.readdir(base)).slice(0, HWMON_CHIPS_MAX); } catch { return out; }
  for (const d of dirs) {
    const dir = `${base}/${d}`;
    let chip = '';
    try { chip = (await readText(`${dir}/name`)).replace(/[^A-Za-z0-9_.+-]/g, '_').slice(0, 32); } catch { continue; }
    if (!chip) continue;
    let devKey = 'virtual';
    try { devKey = hwmonDevKey(await fsp.realpath(`${dir}/device`)); } catch { /* a virtual chip has no device */ }
    await readChipFiles(dir, chip, devKey, index, out);
  }
  // Two chips of one driver (two NVMe drives) carry their device in the name,
  // so the picker can tell them apart.
  const devices = new Map();
  for (const meta of index.values()) devices.set(meta.chip, (devices.get(meta.chip) || new Set()).add(meta.devKey));
  for (const e of out) {
    const meta = index.get(e.id);
    if (devices.get(meta.chip).size > 1) { meta.hw = `${meta.chip} ${meta.devKey}`; e.hw = meta.hw; }
  }
  _hwmonIndex = index;
  _hwmonIndexAt = Date.now();
  return out;
}

async function readSensors(ids) {
  const wanted = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string');
  if (!wanted.length) return [];
  const stale = Date.now() - _hwmonIndexAt > HWMON_INDEX_TTL_MS || wanted.some((id) => !_hwmonIndex.has(id));
  if (stale && Date.now() - _hwmonIndexAt > HWMON_REWALK_MIN_MS) await listSensors();
  const out = [];
  for (const id of wanted) {
    const meta = _hwmonIndex.get(id);
    if (!meta) continue;
    let raw;
    try { raw = await readText(meta.file); } catch { continue; }
    const e = parseHwmonReading(meta.chip, meta.devKey, meta.file.split('/').pop(), raw, meta.label);
    if (e) out.push({ ...e, hw: meta.hw });
  }
  return out;
}

const { parseNetDev, parsePing, network } = require('./platform/linux-network.js');

const {
  MAX_WINDOWS, XPROP_CONCURRENCY, runX, PROTECTED_CLASSES, appFromExe, parseWmctrl,
  parseWindowProps, windowProps, parseClientList, parseWindowIdentity, listRowsViaXprop,
  focusWindow, closeWindow,
} = require('./platform/linux-windows.js');



const appIcon = createAppIcons();

async function listWindows() {
  const [raw, activeRaw] = await Promise.all([
    runX('wmctrl', ['-lp'], 5000),
    runX('xprop', ['-root', '_NET_ACTIVE_WINDOW'], 3000),
  ]);
  // wmctrl's one-shot listing when it is installed; otherwise the same data
  // assembled from xprop, so the widget works on a bare x11-utils machine.
  const rows = raw ? parseWmctrl(raw) : await listRowsViaXprop();
  if (!rows.length) return { windows: [] };
  const activeHex = (String(activeRaw || '').match(/window id # (0x[0-9a-fA-F]+)/) || [])[1];
  const activeDec = activeHex ? parseInt(activeHex, 16) : -1;

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
      icon: null, // filled below from the app's .desktop file; a name alone when there is none
    });
  });
  await Promise.all(windows.map(async (w) => { w.icon = await appIcon(w.app); }));

  // Re-sort on the final labels (WM_CLASS is nicer than the binary name), which
  // is the ordering the PowerShell path emits: active first, then app, then title.
  windows.sort((a, b) =>
    (b.active - a.active) ||
    a.app.localeCompare(b.app) ||
    a.title.localeCompare(b.title));
  return { windows };
}

async function windows(action, id) {
  if (action === 'focus') return focusWindow(id);
  if (action === 'close') return closeWindow(id);
  return listWindows();
}

const {
  cubicToLinear, audioRun, parsePwDump, pwNodes, buildAudioRows, markStopped, AUDIO_ROWS_TTL_MS,
  soundingRows, resolveTargets, AUDIO_PROBE_RETRY_MS,
} = require('./platform/linux-audio.js');


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

let _audioProbe = null;
let _audioProbeAt = 0;
async function audioAvailable() {
  if (_audioProbe !== null) {
    const ok = await _audioProbe;
    if (ok || Date.now() - _audioProbeAt <= AUDIO_PROBE_RETRY_MS) return ok;
  }
  _audioProbeAt = Date.now();
  _audioProbe = pwNodes().then(() => true).catch(() => false);
  return _audioProbe;
}

// Lock the screen now — the Deck's lockWorkstation key. loginctl asks the
// session's own locker, which is why it is the one call that works under both
// X11 and Wayland where the screensaver D-Bus names do not.
async function lock() {
  await run('loginctl', ['lock-session'], 5000);
}

// --- Sending a key combination ----------------------------------------------
// The Linux half of server.js's sendHotkey: the Deck's `hotkey` action, and
// answering a Teams/Zoom call (both are in-app shortcuts, so the caller focuses
// the window first and this only delivers the keys).
//
// Two tools, and which one is available is a property of the SESSION, not of
// the distro. xdotool speaks a combo directly and is already an optional
// dependency here for the app switcher — but it goes through the X server, so
// under Wayland it reaches nothing. Wayland deliberately forbids one client
// from synthesising input into another, so the only route left is ydotool,
// which writes to /dev/uinput underneath the compositor and needs its daemon
// (or uinput permissions) set up by the user first.
//
// That is why this capability is optional on Linux and declared rather than
// assumed: on a Wayland desktop with no ydotool there is no way to press a key
// in another application, and the call card must not offer a button for it.

const { ydotoolArgs } = require('./platform/linux-keys.js');

let _keysProbe = null;
// Which sender this session has, if any. Cached: it is read on the path that
// decides whether to draw an Answer button, and neither tool appears or
// disappears while the server runs.
async function keysTool() {
  if (_keysProbe !== null) return _keysProbe;
  const wayland = !!(process.env.WAYLAND_DISPLAY || String(process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland');
  const probe = async (bin, args) => {
    try { await run(bin, args, 3000); return true; } catch { return false; }
  };
  // Under Wayland xdotool may well be installed and still deliver nothing, so
  // it is not even tried there — offering a button that silently fails is the
  // failure this whole feature is written to avoid.
  if (!wayland && await probe('xdotool', ['--version'])) _keysProbe = 'xdotool';
  else if (await probe('ydotool', ['--help'])) _keysProbe = 'ydotool';
  else _keysProbe = '';
  return _keysProbe;
}

async function keysAvailable() { return !!(await keysTool()); }

async function sendKeys(combo) {
  const tool = await keysTool();
  if (!tool) return { ok: false, error: 'no_key_tool' };
  if (tool === 'xdotool') {
    // --clearmodifiers so a modifier the user is physically holding does not
    // combine into a different shortcut than the one requested.
    try { await run('xdotool', ['key', '--clearmodifiers', String(combo)], 5000); return { ok: true }; }
    catch { return { ok: false, error: 'xdotool_failed' }; }
  }
  const args = ydotoolArgs(combo);
  if (!args) return { ok: false, error: 'bad_combo' };
  try { await run('ydotool', ['key', ...args], 5000); return { ok: true }; }
  catch { return { ok: false, error: 'ydotool_failed' }; }
}

// --- Showing the desktop: Bit's "I'll hide your windows" (vitals-nag.js) -----
// X11 has a standard for it: _NET_SHOWING_DESKTOP, which `wmctrl -k on` sets on
// every EWMH window manager (GNOME, KDE, Xfce, Cinnamon, MATE…). Wayland has no
// protocol for one app to hide the others; KDE's KWin still answers its own
// global shortcut over D-Bus ("Show Desktop", Meta+D, src/useractions.cpp), so
// Plasma works there too. GNOME on Wayland exposes nothing an app may call, so
// it is the one desktop where this is not possible.
function linuxSession(env = process.env) {
  const wayland = !!(env.WAYLAND_DISPLAY || String(env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland');
  const desktop = String(env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || '').toLowerCase();
  return { wayland, kde: /kde|plasma/.test(desktop) };
}

// → 'wmctrl' | 'kwin' | '' (cannot here), given which tools answer.
function pickHideTool(session, has) {
  if (!session.wayland && has.wmctrl) return 'wmctrl';
  if (session.kde && has.dbusSend) return 'kwin';
  return '';
}

let _hideProbe = null;
// Why it cannot, when it cannot: 'wayland' (no desktop API) or 'needs_wmctrl'.
async function hideWindowsTool() {
  if (_hideProbe) return _hideProbe;
  const session = linuxSession();
  const answers = async (bin, args) => {
    try { await run(bin, args, 3000); return true; } catch { return false; }
  };
  const has = {
    wmctrl: !session.wayland && await answers('wmctrl', ['-m']),
    dbusSend: session.kde && await answers('dbus-send', ['--version']),
  };
  const tool = pickHideTool(session, has);
  _hideProbe = { tool, reason: tool ? '' : (session.wayland ? 'wayland' : 'needs_wmctrl') };
  return _hideProbe;
}

async function hideWindows() {
  const { tool, reason } = await hideWindowsTool();
  if (tool === 'wmctrl') {
    if (await runX('wmctrl', ['-k', 'on'], 5000) === null) throw new Error('wmctrl_failed');
    return;
  }
  if (tool === 'kwin') {
    await run('dbus-send', ['--session', '--type=method_call', '--dest=org.kde.kglobalaccel', '/component/kwin',
      'org.kde.kglobalaccel.Component.invokeShortcut', 'string:Show Desktop'], 5000);
    return;
  }
  const err = new Error(reason);
  err.code = reason;
  throw err;
}

// A desktop notification: the fallback for Bit's popup when no Xenon app window
// can draw it. notify-send is libnotify's, on every common desktop.
async function notify(title, text) {
  await run('notify-send', ['--app-name=Xenon', '--', String(title), String(text)], 5000);
}

// --- Per-process CPU/RAM for the `processes` stream -------------------------
// One read of /proc/<pid>/stat per process carries BOTH the cumulative CPU time
// and the resident set, so this needs no external tool and no second file.
//
// Per-process GPU is deliberately absent rather than approximated. It exists on
// Linux only through DRM fdinfo (i915/amdgpu, recent kernels) or `nvidia-smi
// pmon`, each covering one vendor and neither covering a hybrid laptop
// correctly. `gpuAvail: false` makes the widget hide the column and say why,
// which is the honest answer; a column of zeros would read as "nothing is using
// the GPU" and be worse than no column at all.
//
// /proc/[pid]/stat fields are 1-indexed in proc(5). comm (field 2) is wrapped in
// parentheses AND may itself contain spaces and parentheses — "((sd-pam))" is
// real — so it is cut at the LAST ')' rather than tokenised.
const USER_HZ = 100;   // fixed by the kernel ABI for /proc/[pid]/stat, not by CONFIG_HZ

function parseProcStat(text) {
  const line = String(text || '').trim();
  const open = line.indexOf('(');
  const close = line.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(line.slice(0, open).trim());
  const name = line.slice(open + 1, close);
  if (!Number.isInteger(pid) || pid <= 0 || !name) return null;
  // After the closing paren the first token is field 3 (state), so field N sits
  // at index N-3: ppid=4 -> 1, utime=14 -> 11, stime=15 -> 12, starttime=22 -> 19, rss=24 -> 21.
  const rest = line.slice(close + 1).trim().split(/\s+/);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const rssPages = Number(rest[21]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return {
    pid,
    ppid: Number(rest[1]) || 0,
    name,
    startTicks: Number(rest[19]) || 0,
    cpuMs: ((utime + stime) / USER_HZ) * 1000,
    rssPages: Number.isFinite(rssPages) && rssPages > 0 ? rssPages : 0,
  };
}

// The page size is needed to turn stat's rss (in pages) into bytes, and Node
// exposes no sysconf(_SC_PAGESIZE). Deriving it once from OUR OWN process — where
// both spellings of the same number are readable — is exact on 4K x86 and on the
// 16K/64K ARM kernels a hardcoded 4096 would under-report by 4x or 16x.
let _pageSize = 0;
async function pageSize() {
  if (_pageSize) return _pageSize;
  _pageSize = 4096;
  try {
    const self = parseProcStat(await fsp.readFile('/proc/self/stat', 'utf8'));
    const rssBytes = process.memoryUsage().rss;
    if (self && self.rssPages > 0 && rssBytes > 0) {
      const guess = rssBytes / self.rssPages;
      for (const candidate of [4096, 8192, 16384, 65536]) {
        if (guess >= candidate * 0.75 && guess <= candidate * 1.5) { _pageSize = candidate; break; }
      }
    }
  } catch { /* keep 4096 */ }
  return _pageSize;
}

async function sampleProcesses() {
  const size = await pageSize();
  let entries = [];
  try { entries = await fsp.readdir('/proc'); } catch { return null; }
  const pids = entries.filter((e) => /^\d+$/.test(e));
  const sample = new Map();
  // Bounded concurrency: /proc reads are cheap but a 500-process box would open
  // 500 descriptors in one tick without it.
  await mapLimit(pids, 64, async (dir) => {
    let raw = null;
    try { raw = await fsp.readFile('/proc/' + dir + '/stat', 'utf8'); } catch { return; }
    const row = parseProcStat(raw);
    if (row) sample.set(row.pid, { name: row.name, cpuMs: row.cpuMs, rss: row.rssPages * size });
  });
  return sample.size ? sample : null;
}

// Every process for Performance Mode, the rows process-table-windows.js gives. The owner
// is the uid: a process of another user is not this person's to move.
async function processTable() {
  const size = await pageSize();
  let entries = [];
  try { entries = await fsp.readdir('/proc'); } catch { return null; }
  const rows = [];
  await mapLimit(entries.filter((e) => /^\d+$/.test(e)), 64, async (dir) => {
    let raw = null;
    let info = null;
    try { [raw, info] = await Promise.all([fsp.readFile('/proc/' + dir + '/stat', 'utf8'), fsp.stat('/proc/' + dir)]); } catch { return; }
    const row = parseProcStat(raw);
    if (!row) return;
    rows.push({ pid: row.pid, ppid: row.ppid, name: row.name.toLowerCase(), cpuMs: row.cpuMs, memBytes: row.rssPages * size, startedAt: row.startTicks, owner: info.uid });
  });
  return rows.length ? rows : null;
}

const PROC_STALE_MS = 30000;
const PROC_PRIME_MS = 250;
let _procPrev = null;
let _procPrevAt = 0;

async function processes(top = 8) {
  let curr = await sampleProcesses();
  if (!curr) return { ok: false, error: 'no_procfs' };
  let now = Date.now();
  // First call, or a gap long enough that the delta would be a guess: prime with
  // a short window so THIS call already answers with real numbers. Paid once per
  // stream start, never in the steady state.
  if (!_procPrev || !_procPrevAt || now - _procPrevAt > PROC_STALE_MS) {
    _procPrev = curr;
    _procPrevAt = now;
    await new Promise((r) => setTimeout(r, PROC_PRIME_MS));
    curr = await sampleProcesses();
    if (!curr) return { ok: false, error: 'no_procfs' };
    now = Date.now();
  }
  const windowMs = Math.max(1, now - _procPrevAt);
  const cores = Math.max(1, os.cpus().length);
  const all = procStats.aggregate(_procPrev, curr, { windowMs, cores });
  const apps = procStats.topUnion(all, top);
  _procPrev = curr;
  _procPrevAt = now;
  const mem = await memory();
  return {
    ok: true,
    cpu: procStats.totalCpu(all),
    // No per-adapter breakdown here: per-process GPU does not exist on Linux
    // without vendor-specific plumbing, so there is nothing to attribute.
    gpus: [],
    cores,
    totalMB: Math.round((mem.total || 0) / (1024 * 1024)),
    usedMB: Math.round((mem.used || 0) / (1024 * 1024)),
    gpuAvail: false,
    win: windowMs,
    apps,
  };
}

const { parseLoginctlIdle, parseXprintidle, idleSeconds } = require('./platform/linux-idle.js');

// The machine's own id, for pc-id.js. Containers often have only the dbus copy.
async function machineId() {
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    const id = await fsp.readFile(file, 'utf8').then((t) => t.trim()).catch(() => '');
    if (/^[0-9a-f]{32}$/i.test(id)) return id.toLowerCase();
  }
  return '';
}

module.exports = {
  machineId,
  gpu, disks, diskIo, cpuTemp, listSensors, readSensors, memory, network, windows, audioRows, soundingRows, audioCommand, audioAvailable, lock,
  sendKeys, keysAvailable, hideWindows, hideWindowsTool, notify, processes, processTable, idleSeconds, parseLoginctlIdle, parseXprintidle,
  // exported for unit tests
  parseProcStat,
  parseGpu, parseSysfsGpu, rc6Busy, pickCpuClockMHz, betterGpuCandidate, parseHwmonFans, parseHwmonReading, hwmonDevKey, hwmonKind, parseDisks, parseMemInfo, parseNetDev, parsePing,
  parseDiskstats, parseMountsFor,
  parseWmctrl, parseWindowProps, parseClientList, parseWindowIdentity,
  parsePwDump, buildAudioRows, markStopped, resolveTargets, cubicToLinear,
  ydotoolArgs, linuxSession, pickHideTool,
};
