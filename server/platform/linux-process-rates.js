'use strict';
// The processes on Linux: one sample of all of them, the table, and the busiest ones between
// two samples.

const fsp = require('node:fs').promises;
const os = require('node:os');
// Shared with darwin-collectors.js: the delta/aggregation half of the
// `processes` stream is identical on both, and lives in one tested place.
const procStats = require('../performance/process-stats.js');
const { memory } = require('./linux-memory.js');
const { mapLimit } = require('./linux-read.js');
const { held } = require('./linux-held.js');
const { parseProcStat } = require('./linux-proc-stat.js');

async function pageSize() {
  if (held.pageBytes) return held.pageBytes;
  held.pageBytes = 4096;
  try {
    const self = parseProcStat(await fsp.readFile('/proc/self/stat', 'utf8'));
    const rssBytes = process.memoryUsage().rss;
    if (self && self.rssPages > 0 && rssBytes > 0) {
      const guess = rssBytes / self.rssPages;
      for (const candidate of [4096, 8192, 16384, 65536]) {
        if (guess >= candidate * 0.75 && guess <= candidate * 1.5) { held.pageBytes = candidate; break; }
      }
    }
  } catch { /* keep 4096 */ }
  return held.pageBytes;
}

async function sampleProcesses() {
  const size = await pageSize();
  let entries = [];
  try { entries = await fsp.readdir('/proc'); } catch { return null; }
  const pids = entries.filter((e) => /^\d+$/.test(e));
  const sample = new Map();
  // Bounded concurrency: /proc reads are cheap but a 500-process box would open
  // 500 descriptors in one tick without it.
  await mapLimit(pids, 64, async (dir) => {
    let raw = null;
    try { raw = await fsp.readFile('/proc/' + dir + '/stat', 'utf8'); } catch { return; }
    const row = parseProcStat(raw);
    if (row) sample.set(row.pid, { name: row.name, cpuMs: row.cpuMs, rss: row.rssPages * size });
  });
  return sample.size ? sample : null;
}

// Every process for Performance Mode, the rows process-table-windows.js gives. The owner
// is the uid: a process of another user is not this person's to move.
async function processTable() {
  const size = await pageSize();
  let entries = [];
  try { entries = await fsp.readdir('/proc'); } catch { return null; }
  const rows = [];
  await mapLimit(entries.filter((e) => /^\d+$/.test(e)), 64, async (dir) => {
    let raw = null;
    let info = null;
    try { [raw, info] = await Promise.all([fsp.readFile('/proc/' + dir + '/stat', 'utf8'), fsp.stat('/proc/' + dir)]); } catch { return; }
    const row = parseProcStat(raw);
    if (!row) return;
    rows.push({ pid: row.pid, ppid: row.ppid, name: row.name.toLowerCase(), cpuMs: row.cpuMs, memBytes: row.rssPages * size, startedAt: row.startTicks, owner: info.uid });
  });
  return rows.length ? rows : null;
}

const PROC_STALE_MS = 30000;
const PROC_PRIME_MS = 250;

async function processes(top = 8) {
  let curr = await sampleProcesses();
  if (!curr) return { ok: false, error: 'no_procfs' };
  let now = Date.now();
  // First call, or a gap long enough that the delta would be a guess: prime with
  // a short window so THIS call already answers with real numbers. Paid once per
  // stream start, never in the steady state.
  if (!held.procPrev || !held.procPrevAt || now - held.procPrevAt > PROC_STALE_MS) {
    held.procPrev = curr;
    held.procPrevAt = now;
    await new Promise((r) => setTimeout(r, PROC_PRIME_MS));
    curr = await sampleProcesses();
    if (!curr) return { ok: false, error: 'no_procfs' };
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
    // No per-adapter breakdown here: per-process GPU does not exist on Linux
    // without vendor-specific plumbing, so there is nothing to attribute.
    gpus: [],
    cores,
    totalMB: Math.round((mem.total || 0) / (1024 * 1024)),
    usedMB: Math.round((mem.used || 0) / (1024 * 1024)),
    gpuAvail: false,
    win: windowMs,
    apps,
  };
}

module.exports = {
  pageSize, sampleProcesses, processTable, PROC_STALE_MS, PROC_PRIME_MS, processes,
};
