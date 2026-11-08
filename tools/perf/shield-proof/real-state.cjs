'use strict';
// What the OS really holds for a process, read apart from the code under test.

const fs = require('fs');
const os = require('os');

const LIMITED_INFORMATION = 0x1000;
const MAX_CPU_SETS = 64;

const allowedCpus = (statusText) => (/^Cpus_allowed_list:\s*(\S+)/m.exec(statusText) || [])[1] || null;

let kernel = null;
function windowsApi() {
  if (kernel) return kernel;
  const k32 = require('koffi').load('kernel32.dll');
  kernel = {
    open: k32.func('void* __stdcall OpenProcess(uint32, int, uint32)'),
    close: k32.func('int __stdcall CloseHandle(void*)'),
    cpuSets: k32.func('int __stdcall GetProcessDefaultCpuSets(void*, _Out_ uint32*, uint32, _Out_ uint32*)'),
  };
  return kernel;
}

function windowsCpuSets(pid) {
  const { open, close, cpuSets } = windowsApi();
  const handle = open(LIMITED_INFORMATION, 0, pid);
  if (!handle) return null;
  const count = [0];
  const ok = cpuSets(handle, new Uint32Array(MAX_CPU_SETS), MAX_CPU_SETS, count);
  close(handle);
  return ok ? count[0] : null;
}

function realState(pid, platform = process.platform) {
  const cores = platform === 'win32'
    ? windowsCpuSets(pid)
    : allowedCpus(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
  return { cores, priority: os.getPriority(pid) };
}

const sameState = (a, b) => a.cores === b.cores && a.priority === b.priority;

module.exports = { allowedCpus, realState, sameState };
