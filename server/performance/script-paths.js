// Where the scripts for the performance mode, the list of running programs and their priority
// sit.

const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

const PERFORMANCE_SCRIPT = path.join(SERVER_DIR, 'performance.ps1');
// Per-process CPU/RAM/GPU for the `processes` SDK stream. Runs ONLY on the
// persistent worker (see processes.ps1) — its numbers are deltas between calls,
// so a one-shot spawn would have to sleep for every one of them.
const PROCESSES_SCRIPT = path.join(SERVER_DIR, 'processes.ps1');

const PERF_PRIORITY_SCRIPT = path.join(SERVER_DIR, 'perf-priority.ps1');

module.exports = { PERFORMANCE_SCRIPT, PROCESSES_SCRIPT, PERF_PRIORITY_SCRIPT };
