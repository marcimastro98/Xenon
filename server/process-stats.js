'use strict';
// Pure aggregation for the `processes` stream, shared by the Linux and macOS
// collectors. Windows does the same job inside processes.ps1, because its
// numbers come off Windows performance counters and never reach Node as raw
// samples — but all three MUST produce the same shape, and the tests pin it.
//
// The one rule worth stating: CPU here is a DELTA between two samples, never an
// instantaneous read. Every platform's cheap process list reports cumulative CPU
// time, so the collector holds the previous sample and divides by the real
// elapsed window. That is what lets the poll run without a sampling sleep.

/**
 * Fold a per-pid sample pair into per-APP rows.
 *
 * @param {Map<number,{name:string,cpuMs:number,rss:number}>} prev previous sample
 * @param {Map<number,{name:string,cpuMs:number,rss:number}>} curr current sample
 * @param {object} opt
 * @param {number} opt.windowMs   real elapsed time between the two samples
 * @param {number} opt.cores      logical cores, to normalise CPU% to 0-100
 * @param {Map<number,number>=} opt.gpuByPid per-pid GPU%, when the platform has it
 * @returns {Array<{n:string,c:number,m:number,g:number}>} one row per app name
 */
function aggregate(prev, curr, opt) {
  const windowMs = Math.max(1, Number(opt && opt.windowMs) || 1);
  const cores = Math.max(1, Number(opt && opt.cores) || 1);
  const gpuByPid = (opt && opt.gpuByPid) || null;
  const rows = new Map();

  for (const [pid, cur] of curr) {
    const name = String(cur.name || '').toLowerCase();
    if (!name) continue;
    let row = rows.get(name);
    if (!row) { row = { n: name, cpuMs: 0, bytes: 0, gpu: 0 }; rows.set(name, row); }
    row.bytes += Number(cur.rss) || 0;
    const before = prev.get(pid);
    // A pid absent from the previous sample is a process that started inside the
    // window. It is counted for RAM but contributes no CPU: the alternative is
    // charging it its whole lifetime's CPU in one tick, which makes every freshly
    // launched app briefly appear to be pinning a core.
    if (before && Number.isFinite(before.cpuMs) && Number.isFinite(cur.cpuMs)) {
      const d = cur.cpuMs - before.cpuMs;
      if (d > 0) row.cpuMs += d;
    }
    if (gpuByPid && gpuByPid.has(pid)) row.gpu += gpuByPid.get(pid);
  }

  const out = [];
  for (const row of rows.values()) {
    const cpuPct = (row.cpuMs / windowMs) * 100 / cores;
    out.push({
      n: row.n,
      c: Math.round(Math.min(100, Math.max(0, cpuPct)) * 10) / 10,
      m: Math.round(row.bytes / (1024 * 1024)),
      g: Math.round(Math.min(100, Math.max(0, row.gpu)) * 10) / 10,
    });
  }
  return out;
}

/**
 * Keep the UNION of the top `n` rows by each metric, not the top `n` overall.
 * The widget renders three lists; a single sorted list means the RAM column can
 * only ever show apps that also happen to be busy on the CPU.
 * Rows scoring zero on a metric never enter on that metric's account.
 */
function topUnion(apps, n) {
  const keep = new Set();
  for (const key of ['c', 'm', 'g']) {
    const ranked = apps.slice().sort((a, b) => b[key] - a[key]).slice(0, Math.max(0, n | 0));
    for (const row of ranked) if (row[key] > 0) keep.add(row.n);
  }
  return apps.filter((row) => keep.has(row.n)).sort((a, b) => b.c - a.c);
}

/**
 * CPU% across EVERY row, before the top-N cut. The widget needs it: ten rows
 * adding up to less than the machine's own CPU figure looks like a bug, when the
 * difference is just the long tail of processes too small to list.
 */
function totalCpu(apps) {
  let sum = 0;
  for (const row of apps) sum += Number(row.c) || 0;
  return Math.round(Math.min(100, Math.max(0, sum)) * 10) / 10;
}

module.exports = { aggregate, topUnion, totalCpu };
