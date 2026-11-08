'use strict';
// The fence on macOS: taskpolicy marks a process as background, which on Apple silicon
// keeps its threads on the E cores and on Intel Macs lowers its CPU and disk priority.
// macOS gives no way to pick cores, so there is no count to report. `-B` takes it back,
// except for threads the app itself runs at the lowest QoS, which were there already.

const { execFile } = require('child_process');

const TASKPOLICY = '/usr/sbin/taskpolicy';
const TIMEOUT_MS = 4000;

function taskpolicy(args) {
  return new Promise((resolve, reject) => {
    execFile(TASKPOLICY, args, { timeout: TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()));
  });
}

function createDarwinFence({ run = taskpolicy, exists = require('fs').promises.access } = {}) {
  async function ready() {
    try { await exists(TASKPOLICY); return { cores: 0 }; } catch { return null; }
  }

  async function apply(row) {
    try { await run(['-b', '-p', String(row.pid)]); return {}; } catch { return null; }
  }

  async function clear(record) {
    try { await run(['-B', '-p', String(record.pid)]); return true; } catch { return false; }
  }

  return { ready, apply, clear };
}

module.exports = { createDarwinFence };
