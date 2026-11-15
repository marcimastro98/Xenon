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
const path = require('path');
// Shared with linux-collectors.js: the delta/aggregation half of the
// `processes` stream is identical on both, and lives in one tested place.
const procStats = require('./process-stats');

const { run, runSoft } = require('./platform/darwin-read.js');


const { parseVmStat, memory } = require('./platform/darwin-memory.js');

const { ratioToPct, parseMacmon, parseHelperTemps } = require('./platform/darwin-sensor-text.js');

// One macmon sample costs its own interval (it measures over a window), so it
// must never sit on the request path: the sensor cache below serves the last
// sample and refreshes in the background when it goes stale.
const MACMON_SAMPLE_MS = 300;
// Give up only after this many consecutive failures. One is not enough: a cold
// first spawn can lose the race with the timeout, and marking macmon missing on
// that would leave temperatures blank until the next restart of a machine that
// has the tool installed and working.
const MACMON_MAX_FAILURES = 3;
// ...and then back off rather than giving up for good. "Not installed" and "the
// machine was too busy to answer three times" look identical from here, and the
// second one must not blank the temperature tiles until the next restart. One
// spawn every few minutes is cheap enough to keep the door open.
const MACMON_RETRY_MS = 5 * 60 * 1000;
const { held } = require('./platform/darwin-held.js');

function refreshMacmon() {
  if (held.macmonInFlight) return held.macmonInFlight;
  if (held.macmonFailures >= MACMON_MAX_FAILURES && Date.now() < held.macmonNextTry) return null;
  held.macmonInFlight = runSoft('macmon', ['pipe', '-s', '1', '-i', String(MACMON_SAMPLE_MS)], 8000)
    .then((out) => {
      if (out === null) {
        held.macmonFailures++;
        if (held.macmonFailures >= MACMON_MAX_FAILURES) held.macmonNextTry = Date.now() + MACMON_RETRY_MS;
        return;
      }
      held.macmonFailures = 0;
      held.macmonCache = { data: parseMacmon(out), at: Date.now() };
    })
    .finally(() => { held.macmonInFlight = null; });
  return held.macmonInFlight;
}

// --- the native helper: the same three numbers, with nothing to install -----
// `xenon-helper temps` reads GPU load from IOKit's public accelerator registry
// and the temperatures from the HID sensor services. It is preferred over
// macmon when it answers, and macmon stays as the fallback for the machines it
// cannot read (an Intel Mac exposes neither sensor family under those names).
// Both paths are optional and both degrade to null, which is what the tiles
// already render as "--".
const HELPER_EXE = path.join(__dirname, 'helper', 'xenon-helper');

const HELPER_MAX_FAILURES = 3;
const HELPER_RETRY_MS = 5 * 60 * 1000;

async function runHelper(args, timeoutMs) {
  if (Date.now() < held.helperDownUntil) return null;
  const out = await runSoft(HELPER_EXE, args, timeoutMs);
  if (out === null) { held.helperDownUntil = Date.now() + HELPER_RETRY_MS; return null; }
  return out;
}

async function readHelperTemps() {
  if (held.helperFailures >= HELPER_MAX_FAILURES && Date.now() < held.helperNextTry) return null;
  // A one-shot read of two registries: fast, and a timeout here means something
  // is wrong rather than something is slow.
  const out = await runHelper(['temps'], 4000);
  const parsed = out === null ? null : parseHelperTemps(out);
  if (parsed === null) {
    held.helperFailures++;
    if (held.helperFailures >= HELPER_MAX_FAILURES) held.helperNextTry = Date.now() + HELPER_RETRY_MS;
    return null;
  }
  held.helperFailures = 0;
  return parsed;
}

// The live sample the collectors read. The helper answers first; macmon fills
// in only what the helper left null, so a machine where one source knows the
// temperatures and the other knows the GPU load reports both instead of
// whichever happened to run.
const SENSOR_TTL_MS = 2500;
const EMPTY_SENSORS = { cpuTemp: null, gpu: null, gpuTemp: null, vramUsed: null, cpuClockMHz: null, gpuClockMHz: null };
held.sensorCache = { data: { ...EMPTY_SENSORS }, at: 0 };

function refreshSensors() {
  if (held.sensorInFlight) return held.sensorInFlight;
  held.sensorInFlight = (async () => {
    const helper = await readHelperTemps();
    if (helper && helper.cpuTemp !== null && helper.gpu !== null && helper.gpuTemp !== null) {
      // Complete for everything the helper can answer. It reads no clocks, and
      // spawning macmon purely for them would undo the point of this shortcut —
      // so they stay null here rather than costing a process every 2.5 seconds.
      held.sensorCache = { data: { ...helper, cpuClockMHz: null, gpuClockMHz: null }, at: Date.now() };
      return;                       // complete: macmon is not spawned at all
    }
    await refreshMacmon();
    const mac = held.macmonCache.data;
    const pick = (a, b) => (a !== null && a !== undefined ? a : (b ?? null));
    const merged = {
      cpuTemp: pick(helper && helper.cpuTemp, mac.cpuTemp),
      gpu: pick(helper && helper.gpu, mac.gpu),
      gpuTemp: pick(helper && helper.gpuTemp, mac.gpuTemp),
      vramUsed: pick(helper && helper.vramUsed, null),
      // Clocks come from macmon only — the helper reads temperatures and load.
      cpuClockMHz: mac.cpuClockMHz ?? null,
      gpuClockMHz: mac.gpuClockMHz ?? null,
    };
    held.sensorCache = { data: merged, at: Date.now() };
  })().catch(() => { /* keep the previous sample */ })
    .finally(() => { held.sensorInFlight = null; });
  return held.sensorInFlight;
}

// Never awaited on the request path: serve the last sample, refresh behind it.
function liveSensors() {
  if (Date.now() - held.sensorCache.at > SENSOR_TTL_MS) refreshSensors();
  return held.sensorCache.data;
}

// --- GPU: name/VRAM from system_profiler, load/temp from macmon -------------
// system_profiler takes seconds, and the answer never changes while the machine
// is running, so it is resolved once and memoised for the process lifetime.
const EMPTY_GPU = { gpu: null, gpuTemp: null, gpuName: null, vramUsed: null, vramTotal: null, gpuClockMHz: null, vramClockMHz: null };

const { parseDisplaysJson } = require('./platform/darwin-displays.js');

function gpuStatic() {
  if (!held.gpuStaticPromise) {
    held.gpuStaticPromise = runSoft('system_profiler', ['SPDisplaysDataType', '-json'], 15000)
      .then((out) => (out === null ? { gpuName: null, vramTotal: null } : parseDisplaysJson(out)))
      .catch(() => ({ gpuName: null, vramTotal: null }));
  }
  return held.gpuStaticPromise;
}

async function gpu() {
  try {
    const [{ gpuName, vramTotal }, live] = await Promise.all([gpuStatic(), liveSensors()]);
    return {
      gpu: live.gpu,
      gpuTemp: live.gpuTemp,
      gpuName,
      // What the accelerator currently holds, when the helper could read it.
      // macmon does not report this, so it stays null on that path. Reported
      // even on Apple Silicon, where vramTotal is null because the GPU shares
      // system memory: js/system.js gates the whole VRAM readout on a positive
      // TOTAL, so the number is simply not shown rather than appearing next to
      // a "--" it cannot be a fraction of. On an Intel Mac with a discrete card
      // both halves are real and the readout works.
      vramUsed: live.vramUsed,
      vramTotal,
      // Apple reports a GPU frequency but no separate memory clock: unified
      // memory has no clock of its own to report.
      gpuClockMHz: live.gpuClockMHz,
      vramClockMHz: null,
    };
  } catch {
    return { ...EMPTY_GPU };
  }
}

// --- CPU temperature --------------------------------------------------------
async function cpuTemp() {
  const live = liveSensors();
  return { cpuTemp: live.cpuTemp, cpuClockMHz: live.cpuClockMHz };
}

// --- Sensor catalog (Settings → Sensor sources, the SDK `sensors` stream) ----
// Empty on a Mac, honestly: the helper and macmon each answer one CPU and one
// GPU temperature already chosen for us, with no per-sensor names to pick from.
// The picker reads the empty list and says there is nothing to choose here.
async function listSensors() { return []; }
async function readSensors() { return []; }

const {
  parseMountTypes, parseDisks, disks, parseIoregDisks, diskIo,
} = require('./platform/darwin-disks.js');

const { parsePing, parseNetstatIb, network } = require('./platform/darwin-network.js');

const {
  PROTECTED_APPS, LIST_APPS_SCRIPT, parseAppList, parseHelperWindows, osa, osaWrite, quitAppArgs,
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
  parseVolumeSettings, parseAudioDevices, AUDIO_DEVICES_TTL_MS, buildAudioRows,
  SAS_MISSING_RETRY_MS, withCurrentOutput, AUDIO_ROWS_TTL_MS, isCaptureTarget, AUDIO_PROBE_RETRY_MS,
} = require('./platform/darwin-audio.js');


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
