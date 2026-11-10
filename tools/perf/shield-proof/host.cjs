'use strict';
// Core Shield the way the server runs it, for index.mjs: real process table, real fence,
// real ledger, the same 3 s tick, the same recovery at start. The one difference is the
// table: it shows only the two apps the tool starts and this process, so an app of the
// real PC cannot be picked. A test on the side copy once moved one. By pid, because every
// Node 24 process reads "mainthread" on Linux.
//   node host.cjs <data folder> <game pid> <busy app pid>      stdin: on | off | quit

const path = require('path');
const readline = require('readline');

const SERVER = path.join(__dirname, '..', '..', '..', 'server');
const TICK_MS = 3000;
const GAME_NAME = 'stand-in-game';
const BUSY_NAME = 'busy-app';

const onlyOwn = (rows, pids) => (rows ? rows.filter((r) => pids.has(r.pid)) : rows);

function realTable() {
  if (process.platform === 'win32') {
    const { createWindowsProcessTable } = require(path.join(SERVER, 'perf-session', 'process-table-windows.js'));
    const table = createWindowsProcessTable();
    return () => table.read();
  }
  const collectors = process.platform === 'darwin' ? 'darwin-collectors.js' : 'linux-collectors.js';
  return require(path.join(SERVER, collectors)).processTable;
}

function main() {
  const { createPerfSession } = require(path.join(SERVER, 'perf-session', 'index.js'));
  const read = realTable();
  const [dataDir, gamePid, busyPid] = process.argv.slice(2).map((arg, i) => (i ? Number(arg) : arg));
  const own = new Set([process.pid, gamePid, busyPid]);
  const { shield } = createPerfSession({
    collectors: { processTable: async () => onlyOwn(await read(), own) },
    dataDir,
  });

  let active = false;
  const say = (fact) => process.stdout.write(JSON.stringify(fact) + '\n');
  const wish = () => (active
    ? { session: true, on: true, gamePid, gameName: GAME_NAME, foregroundPid: 0, keep: new Set() }
    : { session: false, on: false });
  const tick = async () => {
    await shield.sync(wish());
    say(await shield.status());
  };

  setInterval(tick, TICK_MS);
  shield.recover().then(() => say({ recovered: true }));

  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    if (line === 'on') active = true;
    if (line === 'off') active = false;
    if (line === 'quit') { await shield.stop(); process.exit(0); }
  });
}

if (require.main === module) main();

module.exports = { onlyOwn, GAME_NAME, BUSY_NAME };
