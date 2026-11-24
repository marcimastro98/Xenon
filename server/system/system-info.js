// The whole reading of the system that the System tile, the SDK system stream, Bit, Guardian
// and the lights share, with the sensor sources the person chose laid over it.

const os = require('node:os');
const { nativeCollectors } = require('./native-collectors.js');
const fpsMonitor = require('../performance/fps-monitor.js');
const { getCpuName } = require('./cpu.js');
const SensorSources = require('../js/system/sensor-sources.js');
const { hub } = require('../settings/current.js');
const { sensorReads } = require('./sensor-reads-state.js');
const { sensorCache } = require('./sensor-cache.js');
const { getCpuUsage } = require('./cpu-usage.js');
const { getAllDisksInfo } = require('../disk/all-disks-info.js');
const { ramInfo } = require('./engine-ram-info.js');
const { firstSystemReading } = require('./engine-first-reading.js');
const { readChosenSensors } = require('./sensors-read.js');
const { getCpuTemp } = require('./cpu-temp.js');
const { getGpuInfo } = require('./gpu-read.js');
const { rememberSystemInfo } = require('./latest-reading.js');

// What getSystemInfo can say without waiting for a source that has not answered yet.
function knownSystemSources() {
  return Promise.all([
    sensorReads.gpuCache, getAllDisksInfo({ waitForDetails: false }), ramInfo.known(), sensorCache.reading.cpuTemp,
    nativeCollectors ? nativeCollectors.memory() : null,
  ]);
}

// `partialOk` is for a page that is painting: until the first full read lands it gets
// what is known now, marked `partial`, and the feed brings the rest. Everyone else
// waits, because a reading that is missing must not read as a sensor that is gone.
async function getSystemInfo({ partialOk = false } = {}) {
  const { value: [gpu, disks, ramDetail, cpuTemp, mem], partial } = await firstSystemReading(Promise.all([
    getGpuInfo(), getAllDisksInfo(), ramInfo.get(), getCpuTemp(),
    // os.freemem() is ullAvailPhys on Windows — already "what a new workload
    // could get" — but only the truly free pages on macOS and Linux, where the
    // OS keeps that near zero on purpose. Same call, different meaning, so the
    // seam answers it per platform (see each collector's `memory()`); Windows
    // keeps the os module it always used.
    nativeCollectors ? nativeCollectors.memory() : null,
  ]), partialOk ? knownSystemSources : null);
  const totalMem = (mem && mem.total) || os.totalmem();
  const usedMem = mem ? mem.used : totalMem - os.freemem();

  // Fans: motherboard/CPU headers from the cpu collector (RPM), plus the GPU's
  // own fans — LHM gives RPM, nvidia-smi only a percent, so a fan entry carries
  // either `rpm` or `pct` and the client renders unit-aware.
  // `kind` is the typed discriminator clients key on ('mb' = a motherboard fan
  // header, 'psu' = the power supply's own fan, 'gpu' = on the graphics card) —
  // `name` is pure presentation, so a motherboard header literally named "GPU"
  // must never match.
  //
  // Only fans wired to a motherboard header report a tachometer here: fans on an
  // AIO pump, a Corsair Commander or any fan hub are invisible to the board, and
  // fans daisy-chained onto one header report as a single reading. The list is
  // therefore "what the hardware exposes", never "every fan in the case".
  const fans = sensorCache.reading.fans.map(f => ({ ...f }));
  // Prefer each fan's real tachometer over nvidia-smi's fan.speed, which is the
  // curve's TARGET: an idle card in zero-RPM mode reports a percent while the
  // fans are stopped. The percent stays the fallback for cards LHM can't read.
  if (Array.isArray(gpu.gpuFans) && gpu.gpuFans.length) {
    gpu.gpuFans.forEach(f => fans.push({ name: f.name, kind: 'gpu', rpm: f.rpm }));
  } else if (gpu.gpuFanRpm !== null && gpu.gpuFanRpm !== undefined) fans.push({ name: 'GPU', kind: 'gpu', rpm: gpu.gpuFanRpm });
  else if (gpu.gpuFanPct !== null && gpu.gpuFanPct !== undefined) fans.push({ name: 'GPU', kind: 'gpu', pct: gpu.gpuFanPct });

  // Power draw in watts. `total` is strictly CPU+GPU (labelled as such client-
  // side — never a whole-system estimate); `psu` appears only when a digital
  // PSU (Corsair HXi/RMi & co.) is visible to LHM.
  const cpuWatts = sensorCache.reading.cpuWatts;
  const gpuWatts = gpu.gpuWatts === undefined ? null : gpu.gpuWatts;
  const power = {
    cpu: cpuWatts,
    gpu: gpuWatts,
    psu: sensorCache.reading.psuWatts,
    total: (cpuWatts !== null && gpuWatts !== null) ? Math.round((cpuWatts + gpuWatts) * 10) / 10 : null,
  };

  const info = {
    now: new Date().toISOString(),
    hostname: os.hostname(),
    uptime: Math.round(os.uptime()),
    cpu: getCpuUsage(),
    cpuTemp,
    cpuName: getCpuName(),
    // Live clock speeds in MHz, null where the platform exposes none. Added for
    // the SDK's `system` stream, which forwards this payload untouched — so a
    // monitoring widget reads them with the grant it already has.
    cpuClockMHz: sensorCache.reading.cpuClockMHz,
    // Why the LHM-backed readings (cpuTemp, `fans`, power.cpu/psu) may be empty:
    // 'ok' | 'needs_admin' (LHM installed but unelevated → no kernel driver) |
    // 'missing'. Lets the widgets name the actual fix instead of guessing.
    sensorAccess: sensorCache.reading.sensorAccess,
    memory: {
      used: usedMem,
      total: totalMem,
      percent: Math.round((usedMem / totalMem) * 100),
    },
    ramName: ramDetail && ramDetail.name ? ramDetail.name : null,
    ramDetail,
    gpu: gpu.gpu,
    gpuName: gpu.gpuName,
    gpuTemp: gpu.gpuTemp,
    vramUsed: gpu.vramUsed,
    vramTotal: gpu.vramTotal,
    gpuClockMHz: gpu.gpuClockMHz === undefined ? null : gpu.gpuClockMHz,
    vramClockMHz: gpu.vramClockMHz === undefined ? null : gpu.vramClockMHz,
    // In-game frame rate, or null when nothing is being measured.
    //
    // It rides `system` rather than `status`, which is where it was asked for.
    // `status` is broadcast ONLY when it changes, plus a 30s heartbeat, because
    // its payload is identical tick after tick on an idle PC and every SSE event
    // wakes each connected renderer. FPS changes constantly, so putting it there
    // would turn a mostly-silent stream into a permanent 3s broadcast on every
    // open dashboard — reinstating exactly the idle cost that dedup removed.
    // `system` already broadcasts unconditionally every 5s, so this rides along
    // for the price of an in-memory read: PresentMon (or MangoHud on Linux)
    // fills the table continuously, and getCurrentFps only looks at it.
    fps: (() => { try { return fpsMonitor.getCurrentFps(); } catch { return null; } })(),
    fans,
    power,
    disks,
    // Which OS is answering. Tiles that have to explain an absence need it:
    // "no fan sensors" is a different sentence on a PC (install the companion,
    // re-run the installer) than on a Linux box, where the kernel publishes
    // every tachometer it can see and there is nothing to install. Sent with
    // the readings so a tile never has to render its explanation before it
    // knows which one is true.
    platform: process.platform,
  };

  // The user's sensor choices (Settings → Sensor sources) go over the automatic
  // readings HERE and nowhere else, so every consumer of this payload (system
  // tile, Deck, AI, lighting, Guardian, the SDK `system` stream) follows the
  // choice without knowing it exists. `sensorSources` says per metric where
  // the number came from.
  const sources = SensorSources.normalizeSensorSources(hub.settings && hub.settings.sensorSources);
  if (partial) info.partial = true;
  const unread = partial ? null : [];
  const readings = !partial && Object.keys(sources).length ? await readChosenSensors(sources) : unread;
  const out = SensorSources.applySensorSources(info, sources, readings, { cpuTemp: sensorCache.reading.cpuTempSource });
  if (!partial) rememberSystemInfo(out);
  return out;
}

module.exports = { knownSystemSources, getSystemInfo };
