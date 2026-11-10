'use strict';
// The fence on Linux: CPU affinity through taskset, which any user may set on their
// own processes and take back. Nice is left alone: without privileges a process that
// was lowered could not be raised again.

const fsp = require('fs').promises;
const { execFile } = require('child_process');
const { pickFence } = require('./fence-pick');

const TIMEOUT_MS = 4000;

function taskset(args) {
  return new Promise((resolve, reject) => {
    execFile('taskset', args, { timeout: TIMEOUT_MS }, (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))));
  });
}

// "0-3,8,10-11" -> [0, 1, 2, 3, 8, 10, 11]
function parseCpuList(text) {
  const out = [];
  for (const part of String(text || '').trim().split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) continue;
    const last = m[2] === undefined ? Number(m[1]) : Number(m[2]);
    for (let n = Number(m[1]); n <= last; n += 1) out.push(n);
  }
  return out;
}

// /proc/cpuinfo blocks into the units pickFence ranks. ARM kernels print no core id,
// so each CPU counts as its own core. E-cores are listed apart on Intel hybrid chips.
function parseCpuInfo(text, efficient) {
  const small = new Set(efficient);
  const units = [];
  for (const block of String(text || '').split(/\n\s*\n/)) {
    const field = (name) => {
      const m = new RegExp('^' + name + '\\s*:\\s*(\\d+)', 'm').exec(block);
      return m ? Number(m[1]) : null;
    };
    const id = field('processor');
    if (id === null) continue;
    const core = field('core id');
    units.push({
      id,
      core: core === null ? id : (field('physical id') || 0) * 4096 + core,
      efficiency: small.has(id) ? 0 : 1,
    });
  }
  return units;
}

function createLinuxFence({ run = taskset, read = (file) => fsp.readFile(file, 'utf8') } = {}) {
  let plan;

  async function ready() {
    if (plan !== undefined) return plan && { cores: plan.cores };
    plan = null;
    try {
      await run(['--version']);
      const efficient = await read('/sys/devices/cpu_atom/cpus').then(parseCpuList, () => []);
      plan = pickFence(parseCpuInfo(await read('/proc/cpuinfo'), efficient));
    } catch { /* no taskset: nothing to offer */ }
    return plan && { cores: plan.cores };
  }

  // What the process had, to give it back exactly.
  async function allowedCpus(pid) {
    const m = /^Cpus_allowed_list:\s*(\S+)/m.exec(await read(`/proc/${pid}/status`));
    if (!m) throw new Error('no affinity');
    return m[1];
  }

  // A child sits on its parent's fence already: it goes back to the parent's old list.
  async function apply(row, parent) {
    if (!await ready()) return null;
    try {
      const cpus = parent && parent.cpus ? parent.cpus : await allowedCpus(row.pid);
      await run(['-a', '-c', '-p', plan.ids.join(','), String(row.pid)]);
      return { cpus };
    } catch { return null; }
  }

  async function clear(record) {
    if (!record.cpus) return false;
    try { await run(['-a', '-c', '-p', record.cpus, String(record.pid)]); return true; } catch { return false; }
  }

  return { ready, apply, clear };
}

module.exports = { createLinuxFence, parseCpuInfo, parseCpuList };
