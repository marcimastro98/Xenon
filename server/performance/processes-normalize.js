// Checks the list of busiest programs that the reader sends, before it goes to widgets.

// The collector is ours, but this is still parsed input crossing a boundary:
// rebuild the shape explicitly rather than broadcasting whatever came back.
// `n` is a process name and reaches a third-party widget, so it is bounded here
// and must be rendered with textContent there (documented in WIDGET_SDK.md).
function normalizeProcesses(raw) {
  if (!raw || typeof raw !== 'object' || raw.ok !== true) return null;
  const clamp = (v, max) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(max, Math.round(n * 10) / 10);
  };
  // Graphics adapters, in the collector's stable order. A machine can have
  // several and a process is busy on ONE of them, so the per-app figures are
  // per adapter too; folding them together would produce a number describing no
  // piece of hardware and contradicting every per-card tile on the dashboard.
  const gpus = [];
  for (const g of (Array.isArray(raw.gpus) ? raw.gpus : [])) {
    if (!g || typeof g !== 'object') continue;
    const id = String(g.id == null ? '' : g.id).slice(0, 48).trim();
    if (!id) continue;
    gpus.push({ i: gpus.length, id, name: String(g.name == null ? '' : g.name).slice(0, 64).trim(), t: clamp(g.t, 100) });
    if (gpus.length >= 8) break;
  }
  const maxGpu = gpus.length;

  const apps = [];
  for (const a of (Array.isArray(raw.apps) ? raw.apps : [])) {
    if (!a || typeof a !== 'object') continue;
    const n = String(a.n == null ? '' : a.n).slice(0, 64).trim();
    if (!n) continue;
    const row = { n, c: clamp(a.c, 100), m: Math.round(clamp(a.m, 1024 * 1024)), g: clamp(a.g, 100) };
    if (a.gs && typeof a.gs === 'object' && maxGpu) {
      const gs = {};
      for (const [k, v] of Object.entries(a.gs)) {
        const idx = Number(k);
        if (!Number.isInteger(idx) || idx < 0 || idx >= maxGpu) continue;
        const val = clamp(v, 100);
        if (val > 0) gs[idx] = val;
      }
      if (Object.keys(gs).length) row.gs = gs;
    }
    apps.push(row);
    if (apps.length >= 48) break;
  }
  return {
    cpu: clamp(raw.cpu, 100),
    gpus,
    cores: Math.max(1, Math.round(Number(raw.cores) || 1)),
    totalMB: Math.max(0, Math.round(Number(raw.totalMB) || 0)),
    usedMB: Math.max(0, Math.round(Number(raw.usedMB) || 0)),
    gpuAvail: raw.gpuAvail === true,
    apps,
  };
}

module.exports = { normalizeProcesses };
