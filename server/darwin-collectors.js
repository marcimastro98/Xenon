// darwin-collectors.js - macOS data sources for Xenon's Windows-only collectors.
//
// Twin of linux-collectors.js, and it keeps the same promise: return the SAME
// shapes the Windows collectors produced, so the caching, merge, bandwidth-delta
// and CSV-column logic in server.js is untouched. server.js only calls in when
// process.platform === 'darwin'; the Windows code paths are unchanged.
//
// What replaces what:
//   gpu.ps1 / cpu-temp.ps1  -> macmon (optional, see below) + system_profiler
//   Get-Volume / statfs A-Z -> df + mount
//   network.ps1             -> ping + netstat -ib
//   windows.ps1 (EnumWindows)-> osascript / System Events
//   SoundVolumeView.exe     -> osascript volume settings + system_profiler
//
// Everything here is async: these run on the SSE sensor path, so there is no
// synchronous filesystem access anywhere in this file.
//
// KNOWN LIMITS, and why they are limits rather than bugs:
//
//   * Temperatures and GPU load are not on any first-party CLI without sudo
//     (powermetrics is, and asking a dashboard user for a root password every
//     poll is not an option). Three sources, tried in that order: the native
//     helper's `temps` mode, which reads GPU load from IOKit's public
//     accelerator registry and the temperatures from the HID sensor services
//     and needs nothing installed; then `macmon` if the user has it on PATH
//     (brew install vladkens/tap/macmon), which fills in only what the helper
//     left null; then null, and the tiles render "--" exactly as they did
//     before this module existed. All three are ordinary answers.
//
//   * Per-app audio does not exist here. macOS has no per-process volume API
//     outside Core Audio process taps (14.4+), which need native code and a
//     permission grant. Device rows are produced; application rows are not, so
//     the mixer shows devices only.
//
//   * The app switcher prefers the native helper's `windows` mode, which needs
//     no permission at all. Without the helper it falls back to System Events,
//     which needs Automation permission; denied or unprompted, that degrades to
//     an empty list rather than an error.

'use strict';

const os = require('os');
// Shared with linux-collectors.js: the delta/aggregation half of the
// `processes` stream is identical on both, and lives in one tested place.
const procStats = require('./process-stats');

const { run, runSoft } = require('./platform/darwin-read.js');


const { parseVmStat, memory } = require('./platform/darwin-memory.js');

const { ratioToPct, parseMacmon, parseHelperTemps } = require('./platform/darwin-sensor-text.js');

const { held } = require('./platform/darwin-held.js');

const { HELPER_EXE } = require('./platform/darwin-helper-path.js');

const { runHelper } = require('./platform/darwin-helper-run.js');

const {
  EMPTY_SENSORS, gpu, cpuTemp, listSensors, readSensors,
} = require('./platform/darwin-sensor-read.js');

held.sensorCache = { data: { ...EMPTY_SENSORS }, at: 0 };

const { parseDisplaysJson } = require('./platform/darwin-displays.js');

const {
  parseMountTypes, parseDisks, disks, parseIoregDisks, diskIo,
} = require('./platform/darwin-disks.js');

const { parsePing, parseNetstatIb, network } = require('./platform/darwin-network.js');

const {
  PROTECTED_APPS, LIST_APPS_SCRIPT, parseAppList, parseHelperWindows, osa, quitAppArgs,
  helperVerdict,
} = require('./platform/darwin-apps.js');


async function listApps(includeProtected) {
  const helped = await runHelper(['windows', 'list'], 5000);
  if (helped !== null) {
    const parsed = parseHelperWindows(helped, includeProtected);
    if (parsed !== null) return parsed;
  }
  // A denied (or never granted) Automation prompt lands here as null. An empty
  // list is the honest answer -- the widget says "no open windows" rather than
  // claiming a failure the user cannot act on.
  const out = await osa(LIST_APPS_SCRIPT, 10000);
  return out === null ? [] : parseAppList(out, includeProtected);
}

async function windows(action, id) {
  if (action === 'focus') {
    if (!/^\d{1,24}$/.test(String(id || ''))) return { ok: false, error: 'not_found' };
    const helped = helperVerdict(await runHelper(['windows', 'focus', String(Number(id))], 5000));
    if (helped) return { ok: helped.ok === true };
    const out = await osa(
      `tell application "System Events" to set frontmost of (first process whose unix id is ${Number(id)}) to true`,
      8000);
    return { ok: out !== null };
  }
  if (action === 'close') {
    if (!/^\d{1,24}$/.test(String(id || ''))) return { ok: false, error: 'not_found' };
    const helped = helperVerdict(await runHelper(['windows', 'close', String(Number(id))], 8000));
    if (helped) {
      if (helped.ok === true) {
        return { ok: true, app: String(helped.app || ''), path: String(helped.path || '') };
      }
      const error = helped.error === 'protected' ? 'protected' : 'not_found';
      return { ok: false, error, app: String(helped.app || '') };
    }
    const list = await listApps(true);
    const hit = list.find((w) => w.id === String(Number(id)));
    if (!hit) return { ok: false, error: 'not_found' };
    if (PROTECTED_APPS.has(hit.app)) return { ok: false, error: 'protected', app: hit.app };
    // `quit` is the graceful close: the app gets to prompt about unsaved work,
    // which is what the Windows path's WM_CLOSE does too.
    const args = quitAppArgs(hit.app);
    if (!args) return { ok: false, error: 'not_found', app: hit.app };
    const out = await runSoft('osascript', args, 8000);
    return out === null
      ? { ok: false, error: 'not_found', app: hit.app }
      : { ok: true, app: hit.app, path: hit.path };
  }
  return { windows: await listApps() };
}

const {
  parseVolumeSettings, parseAudioDevices, buildAudioRows, withCurrentOutput, isCaptureTarget,
} = require('./platform/darwin-audio.js');


const { audioRows, audioCommand, audioAvailable } = require('./platform/darwin-audio-control.js');

// Lock the screen now — the Deck's lockWorkstation key, and the one action
// whose macOS implementation the OS deleted underneath it. `CGSession -suspend`
// lived under /System/Library/CoreServices/Menu Extras/User.menu and is absent
// on macOS 26 (verified on 26.5.2: the Menu Extras folder is still there,
// User.menu is not), so the key answered ENOENT and did nothing at all.
//
// The helper's `lock` mode calls what the OS calls for its own Lock Screen menu
// item, so it locks immediately whatever the user's password settings say.
// `runSoft` directly rather than runHelper(): an older installed helper exits
// non-zero on an unknown mode, and pinning the whole helper out for that would
// cost the app switcher and the temperatures a real capability over a version
// mismatch in one key.
//
// pmset is the fallback, and it is deliberately second: it sleeps the display
// and locks only where the user asked for a password after sleep. That covers
// the default configuration and no more, which is why it is not the answer.
async function lock() {
  const out = await runSoft(HELPER_EXE, ['lock'], 5000);
  if (out !== null) return;
  const slept = await runSoft('/usr/bin/pmset', ['displaysleepnow'], 5000);
  if (slept === null) throw new Error('lock unavailable: no helper and pmset failed');
}

// --- Hiding the other apps: Bit's "I'll hide your windows" (vitals-nag.js) ---
// macOS has no "show desktop" an app may call, but it has what Option-Command-H
// does: hiding the other apps. NSRunningApplication.hide() is a plain AppKit
// call, reached here through osascript's JavaScript bridge: no System Events,
// so no Automation or Accessibility prompt. Xenon's own windows stay, since
// the dashboard is what Bit talks from.
const XENON_BUNDLE_ID = 'com.marcimastro98.xenon';
const HIDE_APPS_JXA = `
ObjC.import('AppKit');
const keep = ${JSON.stringify([XENON_BUNDLE_ID])};
const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
let shown = 0, hidden = 0;
for (let i = 0; i < apps.count; i++) {
  const a = apps.objectAtIndex(i);
  // 0 = NSApplicationActivationPolicyRegular: apps with a Dock icon and windows.
  if (a.activationPolicy !== 0 || a.isHidden) continue;
  if (keep.includes(ObjC.unwrap(a.bundleIdentifier) || '')) continue;
  shown++;
  if (a.hide) hidden++;
}
JSON.stringify({ shown, hidden });
`;

// { shown, hidden } from the script, or null when it printed something else.
function parseHideResult(text) {
  try {
    const r = JSON.parse(String(text || '').trim());
    return Number.isInteger(r.shown) && Number.isInteger(r.hidden) ? r : null;
  } catch { return null; }
}

async function hideWindows() {
  const r = parseHideResult(await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', HIDE_APPS_JXA], 8000));
  // Nothing to hide is not a failure; apps that were there and stayed are.
  if (!r || (r.shown > 0 && r.hidden === 0)) throw new Error('hide_failed');
}

async function hideWindowsTool() { return { tool: 'appkit', reason: '' }; }

// A Notification Center banner: the fallback for Bit's popup when no Xenon app
// window can draw it. The text travels as an argument, never inside the script.
async function notify(title, text) {
  await run('/usr/bin/osascript', [
    '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run',
    String(title), String(text),
  ], 5000);
}

// --- Per-process CPU/RAM for the `processes` stream -------------------------
// `ps -Ao pid=,rss=,time=,comm=` is the whole data source: one process, no
// permission prompt, and — unlike Linux — macOS ps prints cumulative CPU time
// with HUNDREDTHS, so a two-second delta has 10ms resolution and does not
// quantise small consumers to zero.
//
// Deliberately NOT `ps -o %cpu`: on macOS that column is a decayed average over
// the process's whole LIFETIME, so a browser that was busy an hour ago still
// reads high while it sits idle. It looks like an instantaneous figure and is
// not one, which is the worst kind of wrong number to put on a dashboard.
//
// Per-process GPU does not exist here outside private IOKit accounting, so
// `gpuAvail: false` and the widget hides the column rather than showing zeros.

const {
  parsePsTime, parsePsProcesses, parsePsTable, processTable, sampleProcesses,
} = require('./platform/darwin-processes.js');

const PROC_STALE_MS = 30000;
const PROC_PRIME_MS = 250;

async function processes(top = 8) {
  let curr = await sampleProcesses();
  if (!curr) return { ok: false, error: 'ps_failed' };
  let now = Date.now();
  // First call, or a gap long enough that the delta would be a guess: prime with
  // a short window so THIS call already answers with real numbers.
  if (!held.procPrev || !held.procPrevAt || now - held.procPrevAt > PROC_STALE_MS) {
    held.procPrev = curr;
    held.procPrevAt = now;
    await new Promise((r) => setTimeout(r, PROC_PRIME_MS));
    curr = await sampleProcesses();
    if (!curr) return { ok: false, error: 'ps_failed' };
    now = Date.now();
  }
  const windowMs = Math.max(1, now - held.procPrevAt);
  const cores = Math.max(1, os.cpus().length);
  const all = procStats.aggregate(held.procPrev, curr, { windowMs, cores });
  const apps = procStats.topUnion(all, top);
  held.procPrev = curr;
  held.procPrevAt = now;
  const mem = await memory();
  return {
    ok: true,
    cpu: procStats.totalCpu(all),
    // No per-adapter breakdown here: per-process GPU is not available on macOS
    // outside private IOKit accounting, so there is nothing to attribute.
    gpus: [],
    cores,
    totalMB: Math.round((mem.total || 0) / (1024 * 1024)),
    usedMB: Math.round((mem.used || 0) / (1024 * 1024)),
    gpuAvail: false,
    win: windowMs,
    apps,
  };
}

const { fullDiskAccess, rootReachesHome } = require('./platform/darwin-disk-access.js');

const {
  parseHidIdleTime, idleSeconds, parsePlatformUuid, machineId,
} = require('./platform/darwin-idle.js');

module.exports = {
  machineId, parsePlatformUuid,
  gpu, disks, diskIo, cpuTemp, listSensors, readSensors, memory, network, windows, audioRows, audioCommand, audioAvailable, lock,
  hideWindows, hideWindowsTool, notify, processes, processTable, fullDiskAccess, rootReachesHome, idleSeconds, parseHidIdleTime,
  // exported for unit tests
  quitAppArgs, parsePsTime, parsePsProcesses, parsePsTable,
  parseMacmon, parseHelperTemps, parseDisplaysJson, parseDisks, parseMountTypes, parsePing,
  parseNetstatIb, parseAppList, parseHelperWindows, parseVmStat, parseVolumeSettings, parseAudioDevices,
  parseIoregDisks, parseHideResult,
  buildAudioRows, isCaptureTarget, ratioToPct, withCurrentOutput,
};
