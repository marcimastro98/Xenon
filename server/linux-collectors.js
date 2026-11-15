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
const { createAppIcons } = require('./linux-app-icons.js');
// Shared with darwin-collectors.js: the delta/aggregation half of the
// `processes` stream is identical on both, and lives in one tested place.
require('./process-stats');

const { parseMemInfo, memory } = require('./platform/linux-memory.js');

const { run, mapLimit, readText } = require('./platform/linux-read.js');

const {
  EMPTY_GPU, parseGpu, rc6Busy, parseSysfsGpu, betterGpuCandidate, sysfsGpu, NVIDIA_SMI_RETRY_MS,
} = require('./platform/linux-gpu.js');

const { held } = require('./platform/linux-held.js');

async function nvidiaGpu() {
  if (Date.now() - held.nvidiaSmiMissingAt < NVIDIA_SMI_RETRY_MS) return null;
  try {
    return parseGpu(await run('nvidia-smi',
      ['--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,clocks.gr,clocks.mem,name',
       '--format=csv,noheader,nounits'], 5000));
  } catch (err) {
    if (err && err.code === 'ENOENT') held.nvidiaSmiMissingAt = Date.now();
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
  held.hwmonIndex = index;
  held.hwmonIndexAt = Date.now();
  return out;
}

async function readSensors(ids) {
  const wanted = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string');
  if (!wanted.length) return [];
  const stale = Date.now() - held.hwmonIndexAt > HWMON_INDEX_TTL_MS || wanted.some((id) => !held.hwmonIndex.has(id));
  if (stale && Date.now() - held.hwmonIndexAt > HWMON_REWALK_MIN_MS) await listSensors();
  const out = [];
  for (const id of wanted) {
    const meta = held.hwmonIndex.get(id);
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
  cubicToLinear, parsePwDump, buildAudioRows, markStopped, soundingRows, resolveTargets,
} = require('./platform/linux-audio.js');


const { audioRows, audioCommand, audioAvailable } = require('./platform/linux-audio-control.js');

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

// Which sender this session has, if any. Cached: it is read on the path that
// decides whether to draw an Answer button, and neither tool appears or
// disappears while the server runs.
async function keysTool() {
  if (held.keysProbe !== null) return held.keysProbe;
  const wayland = !!(process.env.WAYLAND_DISPLAY || String(process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland');
  const probe = async (bin, args) => {
    try { await run(bin, args, 3000); return true; } catch { return false; }
  };
  // Under Wayland xdotool may well be installed and still deliver nothing, so
  // it is not even tried there — offering a button that silently fails is the
  // failure this whole feature is written to avoid.
  if (!wayland && await probe('xdotool', ['--version'])) held.keysProbe = 'xdotool';
  else if (await probe('ydotool', ['--help'])) held.keysProbe = 'ydotool';
  else held.keysProbe = '';
  return held.keysProbe;
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

const { linuxSession, pickHideTool } = require('./platform/linux-hide-tool.js');

// Why it cannot, when it cannot: 'wayland' (no desktop API) or 'needs_wmctrl'.
async function hideWindowsTool() {
  if (held.hideProbe) return held.hideProbe;
  const session = linuxSession();
  const answers = async (bin, args) => {
    try { await run(bin, args, 3000); return true; } catch { return false; }
  };
  const has = {
    wmctrl: !session.wayland && await answers('wmctrl', ['-m']),
    dbusSend: session.kde && await answers('dbus-send', ['--version']),
  };
  const tool = pickHideTool(session, has);
  held.hideProbe = { tool, reason: tool ? '' : (session.wayland ? 'wayland' : 'needs_wmctrl') };
  return held.hideProbe;
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

const { parseProcStat } = require('./platform/linux-proc-stat.js');

const { processTable, processes } = require('./platform/linux-process-rates.js');

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
