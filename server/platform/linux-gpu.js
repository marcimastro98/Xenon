'use strict';
// Linux graphics card readings in the shape gpu.ps1 gives: what nvidia-smi prints, and for AMD
// and Intel what the kernel says under /sys/class/drm.

const fsp = require('node:fs').promises;
const { isNum, splitLines } = require('./linux-read.js');

// --- GPU: nvidia-smi, matching gpu.ps1's field order and byte units ----------
// gpu.ps1 queried: utilization.gpu,temperature.gpu,memory.used,memory.total,name
// and converted MiB -> bytes (value * 1048576). We reproduce that exactly.
// nvidia-smi is the NVIDIA path only; AMD and Intel are read straight from the
// kernel's DRM sysfs by parseSysfsGpu below, which needs no tool at all.
const EMPTY_GPU = { gpu: null, gpuTemp: null, gpuName: null, vramUsed: null, vramTotal: null, gpuClockMHz: null, vramClockMHz: null };
// The name is LAST and rejoined (model names contain commas), so every field
// added to the query above goes BEFORE it and the length guard moves with it.
function parseGpu(out) {
  const first = splitLines(String(out || '').trim())[0] || '';
  const p = first.split(',').map((s) => s.trim());
  if (p.length < 7) return { ...EMPTY_GPU };
  return {
    gpu: isNum(p[0]) ? Math.round(Number(p[0])) : null,
    gpuTemp: isNum(p[1]) ? Math.round(Number(p[1])) : null,
    vramUsed: isNum(p[2]) ? Math.round(Number(p[2])) * 1048576 : null,
    vramTotal: isNum(p[3]) ? Math.round(Number(p[3])) * 1048576 : null,
    // "[N/A]" on a card or driver that does not report a clock — isNum rejects
    // it and the field stays null, which the server reads as "no answer".
    gpuClockMHz: isNum(p[4]) ? Math.round(Number(p[4])) : null,
    vramClockMHz: isNum(p[5]) ? Math.round(Number(p[5])) : null,
    gpuName: p.slice(6).join(', ').trim() || null,
  };
}
// --- GPU without nvidia-smi: the kernel's own DRM sysfs -----------------------
// AMD (amdgpu) publishes load, VRAM and temperature as plain files, so a machine
// with a Radeon needs no extra tool at all. Intel publishes far less: `i915`/
// `xe` expose a temperature on recent kernels and nothing else a shell can read
// (utilisation needs perf counters or intel_gpu_top as root), and an integrated
// GPU has no separate VRAM — 0 is the honest answer there, not a missing one.
//
// Pure so it can be tested off Linux: the caller reads the files, this decides
// what they mean.
const GPU_DRIVER_NAMES = { amdgpu: 'AMD GPU', radeon: 'AMD GPU', i915: 'Intel GPU', xe: 'Intel GPU' };

// --- Intel activity from RC6 residency ---------------------------------------
// Intel publishes no `gpu_busy_percent`, and the utilisation the PMU can give
// needs perf permissions this backend deliberately does not have: it runs as the
// user, with no capabilities, and `perf_event_paranoid` is 2 on a stock Fedora.
// So the tile showed "--%" on every Intel machine, which is most laptops.
//
// `power/rc6_residency_ms` is readable by anyone and counts the milliseconds the
// render engine spent in its deepest sleep state. The complement of its rate is
// the share of wall-clock time the GPU was awake. That is NOT execution-unit
// utilisation — an awake-but-lightly-loaded GPU counts as busy — so it reads
// higher than nvidia-smi would for the same work. It is a real, responsive
// measurement of the same underlying thing, and it moves: measured on this
// port, idle desktop 10-11%, dashboard rendering 14-16%, first paint ~69%.
//
// Pure, given two samples, so the arithmetic is testable without a GPU.
function rc6Busy(prev, cur) {
  if (!prev || !cur) return null;
  const dRc6 = cur.rc6Ms - prev.rc6Ms;
  const dWall = cur.atMs - prev.atMs;
  // A counter that went backwards means the driver reloaded or the machine
  // suspended; a window that is too short cannot be divided meaningfully, and
  // one that is too long spans a sleep during which neither clock was running.
  if (!(dWall >= 500 && dWall <= 300000)) return null;
  if (!(dRc6 >= 0)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - (dRc6 * 100) / dWall)));
}

function parseSysfsGpu(snap) {
  const s = snap || {};
  const num = (v) => (isNum(v) ? Number(String(v).trim()) : null);
  const busy = num(s.busy);
  const used = num(s.vramUsed);
  const total = num(s.vramTotal);
  // hwmon reports millidegrees. A card that lists several sensors labels them
  // (edge / junction / mem on AMD); `edge` is the one comparable to what every
  // other platform calls the GPU temperature, so it wins when present.
  let tempMilli = null;
  for (const t of Array.isArray(s.temps) ? s.temps : []) {
    if (!t || !isNum(t.value)) continue;
    const label = String(t.label || '').trim().toLowerCase();
    if (tempMilli === null || label === 'edge') tempMilli = Number(t.value);
    if (label === 'edge') break;
  }
  return {
    gpu: busy === null ? null : Math.max(0, Math.min(100, Math.round(busy))),
    // Millidegrees only above a plausible ceiling: some drivers already report
    // degrees, and dividing those by 1000 would silently report 0.
    gpuTemp: tempMilli === null ? null : Math.round(tempMilli > 200 ? tempMilli / 1000 : tempMilli),
    vramUsed: used === null ? null : used,
    vramTotal: total === null ? null : total,
    gpuName: GPU_DRIVER_NAMES[String(s.driver || '').trim()] || null,
  };
}

const SYSFS_DRM = '/sys/class/drm';

async function readOrNull(file) {
  try { return String(await fsp.readFile(file, 'utf8')).trim(); } catch { return null; }
}

// Read one card's files into the snapshot parseSysfsGpu expects.
async function readCardSnapshot(dir) {
  const uevent = await readOrNull(`${dir}/device/uevent`);
  const driver = uevent ? (/^DRIVER=(.+)$/m.exec(uevent) || [])[1] : null;
  const temps = [];
  try {
    const hwmonRoot = `${dir}/device/hwmon`;
    for (const h of await fsp.readdir(hwmonRoot)) {
      for (let i = 1; i <= 3; i++) {
        const value = await readOrNull(`${hwmonRoot}/${h}/temp${i}_input`);
        if (value === null) continue;
        temps.push({ value, label: await readOrNull(`${hwmonRoot}/${h}/temp${i}_label`) });
      }
    }
  } catch { /* no hwmon for this card */ }
  return {
    driver: driver ? driver.trim() : null,
    busy: await readOrNull(`${dir}/device/gpu_busy_percent`),
    vramUsed: await readOrNull(`${dir}/device/mem_info_vram_used`),
    vramTotal: await readOrNull(`${dir}/device/mem_info_vram_total`),
    // Only meaningful while RC6 is actually enabled. With it off the counter
    // never advances, and a rate computed from a frozen counter reads as a
    // permanently pegged 100% — the one wrong answer worse than no answer.
    rc6Enabled: (await readOrNull(`${dir}/power/rc6_enable`)) === '1',
    rc6Ms: Number(await readOrNull(`${dir}/power/rc6_residency_ms`)),
    temps,
  };
}

// Last RC6 sample per card, so the next poll can turn two readings into a rate.
// server.js polls this collector on its own timer; the first call after a boot
// therefore has nothing to compare against and reports null, exactly as it did
// before — one poll of "--", then numbers.
const _rc6Last = new Map();

// The interesting card on a hybrid laptop is the discrete one, and sysfs has
// no "integrated" flag — but the discrete card is the one that answers with
// MORE: a load figure, a temperature and a dedicated-VRAM size. So candidates
// compete on completeness, with the bigger VRAM as the tie-break (a dGPU's
// dedicated memory dwarfs an APU's carve-out). The previous rule — first card
// with any non-null load wins — locked in the iGPU, because an idle iGPU's
// busy reading is 0, which is non-null, and the discrete card was then read
// and thrown away on every poll. Pure and exported so the selection is
// testable off-platform, where sysfs itself cannot be.
function betterGpuCandidate(best, next) {
  if (!best) return next;
  if (!next) return best;
  const score = (p) => (p.gpu !== null ? 2 : 0) + (p.gpuTemp !== null ? 1 : 0) + (p.vramTotal !== null ? 1 : 0);
  const a = score(best);
  const b = score(next);
  if (b > a) return next;
  if (b === a && (next.vramTotal || 0) > (best.vramTotal || 0)) return next;
  return best;
}

async function sysfsGpu() {
  let cards;
  try {
    // cardN only: the cardN-HDMI-A-1 entries are connectors, not devices.
    cards = (await fsp.readdir(SYSFS_DRM)).filter((n) => /^card\d+$/.test(n)).sort();
  } catch { return null; }
  let best = null;
  for (const name of cards) {
    const snap = await readCardSnapshot(`${SYSFS_DRM}/${name}`);
    if (!snap.driver) continue;
    const parsed = parseSysfsGpu(snap);
    // amdgpu answers `gpu_busy_percent` directly and needs none of this. Intel
    // has no such file, so the load comes from how much of the interval since
    // the last poll the GPU spent out of RC6.
    if (parsed.gpu === null && snap.rc6Enabled && Number.isFinite(snap.rc6Ms)) {
      const cur = { rc6Ms: snap.rc6Ms, atMs: Date.now() };
      parsed.gpu = rc6Busy(_rc6Last.get(name), cur);
      _rc6Last.set(name, cur);
    }
    // Every card is read: there are at most a handful, and an early break on
    // "good enough" is what used to hide the discrete card behind the iGPU.
    best = betterGpuCandidate(best, parsed);
  }
  return best;
}

// A PC with no NVIDIA driver has no nvidia-smi. Remembered for a while, so an AMD or
// Intel machine does not try the spawn at every sensor read.
const NVIDIA_SMI_RETRY_MS = 5 * 60 * 1000;

module.exports = {
  EMPTY_GPU, parseGpu, GPU_DRIVER_NAMES, rc6Busy, parseSysfsGpu, SYSFS_DRM, readOrNull,
  readCardSnapshot, _rc6Last, betterGpuCandidate, sysfsGpu, NVIDIA_SMI_RETRY_MS,
};
