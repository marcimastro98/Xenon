'use strict';
// Reads temperatures, graphics load and processor clock out of what macmon and Xenon's own
// macOS helper print.

const { splitLines, isFiniteNum } = require('./darwin-read.js');

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

// A macmon usage field is either a bare ratio or the tuple [freq_mhz, ratio].
// Where the tuple form is used, the frequency is the live clock and is free to
// take — the sample is already parsed. A build that reports only the ratio
// leaves the clock null rather than inventing one.
function tupleFreq(v) {
  if (!Array.isArray(v) || v.length < 1) return null;
  const mhz = Number(v[0]);
  if (!Number.isFinite(mhz) || mhz < 1 || mhz > 20000) return null;
  return Math.round(mhz);
}

function parseMacmon(raw) {
  const empty = { cpuTemp: null, gpu: null, gpuTemp: null, cpuClockMHz: null, gpuClockMHz: null };
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

  // Apple Silicon splits the CPU into efficiency and performance clusters. The
  // performance cluster is what "CPU clock" means to anyone reading a monitor,
  // and it is the higher of the two whenever both are reported — same rule as
  // the fastest-core pick on the other two platforms.
  const pClock = tupleFreq(doc.pcpu_usage);
  const eClock = tupleFreq(doc.ecpu_usage);
  const cpuClockMHz = pClock !== null && eClock !== null ? Math.max(pClock, eClock) : (pClock ?? eClock);

  return {
    cpuTemp: isFiniteNum(cpuTemp) ? Math.round(cpuTemp * 10) / 10 : null,
    gpu: ratioToPct(gpuRatio),
    gpuTemp: isFiniteNum(gpuTemp) ? Math.round(gpuTemp * 10) / 10 : null,
    cpuClockMHz,
    gpuClockMHz: tupleFreq(doc.gpu_usage),
  };
}

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

module.exports = { pickNum, ratioToPct, tupleFreq, parseMacmon, parseHelperTemps };
