// Where the scripts that read this PC's sensors, network, disks and idle time sit, and the
// worker that keeps them running.

const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

const CPU_TEMP_SCRIPT = path.join(SERVER_DIR, 'cpu-temp.ps1');
const ENABLE_SENSORS_SCRIPT = path.join(SERVER_DIR, 'enable-sensors.ps1'); // one UAC prompt: the sensor service

const GPU_SCRIPT = path.join(SERVER_DIR, 'gpu.ps1');
const NETWORK_SCRIPT = path.join(SERVER_DIR, 'network.ps1');
const DISK_IO_SCRIPT = path.join(SERVER_DIR, 'disk-io.ps1');

// Every LHM sensor by identifier, for Settings → Sensor sources and the SDK
// `sensors` stream. Worker-only like processes.ps1: it walks the sessions
// cpu-temp.ps1 and gpu.ps1 keep alive there and opens none of its own.
const SENSORS_SCRIPT = path.join(SERVER_DIR, 'sensors.ps1');

const IDLE_SCRIPT = path.join(SERVER_DIR, 'idle.ps1');

// ── Persistent PowerShell collector worker ───────────────────────────────────
// Spawning powershell.exe per poll (~150ms CLR+engine startup) is the server's
// dominant steady-state CPU cost. This long-lived host runs the read-only sensor
// collectors (gpu / cpu-temp / network) in one process, paying that cost once.
// Only exit-free, SMTC-free scripts go through it — media.ps1 has its own
// dedicated persistent host below (it holds WinRT broker handles and needs
// graceful retirement, while this worker may be hard-killed when wedged).
// Any worker problem falls back transparently to runPowerShellScript, so
// behaviour degrades to the one-shot model and never breaks.
const PWSH_WORKER_SCRIPT = path.join(SERVER_DIR, 'pwsh-worker.ps1');

module.exports = {
  CPU_TEMP_SCRIPT, ENABLE_SENSORS_SCRIPT, GPU_SCRIPT, NETWORK_SCRIPT, DISK_IO_SCRIPT,
  SENSORS_SCRIPT, IDLE_SCRIPT, PWSH_WORKER_SCRIPT,
};
