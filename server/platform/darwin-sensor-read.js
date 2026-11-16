'use strict';
// Temperatures, the graphics card and the sensors on macOS, read live from the helper and from
// macmon.

const { runSoft } = require('./darwin-read.js');
const { parseMacmon, parseHelperTemps } = require('./darwin-sensor-text.js');
const { held } = require('./darwin-held.js');
const { HELPER_MAX_FAILURES, HELPER_RETRY_MS, runHelper } = require('./darwin-helper-run.js');
const { parseDisplaysJson } = require('./darwin-displays.js');

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
      // system memory: js/system/system.js gates the whole VRAM readout on a positive
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

module.exports = {
  MACMON_SAMPLE_MS, MACMON_MAX_FAILURES, MACMON_RETRY_MS, refreshMacmon, readHelperTemps,
  SENSOR_TTL_MS, EMPTY_SENSORS, refreshSensors, liveSensors, EMPTY_GPU, gpuStatic, gpu, cpuTemp,
  listSensors, readSensors,
};
