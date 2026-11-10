// Groups a log from spy-spawn.cjs: what ran, how many times, first and last second.
//   node tools/perf/spawn-report.cjs <log>
const fs = require('fs');

const POWERSHELL_NOISE = /^-(NoProfile|NonInteractive|ExecutionPolicy|EncodedCommand|File|Command)$/i;
const lastPart = (text) => text.replace(/^.*[\\/]/, '');

function spawnKey({ cmd, args }) {
  const shown = args.filter((arg) => !POWERSHELL_NOISE.test(arg) && arg !== 'Bypass').slice(0, 3).map((arg) => lastPart(arg).slice(0, 90));
  return [lastPart(cmd).slice(0, 40), ...shown].join(' ').trim();
}

function groupSpawns(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = spawnKey(row);
    const group = groups.get(key) || { key, count: 0, first: row.s, last: row.s };
    group.count += 1;
    group.last = row.s;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.first - b.first);
}

function main(logPath) {
  const rows = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  console.log(`${rows.length} spawns`);
  for (const { key, count, first, last } of groupSpawns(rows)) {
    console.log(`${String(count).padStart(4)}x  ${String(first).padStart(6)}s..${String(last).padEnd(6)}  ${key.slice(0, 130)}`);
  }
}

if (require.main === module) main(process.argv[2]);

module.exports = { groupSpawns };
