// Cleans what the sensor readers send: a number or nothing, the list of graphics card fans, and
// the reasons sensors are unavailable.

// A collector reading → number, or null when the sensor reported nothing.
// Number(null) and Number('') are BOTH 0, so a bare Number.isFinite(Number(v))
// turns an absent sensor into a real "0 W" reading — the widgets would render
// a phantom 0 instead of their empty state.
const collectorNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// The GPU collector's per-fan RPM list → a clean [{name, rpm}], or null when the
// collector sent no `gpuFans` key at all (a failed/legacy read — the caller keeps
// whatever it had). An EMPTY array is a real answer, not a gap: it means the card
// reported no fan sensor, and it must clear the previous list rather than freeze
// stale RPM on screen forever. 0 RPM is likewise a real reading — a card in idle
// zero-RPM mode has genuinely stopped its fans — so it is kept.
function normalizeGpuFans(raw) {
  if (raw === null || raw === undefined) return null;
  // Windows PowerShell 5.1 unwraps a single-element array on serialize, so a
  // one-fan card arrives as a bare object.
  const list = Array.isArray(raw) ? raw : (typeof raw === 'object' ? [raw] : []);
  return list
    .filter(f => f && typeof f === 'object' && collectorNum(f.rpm) !== null)
    .map(f => ({ name: String(f.name || 'GPU Fan').slice(0, 48), rpm: Math.round(collectorNum(f.rpm)) }));
}

// Why the LHM-backed sensors (fan RPM, CPU/PSU watts) are unavailable, so the
// widgets can give the one hint that helps instead of guessing.
const SENSOR_ACCESS = new Set(['ok', 'needs_admin', 'missing']);

module.exports = { collectorNum, normalizeGpuFans, SENSOR_ACCESS };
