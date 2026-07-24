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
//   * The app switcher needs Automation permission (System Events). Denied or
//     unprompted, it degrades to an empty list rather than an error.

'use strict';

const { execFile } = require('child_process');
const path = require('path');

// Promise wrapper around execFile with a hard timeout; resolves stdout.
function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || ''));
    });
  });
}

// Same as run(), but a failure resolves null instead of rejecting -- for the
// probes where "the tool is not installed" is an ordinary answer.
function runSoft(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''));
    });
  });
}

const splitLines = (text) => String(text || '').split(/\r?\n/);
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

// --- macmon: the only sudoless source of Apple Silicon temps / GPU load ------
// macmon's payload shape has changed across releases (temps moved under a
// `temp` object; `gpu_usage` used to be a [freq, ratio] tuple and is now a
// scalar `gpu_usage_ratio`). Rather than pin one version's layout we look each
// field up by name in both places, so a macmon upgrade cannot silently turn
// every reading into null.
function pickNum(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (isFiniteNum(obj[k])) return obj[k];
  }
  return null;
}

// Ratios are 0..1 in every macmon version; a few builds emitted 0..100 percent
// under the deprecated *_pct names. Anything above 1 is already a percentage.
function ratioToPct(v) {
  if (!isFiniteNum(v)) return null;
  return Math.round(v > 1 ? v : v * 100);
}

function parseMacmon(raw) {
  const empty = { cpuTemp: null, gpu: null, gpuTemp: null };
  // `macmon pipe` emits one JSON document per sample; take the last complete one.
  const lines = splitLines(raw).map((l) => l.trim()).filter(Boolean);
  let doc = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try { doc = JSON.parse(lines[i]); break; } catch { /* partial line */ }
  }
  if (!doc || typeof doc !== 'object') return empty;

  const temp = doc.temp && typeof doc.temp === 'object' ? doc.temp : doc;
  const cpuTemp = pickNum(temp, ['cpu_temp_avg', 'cpu_temp']);
  const gpuTemp = pickNum(temp, ['gpu_temp_avg', 'gpu_temp']);

  let gpuRatio = pickNum(doc, ['gpu_usage_ratio', 'gpu_active_ratio', 'gpu_usage_pct']);
  // Legacy tuple form: gpu_usage: [freq_mhz, ratio].
  if (gpuRatio === null && Array.isArray(doc.gpu_usage) && doc.gpu_usage.length > 1) {
    gpuRatio = isFiniteNum(doc.gpu_usage[1]) ? doc.gpu_usage[1] : null;
  }

  return {
    cpuTemp: isFiniteNum(cpuTemp) ? Math.round(cpuTemp * 10) / 10 : null,
    gpu: ratioToPct(gpuRatio),
    gpuTemp: isFiniteNum(gpuTemp) ? Math.round(gpuTemp * 10) / 10 : null,
  };
}

// One macmon sample costs its own interval (it measures over a window), so it
// must never sit on the request path. We serve the last sample and refresh in
// the background when it goes stale: the first poll after boot reports null,
// every later one reports a reading at most MACMON_TTL_MS old.
const MACMON_TTL_MS = 2500;
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

function macmonSample() {
  if (Date.now() - macmonCache.at > MACMON_TTL_MS) refreshMacmon();
  return macmonCache.data;
}

// --- the native helper: the same three numbers, with nothing to install -----
// `xenon-helper temps` reads GPU load from IOKit's public accelerator registry
// and the temperatures from the HID sensor services. It is preferred over
// macmon when it answers, and macmon stays as the fallback for the machines it
// cannot read (an Intel Mac exposes neither sensor family under those names).
// Both paths are optional and both degrade to null, which is what the tiles
// already render as "--".
const HELPER_EXE = path.join(__dirname, 'helper', 'xenon-helper');

// Pure, so the shape check is testable without a Mac. Returns null when the
// payload carries no reading at all, which is what makes the caller fall
// through to macmon instead of caching a row of nulls.
function parseHelperTemps(raw) {
  let doc;
  try { doc = JSON.parse(String(raw || '')); } catch { return null; }
  if (!doc || typeof doc !== 'object') return null;
  const temp = (v) => (isFiniteNum(v) && v > 1 && v < 150 ? Math.round(v * 10) / 10 : null);
  const pct = (v) => (isFiniteNum(v) ? Math.min(100, Math.max(0, Math.round(v))) : null);
  const bytes = (v) => (isFiniteNum(v) && v >= 0 ? Math.round(v) : null);
  const out = {
    cpuTemp: temp(doc.cpuTemp),
    gpu: pct(doc.gpu),
    gpuTemp: temp(doc.gpuTemp),
    vramUsed: bytes(doc.vramUsed),
  };
  const readSomething = out.cpuTemp !== null || out.gpu !== null || out.gpuTemp !== null;
  return readSomething ? out : null;
}

const HELPER_MAX_FAILURES = 3;
const HELPER_RETRY_MS = 5 * 60 * 1000;
let helperFailures = 0;
let helperNextTry = 0;

async function readHelperTemps() {
  if (helperFailures >= HELPER_MAX_FAILURES && Date.now() < helperNextTry) return null;
  // A one-shot read of two registries: fast, and a timeout here means something
  // is wrong rather than something is slow.
  const out = await runSoft(HELPER_EXE, ['temps'], 4000);
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
const EMPTY_SENSORS = { cpuTemp: null, gpu: null, gpuTemp: null, vramUsed: null };
let sensorCache = { data: { ...EMPTY_SENSORS }, at: 0 };
let sensorInFlight = null;

function refreshSensors() {
  if (sensorInFlight) return sensorInFlight;
  sensorInFlight = (async () => {
    const helper = await readHelperTemps();
    if (helper && helper.cpuTemp !== null && helper.gpu !== null && helper.gpuTemp !== null) {
      sensorCache = { data: helper, at: Date.now() };
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
const EMPTY_GPU = { gpu: null, gpuTemp: null, gpuName: null, vramUsed: null, vramTotal: null };

function parseDisplaysJson(raw) {
  let doc;
  try { doc = JSON.parse(raw); } catch { return { gpuName: null, vramTotal: null }; }
  const list = doc && Array.isArray(doc.SPDisplaysDataType) ? doc.SPDisplaysDataType : [];
  const card = list[0];
  if (!card || typeof card !== 'object') return { gpuName: null, vramTotal: null };
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
      // macmon does not report this, so it stays null on that path.
      vramUsed: live.vramUsed,
      vramTotal,
    };
  } catch {
    return { ...EMPTY_GPU };
  }
}

// --- CPU temperature --------------------------------------------------------
async function cpuTemp() {
  return { cpuTemp: liveSensors().cpuTemp };
}

// --- Disks: df + mount, matching getAllDisksInfo()'s drive object shape ------
// Only `/` and real volumes under /Volumes are surfaced. Everything under
// /System/Volumes is an APFS role volume (Preboot, VM, Update, the Data volume
// itself) that shares one container with `/`, so listing them would show the
// same disk four times with four different "used" numbers.
//
// Used is computed as total - free rather than read from df's Used column. On an
// APFS volume group the `/` row reports only the sealed system volume as used
// (about 10 GB) while its Available reflects the whole shared container, so the
// Used column would tell the user a 900 GB disk is 1% full.
function skipVolume(target) {
  if (target === '/') return false;
  if (!target.startsWith('/Volumes/')) return true;
  const name = target.slice('/Volumes/'.length);
  return /^(Recovery|Preboot|Update|xarts|iSCPreboot|Hardware)$/i.test(name) ||
         name.startsWith('com.apple.TimeMachine') ||
         name.startsWith('.timemachine');
}

// `mount` prints: /dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled)
function parseMountTypes(out) {
  const types = new Map();
  for (const line of splitLines(out)) {
    const m = line.match(/^(\S+)\s+on\s+(.+?)\s+\(([^,)]+)/);
    if (m) types.set(m[2], m[3].trim());
  }
  return types;
}

// `df -k -P -l` prints 1024-byte blocks with the mount point last.
function parseDisks(out, mountTypes) {
  const types = mountTypes instanceof Map ? mountTypes : new Map();
  const drives = [];
  const seen = new Set();
  for (const line of splitLines(String(out || '').trim()).slice(1)) {
    const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.*)$/);
    if (!m) continue;
    const target = m[6].trim();
    if (!target || skipVolume(target)) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    // df -k reports 1024-byte blocks; the rest of Xenon speaks bytes.
    const total = Number(m[2]) * 1024;
    const free = Number(m[4]) * 1024;
    if (!(total > 0)) continue;
    const used = Math.max(0, total - free);
    drives.push({
      drive: target,
      total,
      used,
      free,
      percent: Math.round((used / total) * 100),
      label: target === '/' ? 'System' : target.split('/').filter(Boolean).pop() || '',
      fileSystem: types.get(target) || '',
      driveType: target === '/' ? 'Fixed' : 'Removable',
    });
  }
  return drives;
}

async function disks() {
  try {
    // -l keeps this to local filesystems: a stale network mount can wedge df.
    const [dfOut, mountOut] = await Promise.all([
      run('df', ['-k', '-P', '-l'], 5000),
      runSoft('mount', [], 5000),
    ]);
    const drives = parseDisks(dfOut, parseMountTypes(mountOut || ''));
    return drives.length ? drives : null;
  } catch {
    return null;
  }
}

// --- Network: ping + netstat -ib, matching network.ps1's shape --------------
// server.js turns the rx/tx byte counters into down/up bandwidth via its own
// inter-poll delta, so all that is owed here is a pair of monotonic counters.
//
// BSD ping prints the same "min/avg/max/stddev = a/b/c/d ms" summary iputils
// does, so this parser is deliberately the twin of the Linux one.
function parsePing(out) {
  const m = String(out || '').match(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\s*ms/);
  if (!m) return { ping: null, latency: null };
  return { ping: Math.round(Number(m[2])), latency: Math.round(Number(m[3]) - Number(m[1])) };
}

async function pingStats() {
  try {
    // macOS ping takes -t (total timeout in seconds); -W is per-packet on Linux.
    return parsePing(await run('/sbin/ping', ['-c', '3', '-t', '5', '-n', '1.1.1.1'], 8000));
  } catch {
    return { ping: null, latency: null };
  }
}

// Physical interfaces only. Skipping the virtual ones is not just hygiene: the
// <Link#n> row of an interface without a hardware address (lo0, utun) has one
// fewer column, so counting them would read the wrong field entirely.
const VIRTUAL_IFACE = /^(lo|gif|stf|utun|bridge|awdl|llw|ap\d|anpi|vmenet|vnic|p2p|XHC)/;

// `netstat -ib` columns for a link row:
// Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
function parseNetstatIb(out) {
  let rx = 0;
  let tx = 0;
  const seen = new Set();
  for (const line of splitLines(out)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const iface = f[0];
    // One row per address family; the <Link#n> row alone carries the totals.
    if (!/^<Link#\d+>$/.test(f[2])) continue;
    if (VIRTUAL_IFACE.test(iface)) continue;
    if (seen.has(iface)) continue;
    seen.add(iface);
    rx += Number(f[6]) || 0;
    tx += Number(f[9]) || 0;
  }
  return { rx, tx };
}

async function readNetBytes() {
  const out = await runSoft('netstat', ['-ib'], 5000);
  return out === null ? { rx: 0, tx: 0 } : parseNetstatIb(out);
}

async function network() {
  const [{ ping, latency }, { rx, tx }] = await Promise.all([pingStats(), readNetBytes()]);
  return { ping, latency, rxBytes: rx, txBytes: tx, fps: null, gpuLatency: null };
}

// --- Open applications / app switcher: System Events -----------------------
// Xenon's /windows endpoint (list/focus/close) drives the "Open applications"
// widget through a Windows helper (windows.ps1, Win32 EnumWindows). The same
// JSON contract is reproduced here:
//   list  -> { windows: [ { id, title, app, path, active, minimized, icon } ] }
//   focus -> { ok }
//   close -> { ok, app, path }  (or { ok:false, error:'protected'|'not_found' })
// ids must satisfy server.js's /^\d{1,24}$/, so the process id is the id.
//
// This lists one entry per APPLICATION, not per window. macOS has no
// unprivileged per-window enumeration (AXUIElement needs Accessibility), and an
// app switcher that switches apps is the useful half of that anyway.
const MAX_WINDOWS = 24;

// Quitting these would log the user out or take the desktop down with it.
const PROTECTED_APPS = new Set([
  'Finder', 'System Events', 'loginwindow', 'Dock', 'SystemUIServer',
  'WindowManager', 'ControlCenter', 'NotificationCenter', 'Xenon',
]);

const LIST_APPS_SCRIPT = `
tell application "System Events"
  set out to ""
  repeat with p in (application processes whose background only is false)
    try
      set pnm to name of p
      set pid_ to unix id of p
      set isFront to frontmost of p
      set apath to ""
      try
        set apath to POSIX path of (file of p as alias)
      end try
      set wtitle to ""
      try
        set wtitle to name of first window of p
      end try
      set out to out & pid_ & tab & pnm & tab & apath & tab & isFront & tab & wtitle & linefeed
    end try
  end repeat
  return out
end tell`;

// `includeProtected` is for the close path only: a quit aimed at Finder has to
// be able to say so, and it cannot if the shell was already filtered out — the
// lookup would miss and report the window as gone instead.
function parseAppList(out, includeProtected) {
  const windows = [];
  for (const line of splitLines(out)) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length < 4) continue;
    const id = f[0].trim();
    if (!/^\d{1,24}$/.test(id)) continue;
    const app = (f[1] || '').trim();
    if (!app || (!includeProtected && PROTECTED_APPS.has(app))) continue;
    windows.push({
      id,
      title: (f[4] || '').trim() || app,
      app,
      path: (f[2] || '').trim(),
      active: (f[3] || '').trim() === 'true',
      minimized: false, // needs Accessibility; never guessed
      icon: null,
    });
    if (windows.length >= MAX_WINDOWS) break;
  }
  return windows;
}

const osa = (script, timeoutMs) => runSoft('osascript', ['-e', script], timeoutMs);
// Writes use this one. A failed osascript resolves null through runSoft, and
// swallowing that would confirm a volume change that never reached Core Audio —
// the Deck key would flash success while nothing moved. The Linux twin lets
// every wpctl write reject for exactly this reason.
async function osaWrite(script, timeoutMs) {
  const out = await osa(script, timeoutMs);
  if (out === null) throw new Error(`osascript failed: ${script}`);
  return out;
}

async function listApps(includeProtected) {
  // A denied (or never granted) Automation prompt lands here as null. An empty
  // list is the honest answer -- the widget says "no open windows" rather than
  // claiming a failure the user cannot act on.
  const out = await osa(LIST_APPS_SCRIPT, 10000);
  return out === null ? [] : parseAppList(out, includeProtected);
}

async function windows(action, id) {
  if (action === 'focus') {
    if (!/^\d{1,24}$/.test(String(id || ''))) return { ok: false, error: 'not_found' };
    const out = await osa(
      `tell application "System Events" to set frontmost of (first process whose unix id is ${Number(id)}) to true`,
      8000);
    return { ok: out !== null };
  }
  if (action === 'close') {
    if (!/^\d{1,24}$/.test(String(id || ''))) return { ok: false, error: 'not_found' };
    const list = await listApps(true);
    const hit = list.find((w) => w.id === String(Number(id)));
    if (!hit) return { ok: false, error: 'not_found' };
    if (PROTECTED_APPS.has(hit.app)) return { ok: false, error: 'protected', app: hit.app };
    // `quit` is the graceful close: the app gets to prompt about unsaved work,
    // which is what the Windows path's WM_CLOSE does too.
    const esc = hit.app.replace(/[\\"]/g, '\\$&');
    const out = await osa(`tell application "${esc}" to quit`, 8000);
    return out === null
      ? { ok: false, error: 'not_found', app: hit.app }
      : { ok: true, app: hit.app, path: hit.path };
  }
  return { windows: await listApps() };
}

// --- Audio: osascript + system_profiler, shaped as SoundVolumeView rows ------
// SoundVolumeView /scomma column indices (see the F.* map in server.js).
const F = { NAME: 0, TYPE: 1, DIR: 2, DEVICE_NAME: 3, DEFAULT: 4, STATE: 7, MUTED: 8, VOL_PCT: 10, CLI_ID: 18, PROC_PATH: 19, PROC_ID: 20, WINDOW_TITLE: 21 };

// `get volume settings` -> "output volume:50, input volume:75, alert volume:100,
// output muted:false". Missing values print as "missing value".
function parseVolumeSettings(out) {
  const num = (key) => {
    const m = String(out || '').match(new RegExp(key + ':\\s*(\\d+)'));
    return m ? Math.max(0, Math.min(100, Number(m[1]))) : null;
  };
  const muted = /output muted:\s*true/i.test(String(out || ''));
  return { output: num('output volume'), input: num('input volume'), muted };
}

// system_profiler's audio tree: one entry per device, with the default flags on
// the device itself. Names are the only durable identifier macOS exposes to a
// shell, so the name doubles as the row's id.
function parseAudioDevices(raw) {
  let doc;
  try { doc = JSON.parse(raw); } catch { return { outputs: [], inputs: [] }; }
  const roots = doc && Array.isArray(doc.SPAudioDataType) ? doc.SPAudioDataType : [];
  const outputs = [];
  const inputs = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n._items)) walk(n._items);
      const name = String(n._name || '').trim();
      if (!name) continue;
      const isOut = n.coreaudio_device_output === 'spaudio_yes' ||
                    n.coreaudio_default_audio_output_device === 'spaudio_yes' ||
                    n.coreaudio_default_audio_system_device === 'spaudio_yes';
      const isIn = n.coreaudio_device_input === 'spaudio_yes' ||
                   n.coreaudio_default_audio_input_device === 'spaudio_yes';
      if (isOut) {
        outputs.push({ name, isDefault: n.coreaudio_default_audio_output_device === 'spaudio_yes' });
      }
      if (isIn) {
        inputs.push({ name, isDefault: n.coreaudio_default_audio_input_device === 'spaudio_yes' });
      }
    }
  };
  walk(roots);
  return { outputs, inputs };
}

// Device names change only when hardware is plugged or unplugged, and
// system_profiler costs about a second, so this is cached far longer than the
// volume read that rides on top of it.
const AUDIO_DEVICES_TTL_MS = 30000;
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

// When system_profiler is unavailable or denied, the enumeration comes back
// empty and the mixer still has to show the two devices the volume read proves
// are there. These stand-in names are what the rows carry, so every consumer
// must resolve a device list through here — a writer that classified a target
// against the RAW list would not recognise "Microphone" as an input and would
// send a mic mute to the speakers instead.
const PLACEHOLDER_OUTPUT = 'Output';
const PLACEHOLDER_INPUT = 'Microphone';
function withPlaceholders(devices) {
  const d = devices || { outputs: [], inputs: [] };
  return {
    outputs: d.outputs && d.outputs.length ? d.outputs : [{ name: PLACEHOLDER_OUTPUT, isDefault: true }],
    inputs: d.inputs && d.inputs.length ? d.inputs : [{ name: PLACEHOLDER_INPUT, isDefault: true }],
  };
}

// Build rows matching SoundVolumeView's /scomma layout.
// Application rows are deliberately absent: see the header note.
function buildAudioRows(devices, vol) {
  const rows = [];
  const row = () => new Array(22).fill('');
  const add = (name, dir, isDefault, volume, muted) => {
    const r = row();
    r[F.NAME] = name;
    r[F.TYPE] = 'Device';
    r[F.DIR] = dir; // Render | Capture
    r[F.DEVICE_NAME] = name;
    r[F.DEFAULT] = isDefault ? dir : '';
    r[F.STATE] = 'Active';
    r[F.MUTED] = muted ? 'Yes' : 'No';
    r[F.VOL_PCT] = String(volume == null ? '' : volume);
    r[F.CLI_ID] = name; // the name is the only shell-visible device identifier
    rows.push(r);
  };

  const { outputs: outs, inputs: ins } = withPlaceholders(devices);
  // Only the default device's level is knowable from a shell, so the others
  // report an empty volume rather than a number copied from somewhere else.
  outs.forEach((d) => add(d.name, 'Render', d.isDefault, d.isDefault ? vol.output : null, d.isDefault ? vol.muted : false));
  ins.forEach((d) => add(d.name, 'Capture', d.isDefault, d.isDefault ? vol.input : null, d.isDefault ? vol.input === 0 : false));
  return rows;
}

const AUDIO_ROWS_TTL_MS = 900;
let audioRowsCache = { rows: null, at: 0 };

async function audioRows() {
  const now = Date.now();
  if (audioRowsCache.rows && (now - audioRowsCache.at) < AUDIO_ROWS_TTL_MS) {
    return audioRowsCache.rows;
  }
  const settings = await osa('get volume settings', 5000);
  // Let a failed read surface: an empty-but-working mixer would be a lie.
  if (settings === null) throw new Error('osascript volume read failed');
  const rows = buildAudioRows(await audioDevices(), parseVolumeSettings(settings));
  audioRowsCache = { rows, at: Date.now() };
  return rows;
}

// Is this write aimed at the capture side? Targets arrive as a device name, as
// SoundVolumeView's default selectors, or as "<binary>.exe" for a per-app write.
// `devices` must already carry the placeholders, because the name the caller
// holds came from a row built with them.
function isCaptureTarget(target, devices) {
  const t = String(target || '').trim();
  if (t === 'DefaultCaptureDevice') return true;
  if (t === 'DefaultRenderDevice') return false;
  const d = withPlaceholders(devices);
  return d.inputs.some((x) => x.name === t) && !d.outputs.some((x) => x.name === t);
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

// Cheap capability probe for /actions: can we read the system volume at all?
let _audioProbe = null;
async function audioAvailable() {
  if (_audioProbe === null) {
    _audioProbe = osa('get volume settings', 5000).then((out) => out !== null);
  }
  return _audioProbe;
}

module.exports = {
  gpu, disks, cpuTemp, network, windows, audioRows, audioCommand, audioAvailable,
  // exported for unit tests
  parseMacmon, parseHelperTemps, parseDisplaysJson, parseDisks, parseMountTypes, parsePing,
  parseNetstatIb, parseAppList, parseVolumeSettings, parseAudioDevices,
  buildAudioRows, isCaptureTarget, ratioToPct,
};
