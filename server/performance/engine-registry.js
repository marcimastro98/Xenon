// The engine's runner of Performance Mode: closing, reopening and prioritising apps through the
// one allowlist.

const fs = require('node:fs');
const { launchLinuxApp } = require('../programs/launch-linux-app.js');
const { createPerfRegistry } = require('../actions/perf-registry.js');
const { PERF_PRIORITY_SCRIPT } = require('./script-paths.js');
const { runPowerShellScript } = require('../powershell/run-command.js');
const { openExternalPath } = require('../deck/open-external-path.js');
const { runWindowsTool } = require('../windows-tiles/windows-tool.js');
const { perfSession } = require('../perf-session/engine-session.js');

// Performance Mode runner: guided, reversible app management. Side-effects are
// injected so the allowlist/validation stays the only execution path. The
// window helper does the graceful close and protected-process refusal.
const perfRegistry = createPerfRegistry({
  closeWindow: (id) => runWindowsTool(['close', id], 8000),
  openExternal: (p, args) => openExternalPath(p, args),
  launchApp: process.platform === 'linux' ? (p, args) => launchLinuxApp(p, args) : undefined,
  fileExists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
  setPriority: (name, level) => (perfSession.table.available()
    ? perfSession.priority.set(name, level)
    : runPowerShellScript(PERF_PRIORITY_SCRIPT, ['set', name, level === 'high' ? 'high' : 'normal'], 6000)),
  isRunning: (name) => perfSession.priority.isRunning(name),
});

module.exports = { perfRegistry };
