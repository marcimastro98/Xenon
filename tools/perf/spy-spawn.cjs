// Preload for the server: logs every process it starts, with the second it happened. It does not
// see `fork`, nor what a child starts. Report the log with spawn-report.cjs.
//   SPAWN_LOG=<file> node -r ./tools/perf/spy-spawn.cjs server/server.js
const childProcess = require('child_process');
const fs = require('fs');

const WATCHED = ['spawn', 'execFile', 'exec', 'spawnSync', 'execFileSync', 'execSync'];

if (/server\.js$/.test(process.argv[1] || '') && process.env.SPAWN_LOG) {
  const startedAt = Date.now();
  for (const name of WATCHED) {
    const original = childProcess[name];
    childProcess[name] = function spied(cmd, args) {
      const seconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));
      const list = Array.isArray(args) ? args.map((arg) => String(arg).slice(0, 700)) : [];
      fs.appendFileSync(process.env.SPAWN_LOG, `${JSON.stringify({ s: seconds, name, cmd: String(cmd).slice(0, 200), args: list })}\n`);
      return original.apply(this, arguments);
    };
  }
}
