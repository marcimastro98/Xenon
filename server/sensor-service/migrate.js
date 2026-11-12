'use strict';
// Before 5.1.0, "Enable sensors" raised the engine's own startup task to run
// elevated. The engine lives in a folder the user can write, so that handed
// administrator rights to any program able to change a file there. An engine
// that wakes up elevated with its task in place therefore moves itself to the
// sensor service: enable-sensors.ps1, already holding the rights, installs the
// service, sets the task back to normal rights and restarts the engine through
// it. No prompt: the user agreed to sensor access when the task was raised.
//
// At most once per version (a marker in DATA_DIR), so a step that fails can
// never turn into a restart loop. A manual `node server.js` from an elevated
// terminal has no task and is left alone.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { writeFileAtomic } = require('../atomic-write.js');

const MARKER = 'sensor-migration.json';
const TASK_NAME = 'Xenon Edge Widget';
const HIGH_INTEGRITY = 'S-1-16-12288';

function system32(env) {
  return path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32');
}

// Resolves the command's stdout, or null when it failed.
function runQuiet(run, file, args) {
  return new Promise((resolve) => {
    run(file, args, { windowsHide: true, timeout: 15000 }, (err, stdout) => resolve(err ? null : String(stdout || '')));
  });
}

async function readMarker(dataDir) {
  try { return JSON.parse(await fs.promises.readFile(path.join(dataDir, MARKER), 'utf8')); } catch { return null; }
}

async function migrateElevatedEngine({ dataDir, version, script, env = process.env, platform = process.platform, run = execFile, start = spawn } = {}) {
  if (platform !== 'win32' || !dataDir || !script) return 'skip';
  const sys = system32(env);
  const groups = await runQuiet(run, path.join(sys, 'whoami.exe'), ['/groups', '/fo', 'csv', '/nh']);
  if (!groups || !groups.includes(HIGH_INTEGRITY)) return 'not_elevated';
  if ((await runQuiet(run, path.join(sys, 'schtasks.exe'), ['/Query', '/TN', TASK_NAME])) === null) return 'no_task';
  const marker = await readMarker(dataDir);
  if (marker && marker.version === version) return 'done_before';
  await writeFileAtomic(path.join(dataDir, MARKER), JSON.stringify({ version, at: Date.now() }));
  const ps = path.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Never detached: a console-less powershell exits without running the script.
  // The script itself hands the work to a PowerShell outside this engine's job,
  // since it stops this engine before starting it again.
  const child = start(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'ignore', windowsHide: true });
  child.on('error', () => { /* the next version tries again */ });
  child.unref();
  return 'started';
}

module.exports = { migrateElevatedEngine, MARKER, HIGH_INTEGRITY };
