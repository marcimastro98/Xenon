// claude-run.js: the two answers it works out once and then remembers: where the Claude Code
// program is, and which options that program accepts. A found program is not looked for
// again; a missing one is, so installing it later needs no restart. The disk, the PATH lookup
// and the program's --help are the test's own.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cp = require('child_process');
const fs = require('fs');
const os = require('os');

const realExecFile = cp.execFile;
const realStat = fs.promises.stat;
const realHome = os.homedir;
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const HOME = path.join(os.tmpdir(), 'xenon-no-such-home');
const NATIVE_WIN = path.join(HOME, '.local', 'bin', 'claude.exe');
const NATIVE_POSIX = path.join(HOME, '.local', 'bin', 'claude');
const HELP = 'Usage: claude [options]\n  --effort <level>\n  --permission-mode <mode>  (choices: "acceptEdits", "default", "plan")\n';

let files;       // the files that exist
let onPath;      // what `where claude` / `which claude` prints
let lookups;     // every PATH lookup and --help run, in order
let stats;       // how many times the disk was asked

// A copy of claude-run.js that remembers nothing yet: its own files are loaded again.
function fresh(platform) {
  Object.defineProperty(process, 'platform', { value: platform });
  for (const key of Object.keys(require.cache)) if (!/node_modules/.test(key)) delete require.cache[key];
  return require('../claude-run.js');
}

beforeEach(() => {
  files = new Set();
  onPath = [];
  lookups = [];
  stats = 0;
  os.homedir = () => HOME;
  fs.promises.stat = async (file) => {
    stats += 1;
    if (!files.has(String(file))) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { isFile: () => true };
  };
  cp.execFile = (cmd, args, options, done) => {
    lookups.push([cmd, ...args]);
    if (cmd === 'where' || cmd === 'which') done(onPath.length ? null : new Error('not found'), onPath.join('\n'));
    else done(null, HELP);
  };
});

after(() => {
  cp.execFile = realExecFile;
  fs.promises.stat = realStat;
  os.homedir = realHome;
  Object.defineProperty(process, 'platform', realPlatform);
});

test('the installed program is found without asking PATH, and is looked for once', async () => {
  const run = fresh('win32');
  files.add(NATIVE_WIN);
  const first = await run.resolveExecutable();
  assert.deepEqual(first, { cmd: NATIVE_WIN, pre: [] });
  assert.deepEqual(lookups, []);
  const asked = stats;
  files.clear();
  assert.equal(await run.resolveExecutable(), first, 'the same answer, not a new search');
  assert.equal(stats, asked);
});

test('a program on PATH is used as it is', async () => {
  const posix = fresh('linux');
  onPath = ['/usr/local/bin/claude'];
  assert.deepEqual(await posix.resolveExecutable(), { cmd: '/usr/local/bin/claude', pre: [] });
  assert.deepEqual(lookups, [['which', 'claude']]);
  lookups.length = 0;
  const win = fresh('win32');
  onPath = [path.join('X:', 'tools', 'claude'), path.join('X:', 'tools', 'claude.exe')];
  assert.deepEqual(await win.resolveExecutable(), { cmd: onPath[1], pre: [] });
  assert.deepEqual(lookups, [['where', 'claude']]);
});

test('an npm shim is not run: its cli.js runs under node, and a shim without one is no program', async () => {
  const shim = path.join('X:', 'npm', 'claude.cmd');
  const cli = path.join('X:', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  const run = fresh('win32');
  onPath = [shim];
  assert.equal(await run.resolveExecutable(), null);
  files.add(cli);
  assert.deepEqual(await run.resolveExecutable(), { cmd: process.execPath, pre: [cli] }, 'nothing found is not remembered');
  assert.equal(lookups.length, 2);
  await run.resolveExecutable();
  assert.equal(lookups.length, 2, 'a found program is');
});

test('the options are read from --help once, and a missing program is asked again later', async () => {
  const run = fresh('linux');
  assert.deepEqual(await run.cliOptions(), { effort: false, modes: [] });
  assert.equal(lookups.some((call) => call.includes('--help')), false, 'no program, no --help');
  files.add(NATIVE_POSIX);
  const options = await run.cliOptions();
  assert.deepEqual(options, { effort: true, modes: ['acceptEdits', 'plan'] });
  assert.deepEqual(lookups.filter((call) => call.includes('--help')), [[NATIVE_POSIX, '--help']]);
  assert.equal(await run.cliOptions(), options);
  assert.equal(lookups.filter((call) => call.includes('--help')).length, 1);
  const given = { effort: false, modes: ['plan'] };
  run._internal.setOptions(given);
  assert.equal(await run.cliOptions(), given);
});
