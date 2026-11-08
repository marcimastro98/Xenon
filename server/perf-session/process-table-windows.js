'use strict';
// Every process on this PC in one call, the table Task Manager reads:
// NtQuerySystemInformation(SystemProcessInformation). A PowerShell reading of the
// same facts costs about 730 ms and 1400 ms of CPU; this one a few milliseconds of
// a worker thread, and it starts no process while a game runs.
//
// The offsets below are the 64-bit layout (x64 and arm64), stable since Windows XP.

const { boundedCall: call } = require('../hid/bounded-call');
const { processKey } = require('./process-names');

const SYSTEM_PROCESS_INFORMATION = 5;
const STATUS_INFO_LENGTH_MISMATCH = 0xC0000004;
const FIRST_SIZE = 1 << 20;
const MAX_SIZE = 64 << 20;
const TRIES = 4;
const NS100_PER_MS = 10000n;
// 0 is the idle process and 4 the kernel: nothing a person would call an app.
const LAST_SYSTEM_PID = 4;

const ENTRY = Object.freeze({
  next: 0, createTime: 32, userTime: 40, kernelTime: 48, nameLength: 56, namePointer: 64,
  pid: 80, parentPid: 88, session: 100, workingSet: 144, size: 152,
});

// One row per process. The image name sits inside the same buffer, at the address
// the kernel wrote, so `base` is where this buffer lives in memory.
function parseProcessTable(buffer, length, base) {
  const rows = [];
  for (let at = 0; at + ENTRY.size <= length;) {
    const pid = Number(buffer.readBigUInt64LE(at + ENTRY.pid));
    if (pid > LAST_SYSTEM_PID) {
      const bytes = buffer.readUInt16LE(at + ENTRY.nameLength);
      const start = Number(buffer.readBigUInt64LE(at + ENTRY.namePointer) - base);
      const inside = start >= 0 && start + bytes <= length;
      const cpu = buffer.readBigInt64LE(at + ENTRY.userTime) + buffer.readBigInt64LE(at + ENTRY.kernelTime);
      rows.push({
        pid,
        ppid: Number(buffer.readBigUInt64LE(at + ENTRY.parentPid)),
        name: inside ? processKey(buffer.toString('utf16le', start, start + bytes)) : '',
        cpuMs: Number(cpu / NS100_PER_MS),
        memBytes: Number(buffer.readBigUInt64LE(at + ENTRY.workingSet)),
        startedAt: Number(buffer.readBigInt64LE(at + ENTRY.createTime) / NS100_PER_MS),
        owner: buffer.readUInt32LE(at + ENTRY.session),
      });
    }
    const next = buffer.readUInt32LE(at + ENTRY.next);
    if (!next) break;
    at += next;
  }
  return rows;
}

function loadNative() {
  if (!['x64', 'arm64'].includes(process.arch)) throw new Error('unsupported layout');
  const koffi = require('koffi');
  const ntdll = koffi.load('ntdll.dll');
  return {
    query: ntdll.func('int32 __stdcall NtQuerySystemInformation(uint32, void *, uint32, _Out_ uint32 *)'),
    address: (buffer) => koffi.address(buffer),
  };
}

// `load` is a seam for the tests. Null from read() means nobody could answer, which
// is never the same as a process being gone.
function createWindowsProcessTable({ load = loadNative } = {}) {
  let api = null;
  let failed = false;
  let size = FIRST_SIZE;

  function native() {
    if (api || failed) return api;
    try { api = load(); } catch { failed = true; }
    return api;
  }

  async function read() {
    const a = native();
    if (!a) return null;
    for (let i = 0; i < TRIES && size <= MAX_SIZE; i += 1) {
      const buffer = Buffer.allocUnsafe(size);
      const needed = [0];
      let status;
      try { status = await call(a.query, SYSTEM_PROCESS_INFORMATION, buffer, size, needed); } catch { return null; }
      if (status >>> 0 === STATUS_INFO_LENGTH_MISMATCH) {
        // The list can grow between the two calls, so ask for some room on top.
        size = Math.ceil(Math.max(needed[0], size) * 1.25);
        continue;
      }
      if (status !== 0) return null;
      return parseProcessTable(buffer, needed[0], a.address(buffer));
    }
    return null;
  }

  return { read, available: () => !!native() };
}

module.exports = { createWindowsProcessTable, parseProcessTable, ENTRY };
