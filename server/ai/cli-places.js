'use strict';
// Where the two command-line assistants are found and where they run: Codex looked up again
// when its cached copy is gone, the program of a provider, and the empty private folder made
// once per run of the server.

const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs').promises;
const claudeRun = require('../claude-run.js');
const { cliSession } = require('./cli-session.js');
const { asLaunch, isFile, newestCodexCopy } = require('./cli-find-codex.js');

async function resolveCodex() {
  // A cached copy inside an app or extension folder disappears when that
  // updates, so the cache is re-checked rather than trusted.
  if (cliSession.codexCache && (cliSession.codexCache.pre.length || await isFile(cliSession.codexCache.cmd))) return cliSession.codexCache;
  cliSession.codexCache = null;
  const win = process.platform === 'win32';
  for (const hit of await claudeRun.whichRaw('codex')) {
    const low = hit.toLowerCase();
    if (win ? low.endsWith('.exe') : !low.endsWith('.cmd') && !low.endsWith('.ps1')) {
      return (cliSession.codexCache = win ? { cmd: hit, pre: [] } : await asLaunch(hit));
    }
    // npm's Windows shim needs a shell; run the package's entry under node
    // instead, like claude-run.js does for Claude Code.
    const js = path.join(path.dirname(hit), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (await isFile(js)) return (cliSession.codexCache = { cmd: process.execPath, pre: [js] });
  }
  const copy = await newestCodexCopy();
  return copy ? (cliSession.codexCache = win ? { cmd: copy, pre: [] } : await asLaunch(copy)) : null;
}
function resolveExe(provider) {
  return provider === 'claudecode' ? claudeRun.resolveExecutable() : resolveCodex();
}

async function workDir() {
  if (cliSession.workDir) {
    try { if ((await fsp.stat(cliSession.workDir)).isDirectory()) return cliSession.workDir; } catch { /* removed: make another */ }
  }
  cliSession.workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xenon-ai-cli-'));
  try { await fsp.chmod(cliSession.workDir, 0o700); } catch { /* Windows: the user's own temp folder */ }
  return cliSession.workDir;
}


module.exports = { resolveCodex, resolveExe, workDir };
