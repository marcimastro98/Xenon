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

const { run, runSoft, isFiniteNum } = require('./platform/darwin-read.js');


// --- Memory: vm_stat, because os.freemem() does not mean the same thing here --
// On Windows os.freemem() is ullAvailPhys, which already counts the standby
// pages the OS would hand back on demand. On macOS it is the Mach free_count
// and nothing else, and this OS deliberately keeps that near zero: measured on
// an idle 8 GB M2, os.freemem() answered 0.06 GB, so `total - free` reported
// 99% used and the RAM tile sat there permanently. It is the same figure on
// every Mac, which makes it useless rather than merely wrong.
//
// The replacement is Activity Monitor's own "Memory Used" — App Memory + Wired
// + Compressed — so the number on the dashboard is the number the user can
// check against Apple's own tool. Compressed memory is REAL occupancy (this
// machine had 698k pages compressed into 154k) and counting it as free would
// understate the pressure exactly when it matters.
function parseVmStat(out, totalBytes) {
  const text = String(out || '');
  const pageSize = Number((/page size of (\d+) bytes/.exec(text) || [])[1]) || 4096;
  const pages = (label) => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const anonymous = pages('Anonymous pages');
  const wired = pages('Pages wired down');
  const compressor = pages('Pages occupied by compressor');
  const purgeable = pages('Pages purgeable');
  const total = isFiniteNum(totalBytes) && totalBytes > 0 ? totalBytes : null;
  if (anonymous === null || wired === null || total === null) return null;
  // Purgeable pages are anonymous but reclaimable on demand — Apple excludes
  // them from App Memory, and so do we. `compressor` is absent on older vm_stat
  // builds; treating it as zero understates by that much rather than refusing
  // to report at all.
  const used = (Math.max(0, anonymous - (purgeable || 0)) + wired + (compressor || 0)) * pageSize;
  return { used: Math.min(total, used), total };
}

async function memory() {
  const out = await runSoft('vm_stat', [], 4000);
  const parsed = out === null ? null : parseVmStat(out, os.totalmem());
  // A machine whose vm_stat we cannot read still gets a reading, just the old
  // pessimistic one — never a blank tile.
  return parsed || { used: os.totalmem() - os.freemem(), total: os.totalmem() };
}

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
let macmonCache = { data: { cpuTemp: null, gpu: null, gpuTemp: null }, at: 0 };
let macmonInFlight = null;
let macmonFailures = 0;
let macmonNextTry = 0;

function refreshMacmon() {
  if (macmonInFlight) return macmonInFlight;
  if (macmonFailures >= MACMON_MAX_FAILURES && Date.now() < macmonNextTry) return null;
  macmonInFlight = runSoft('macmon', ['pipe', '-s', '1', '-i', String(MACMON_SAMPLE_MS)], 8000)
    .then((out) => {
      if (out === null) {
        macmonFailures++;
        if (macmonFailures >= MACMON_MAX_FAILURES) macmonNextTry = Date.now() + MACMON_RETRY_MS;
        return;
      }
      macmonFailures = 0;
      macmonCache = { data: parseMacmon(out), at: Date.now() };
    })
    .finally(() => { macmonInFlight = null; });
  return macmonInFlight;
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
let helperFailures = 0;
let helperNextTry = 0;

// A spawn that fails is the helper being absent, unsigned or broken, and it
// will fail identically for every mode — so that pin is SHARED, and one probe
// every five minutes is what an install without the helper costs. A mode that
// runs and answers "I cannot read this" is a different thing entirely and must
// not pin the others out: an Intel Mac reads no HID sensors and still has a
// perfectly good app switcher, which is why `temps` keeps its own counter for
// the fall-through to macmon below.
let helperDownUntil = 0;

async function runHelper(args, timeoutMs) {
  if (Date.now() < helperDownUntil) return null;
  const out = await runSoft(HELPER_EXE, args, timeoutMs);
  if (out === null) { helperDownUntil = Date.now() + HELPER_RETRY_MS; return null; }
  return out;
}

async function readHelperTemps() {
  if (helperFailures >= HELPER_MAX_FAILURES && Date.now() < helperNextTry) return null;
  // A one-shot read of two registries: fast, and a timeout here means something
  // is wrong rather than something is slow.
  const out = await runHelper(['temps'], 4000);
  const parsed = out === null ? null : parseHelperTemps(out);
  if (parsed === null) {
    helperFailures++;
    if (helperFailures >= HELPER_MAX_FAILURES) helperNextTry = Date.now() + HELPER_RETRY_MS;
    return null;
  }
  helperFailures = 0;
  return parsed;
}

// The live sample the collectors read. The helper answers first; macmon fills
// in only what the helper left null, so a machine where one source knows the
// temperatures and the other knows the GPU load reports both instead of
// whichever happened to run.
const SENSOR_TTL_MS = 2500;
const EMPTY_SENSORS = { cpuTemp: null, gpu: null, gpuTemp: null, vramUsed: null, cpuClockMHz: null, gpuClockMHz: null };
let sensorCache = { data: { ...EMPTY_SENSORS }, at: 0 };
let sensorInFlight = null;

function refreshSensors() {
  if (sensorInFlight) return sensorInFlight;
  sensorInFlight = (async () => {
    const helper = await readHelperTemps();
    if (helper && helper.cpuTemp !== null && helper.gpu !== null && helper.gpuTemp !== null) {
      // Complete for everything the helper can answer. It reads no clocks, and
      // spawning macmon purely for them would undo the point of this shortcut —
      // so they stay null here rather than costing a process every 2.5 seconds.
      sensorCache = { data: { ...helper, cpuClockMHz: null, gpuClockMHz: null }, at: Date.now() };
      return;                       // complete: macmon is not spawned at all
    }
    await refreshMacmon();
    const mac = macmonCache.data;
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
    sensorCache = { data: merged, at: Date.now() };
  })().catch(() => { /* keep the previous sample */ })
    .finally(() => { sensorInFlight = null; });
  return sensorInFlight;
}

// Never awaited on the request path: serve the last sample, refresh behind it.
function liveSensors() {
  if (Date.now() - sensorCache.at > SENSOR_TTL_MS) refreshSensors();
  return sensorCache.data;
}

// --- GPU: name/VRAM from system_profiler, load/temp from macmon -------------
// system_profiler takes seconds, and the answer never changes while the machine
// is running, so it is resolved once and memoised for the process lifetime.
const EMPTY_GPU = { gpu: null, gpuTemp: null, gpuName: null, vramUsed: null, vramTotal: null, gpuClockMHz: null, vramClockMHz: null };

function parseDisplaysJson(raw) {
  let doc;
  try { doc = JSON.parse(raw); } catch { return { gpuName: null, vramTotal: null }; }
  const list = doc && Array.isArray(doc.SPDisplaysDataType) ? doc.SPDisplaysDataType : [];
  // Switchable-graphics Intel Macs list BOTH GPUs, and the integrated one can
  // come first. The discrete card is the one with dedicated VRAM — an iGPU
  // only ever reports spdisplays_vram_shared — so it wins over a first-listed
  // iGPU instead of taking whatever enumeration order gives. Apple Silicon
  // lists exactly one entry and is untouched by the preference.
  let card = null;
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    if (!card || (String(c.spdisplays_vram || '').trim() && !String(card.spdisplays_vram || '').trim())) card = c;
  }
  if (!card) return { gpuName: null, vramTotal: null };
  const gpuName = String(card.sppci_model || card._name || '').trim() || null;
  // Discrete cards report e.g. "8 GB"; Apple Silicon reports nothing at all
  // because the GPU shares system memory -- null is the honest answer there.
  const vramRaw = String(card.spdisplays_vram || card.spdisplays_vram_shared || '').trim();
  const m = vramRaw.match(/^(\d+(?:\.\d+)?)\s*(MB|GB)$/i);
  const vramTotal = m
    ? Math.round(Number(m[1]) * (m[2].toUpperCase() === 'GB' ? 1073741824 : 1048576))
    : null;
  return { gpuName, vramTotal };
}

let gpuStaticPromise = null;
function gpuStatic() {
  if (!gpuStaticPromise) {
    gpuStaticPromise = runSoft('system_profiler', ['SPDisplaysDataType', '-json'], 15000)
      .then((out) => (out === null ? { gpuName: null, vramTotal: null } : parseDisplaysJson(out)))
      .catch(() => ({ gpuName: null, vramTotal: null }));
  }
  return gpuStaticPromise;
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

let audioDevicesCache = { data: null, at: 0 };
let audioDevicesInFlight = null;

function audioDevices() {
  const fresh = audioDevicesCache.data && (Date.now() - audioDevicesCache.at) < AUDIO_DEVICES_TTL_MS;
  if (fresh) return Promise.resolve(audioDevicesCache.data);
  if (!audioDevicesInFlight) {
    audioDevicesInFlight = runSoft('system_profiler', ['SPAudioDataType', '-json'], 15000)
      .then((out) => {
        const data = out === null ? { outputs: [], inputs: [] } : parseAudioDevices(out);
        audioDevicesCache = { data, at: Date.now() };
        return data;
      })
      .catch(() => ({ outputs: [], inputs: [] }))
      .finally(() => { audioDevicesInFlight = null; });
  }
  return audioDevicesInFlight;
}


let sasMissingAt = 0;
async function currentOutputName() {
  if (sasMissingAt && Date.now() - sasMissingAt < SAS_MISSING_RETRY_MS) return null;
  const out = await runSoft('SwitchAudioSource', ['-c', '-t', 'output'], 3000);
  if (out === null) { sasMissingAt = Date.now(); return null; }
  sasMissingAt = 0;
  return String(out).trim() || null;
}

let audioRowsCache = { rows: null, at: 0 };

async function audioRows() {
  const now = Date.now();
  if (audioRowsCache.rows && (now - audioRowsCache.at) < AUDIO_ROWS_TTL_MS) {
    return audioRowsCache.rows;
  }
  const settings = await osa('get volume settings', 5000);
  // Let a failed read surface: an empty-but-working mixer would be a lie.
  if (settings === null) throw new Error('osascript volume read failed');
  const devices = withCurrentOutput(await audioDevices(), await currentOutputName());
  const rows = buildAudioRows(devices, parseVolumeSettings(settings));
  audioRowsCache = { rows, at: Date.now() };
  return rows;
}

// macOS has no shell-reachable input mute, so a muted microphone is one held at
// zero. The pre-mute level is remembered here to restore it, the way the volume
// slider itself would.
let lastInputVolume = 75;

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
  audioRowsCache = { rows: null, at: 0 };

  if (action === '/SetVolume') {
    // The absolute actions need no read-back, and a Deck key held down would
    // otherwise pay for two osascript spawns per repeat instead of one.
    const pct = Math.max(0, Math.min(100, parseInt(list[2], 10) || 0));
    if (capture && pct > 0) lastInputVolume = pct;
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
    if (capture && next > 0) lastInputVolume = next;
    await osaWrite(`set volume ${scope} ${next}`, 5000);
    return;
  }
  if (action === '/Mute' || action === '/Unmute' || action === '/Switch') {
    const muted = capture ? (level === 0) : current.muted;
    const wantMuted = action === '/Switch' ? !muted : action === '/Mute';
    if (capture) {
      if (wantMuted && level > 0) lastInputVolume = level;
      await osaWrite(`set volume input volume ${wantMuted ? 0 : lastInputVolume}`, 5000);
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
    audioDevicesCache = { data: null, at: 0 };
    return;
  }
  throw new Error(`unsupported audio action "${action}"`);
}

let _audioProbe = null;
let _audioProbeAt = 0;
async function audioAvailable() {
  if (_audioProbe !== null) {
    const ok = await _audioProbe;
    if (ok || Date.now() - _audioProbeAt <= AUDIO_PROBE_RETRY_MS) return ok;
  }
  _audioProbeAt = Date.now();
  _audioProbe = osa('get volume settings', 5000).then((out) => out !== null);
  return _audioProbe;
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
let _procPrev = null;
let _procPrevAt = 0;

async function processes(top = 8) {
  let curr = await sampleProcesses();
  if (!curr) return { ok: false, error: 'ps_failed' };
  let now = Date.now();
  // First call, or a gap long enough that the delta would be a guess: prime with
  // a short window so THIS call already answers with real numbers.
  if (!_procPrev || !_procPrevAt || now - _procPrevAt > PROC_STALE_MS) {
    _procPrev = curr;
    _procPrevAt = now;
    await new Promise((r) => setTimeout(r, PROC_PRIME_MS));
    curr = await sampleProcesses();
    if (!curr) return { ok: false, error: 'ps_failed' };
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
