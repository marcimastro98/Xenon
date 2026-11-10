'use strict';
// Performance Mode's work on the server, with no PowerShell in the path: the process
// table, the power plan, the priority boost, Core Shield and the numbers for the sheet.
// The OS decides here and nowhere else; everything below this file has one job.

const os = require('os');
const { aggregate } = require('../process-stats');
const { createWindowsProcessTable } = require('./process-table-windows');
const { createPowerPlan } = require('./power-plan');
const { createPriority } = require('./priority');
const { createCoreShield } = require('./core-shield');
const { createLedger } = require('./ledger');
const { createWindowsFence } = require('./fence-windows');
const { createLinuxFence } = require('./fence-linux');
const { createDarwinFence } = require('./fence-darwin');
const { createCulpritWatch } = require('./culprit');

const STATS_WINDOW_MS = 350;
const STATS_TOP_APPS = 40;
const BYTES_PER_MB = 1024 * 1024;

const NO_TABLE = Object.freeze({ read: async () => null, available: () => false });
const NO_FENCE = Object.freeze({ ready: async () => null, apply: async () => null, clear: async () => false });
const FENCES = Object.freeze({ win32: createWindowsFence, linux: createLinuxFence, darwin: createDarwinFence });

function createProcessTable(collectors, platform) {
  if (collectors && typeof collectors.processTable === 'function') {
    return { read: () => collectors.processTable(), available: () => true };
  }
  return platform === 'win32' ? createWindowsProcessTable() : NO_TABLE;
}

const asSample = (rows) => new Map(rows.map((r) => [r.pid, { name: r.name, cpuMs: r.cpuMs, rss: r.memBytes }]));

// The sheet's numbers, the shape performance.ps1 `stats` answers with: memory, and the
// top apps by RAM with their CPU over a short window. Null when the table cannot be read.
async function readStats(table) {
  const first = await table.read();
  if (!first) return null;
  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, STATS_WINDOW_MS));
  const second = await table.read();
  if (!second) return null;
  const all = aggregate(asSample(first), asSample(second), { windowMs: Date.now() - startedAt, cores: os.availableParallelism() });
  return {
    ok: true,
    totalMB: Math.round(os.totalmem() / BYTES_PER_MB),
    freeMB: Math.round(os.freemem() / BYTES_PER_MB),
    apps: all.sort((a, b) => b.m - a.m).slice(0, STATS_TOP_APPS).map((a) => ({ proc: a.n, memMB: a.m, cpuPct: a.c })),
  };
}

function createPerfSession({ collectors, dataDir, platform = process.platform }) {
  const table = createProcessTable(collectors, platform);
  const makeFence = FENCES[platform];
  const shield = createCoreShield({
    table,
    fence: makeFence ? makeFence() : NO_FENCE,
    ledger: createLedger({ dataDir }),
    logicalCpus: os.availableParallelism(),
  });
  return {
    table,
    plan: platform === 'win32' ? createPowerPlan() : null,
    priority: createPriority({ table }),
    shield,
    stats: () => readStats(table),
    // The program that weighs on the PC while the stutter watch blames it (culprit.js).
    culprit: createCulpritWatch({ read: () => readStats(table), available: () => table.available() }),
  };
}

module.exports = { createPerfSession };
