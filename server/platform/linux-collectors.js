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
const { createAppIcons } = require('../search/linux-app-icons.js');

const { parseMemInfo, memory } = require('./linux-memory.js');

const { mapLimit } = require('./linux-read.js');

const { parseGpu, rc6Busy, parseSysfsGpu, betterGpuCandidate } = require('./linux-gpu.js');

const {
  parseDisks, disks, parseDiskstats, parseMountsFor, diskIo,
} = require('./linux-disks.js');



const {
  parseHwmonFans, pickCpuClockMHz, cpuTemp, hwmonKind, hwmonDevKey, parseHwmonReading,
} = require('./linux-hwmon.js');



const { gpu, listSensors, readSensors } = require('./linux-sensor-read.js');

const { parseNetDev, parsePing, network } = require('./linux-network.js');

const {
  MAX_WINDOWS, XPROP_CONCURRENCY, runX, PROTECTED_CLASSES, appFromExe, parseWmctrl,
  parseWindowProps, windowProps, parseClientList, parseWindowIdentity, listRowsViaXprop,
  focusWindow, closeWindow,
} = require('./linux-windows.js');



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
} = require('./linux-audio.js');


const { audioRows, audioCommand, audioAvailable } = require('./linux-audio-control.js');

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

const { ydotoolArgs } = require('./linux-keys.js');

const { linuxSession, pickHideTool } = require('./linux-hide-tool.js');

const {
  lock, keysAvailable, sendKeys, hideWindowsTool, hideWindows, notify,
} = require('./linux-session-actions.js');

const { parseProcStat } = require('./linux-proc-stat.js');

const { processTable, processes } = require('./linux-process-rates.js');

const { parseLoginctlIdle, parseXprintidle, idleSeconds } = require('./linux-idle.js');

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
