'use strict';
// The fence on Windows: a process's default CPU sets, and BelowNormal so it gives way
// on the cores it shares with whatever else lands there.
//
// CPU sets are a preference the scheduler keeps, not an affinity mask: they need only
// PROCESS_SET_LIMITED_INFORMATION, a thread that picked its own cores keeps them, and
// the game is never opened at all, so anti-cheat has nothing to object to.
//
// Measured, and why the shield follows children: a child does NOT get its parent's
// CPU sets, and DOES get BelowNormal. EcoQoS is not used: it made frames worse.

const os = require('os');
const { pickFence } = require('./fence-pick');

const PROCESS_SET_LIMITED_INFORMATION = 0x2000;
const { PRIORITY_NORMAL: NORMAL, PRIORITY_BELOW_NORMAL: BELOW } = os.constants.priority;

// SYSTEM_CPU_SET_INFORMATION rows are read by their own size, which may grow.
const ROW = Object.freeze({ size: 0, id: 8, group: 12, core: 15, efficiency: 18 });
const CORES_PER_GROUP = 256;

function parseCpuSets(buffer, length) {
  const units = [];
  for (let at = 0; at + ROW.efficiency < length;) {
    const size = buffer.readUInt32LE(at + ROW.size);
    if (!size) break;
    units.push({
      id: buffer.readUInt32LE(at + ROW.id),
      core: buffer.readUInt16LE(at + ROW.group) * CORES_PER_GROUP + buffer[at + ROW.core],
      efficiency: buffer[at + ROW.efficiency],
    });
    at += size;
  }
  return units;
}

function loadNative() {
  const koffi = require('koffi');
  const kernel32 = koffi.load('kernel32.dll');
  return {
    open: kernel32.func('void * __stdcall OpenProcess(uint32, int, uint32)'),
    close: kernel32.func('int __stdcall CloseHandle(void *)'),
    cpuSets: kernel32.func('int __stdcall GetSystemCpuSetInformation(void *, uint32, _Out_ uint32 *, void *, uint32)'),
    setDefault: kernel32.func('int __stdcall SetProcessDefaultCpuSets(void *, uint32 *, uint32)'),
  };
}

function readUnits(api) {
  const needed = [0];
  api.cpuSets(null, 0, needed, null, 0);
  const buffer = Buffer.alloc(needed[0]);
  if (!needed[0] || !api.cpuSets(buffer, buffer.length, needed, null, 0)) return [];
  return parseCpuSets(buffer, needed[0]);
}

function createWindowsFence({ load = loadNative, system = os } = {}) {
  let api = null;
  let plan = null;
  let tried = false;

  function prepare() {
    if (tried) return;
    tried = true;
    try {
      api = load();
      plan = pickFence(readUnits(api));
    } catch { plan = null; }
  }

  function setCpuSets(pid, ids) {
    prepare();
    if (!api) return false;
    const handle = api.open(PROCESS_SET_LIMITED_INFORMATION, 0, pid);
    if (!handle) return false;
    try {
      return !!(ids ? api.setDefault(handle, Uint32Array.from(ids), ids.length) : api.setDefault(handle, null, 0));
    } finally { api.close(handle); }
  }

  // The priority a child of a moved app already took from it is the parent's doing,
  // so it goes back to what the parent had. An app the user set higher keeps its level.
  function lowerPriority(row, parent) {
    const level = system.getPriority(row.pid);
    if (level === NORMAL) {
      system.setPriority(row.pid, BELOW);
      return NORMAL;
    }
    return level === BELOW && parent ? parent.priority : undefined;
  }

  async function ready() {
    prepare();
    return plan ? { cores: plan.cores } : null;
  }

  // Null when the process refused (elevated, protected, gone).
  async function apply(row, parent) {
    prepare();
    if (!plan || !setCpuSets(row.pid, plan.ids)) return null;
    let priority;
    try { priority = lowerPriority(row, parent); } catch { /* the cores alone still help */ }
    return { priority };
  }

  async function clear(record) {
    const cleared = setCpuSets(record.pid, null);
    if (record.priority === undefined) return cleared;
    try {
      // Moved by hand in the meantime: that choice stands.
      if (system.getPriority(record.pid) === BELOW) system.setPriority(record.pid, record.priority);
    } catch { return false; }
    return cleared;
  }

  return { ready, apply, clear };
}

module.exports = { createWindowsFence, parseCpuSets };
