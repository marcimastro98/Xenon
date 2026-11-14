'use strict';
// Finds the Codex program on this PC when it is not on the PATH: the folders it installs into
// and the newest copy among them.

const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs').promises;

const POSIX_CODEX_DIRS = (home) => [
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
  path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'),
  path.join(home, '.volta', 'bin'), path.join(home, '.bun', 'bin'),
];
// An npm install on macOS/Linux puts a symlink to a node script on PATH, run
// through `#!/usr/bin/env node` — which fails under a login service whose PATH
// has no node. Running the script under the node that runs Xenon avoids that.
async function asLaunch(file) {
  let real = file;
  try { real = await fsp.realpath(file); } catch { /* keep the link */ }
  return /\.[cm]?js$/i.test(real) ? { cmd: process.execPath, pre: [real] } : { cmd: file, pre: [] };
}
async function isFile(p) {
  try { return (await fsp.stat(p)).isFile(); } catch { return false; }
}
// Where Codex keeps its own copy when it was not installed as a terminal
// command: the desktop app (Windows: %LOCALAPPDATA%/OpenAI/Codex/bin/<hash>/)
// and the ChatGPT extension for VS Code / Cursor (bin/<platform>/). Each is the
// full `codex` program, signed in with the same account. Newest file wins, so
// an app or extension update is followed without restarting Xenon.
async function newestCodexCopy() {
  const win = process.platform === 'win32';
  const exe = win ? 'codex.exe' : 'codex';
  const home = os.homedir();
  const found = [];
  const scan = async (dir, depth) => {
    let items;
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isFile() && it.name.toLowerCase() === exe) {
        try { found.push({ full, t: (await fsp.stat(full)).mtimeMs }); } catch { /* gone */ }
      } else if (it.isDirectory() && depth > 0) await scan(full, depth - 1);
    }
  };
  if (win && process.env.LOCALAPPDATA) await scan(path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'), 1);
  // macOS and Linux: the backend runs as a login service whose PATH is the
  // system's bare default (/usr/bin:/bin:...), so a Homebrew, npm or per-user
  // install is not on it even though the user's terminal finds it. These are
  // the places those installers write to; a folder that does not exist costs
  // one failed readdir.
  if (!win) for (const dir of POSIX_CODEX_DIRS(home)) await scan(dir, 0);
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor']) {
    const ext = path.join(home, editor, 'extensions');
    let names = [];
    try { names = (await fsp.readdir(ext)).filter((n) => /^openai\.chatgpt-/i.test(n)); } catch { /* no editor */ }
    for (const n of names) await scan(path.join(ext, n, 'bin'), 1);
  }
  found.sort((a, b) => b.t - a.t);
  return found.length ? found[0].full : null;
}

module.exports = { POSIX_CODEX_DIRS, asLaunch, isFile, newestCodexCopy };
