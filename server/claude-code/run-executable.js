'use strict';
// Finds the Claude Code program on this computer without a shell, and reads from its own --help
// which options it accepts.

const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs').promises;
const { execFile } = require('node:child_process');
const { runCaches } = require('./run-caches.js');

const HELP_TIMEOUT_MS = 8000;

// The permission modes a run may start in, and the effort levels Claude Code
// accepts. Each is offered only when the installed CLI's --help lists it.
const RUN_MODES = ['manual', 'acceptEdits', 'plan'];

async function isFile(p) {
  try { return (await fsp.stat(p)).isFile(); } catch { return false; }
}

function whichRaw(name) {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    execFile(finder, [name], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean));
    });
  });
}

async function resolveExecutable() {
  if (runCaches.exec) return runCaches.exec;
  const win = process.platform === 'win32';
  const home = os.homedir();

  // 1. The native installer's location, by far the common case.
  const native = path.join(home, '.local', 'bin', win ? 'claude.exe' : 'claude');
  if (await isFile(native)) return (runCaches.exec = { cmd: native, pre: [] });

  // 2. Whatever is on PATH.
  for (const hit of await whichRaw('claude')) {
    const low = hit.toLowerCase();
    if (win ? low.endsWith('.exe') : !low.endsWith('.cmd') && !low.endsWith('.ps1')) {
      return (runCaches.exec = { cmd: hit, pre: [] });
    }
    // 3. An npm shim: find the package entry next to it and run it under node.
    const cli = path.join(path.dirname(hit), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (await isFile(cli)) return (runCaches.exec = { cmd: process.execPath, pre: [cli] });
  }
  return null;
}

function helpText(exe) {
  return new Promise((resolve) => {
    execFile(exe.cmd, exe.pre.concat(['--help']), { timeout: HELP_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout) => resolve(String(stdout || '')));
  });
}

function parseOptions(help) {
  const text = String(help || '');
  const modes = text.includes('--permission-mode') ? RUN_MODES.filter((m) => text.includes('"' + m + '"')) : [];
  return { effort: text.includes('--effort'), modes };
}

async function cliOptions() {
  if (runCaches.options) return runCaches.options;
  const exe = await resolveExecutable();
  if (!exe) return { effort: false, modes: [] };
  runCaches.options = parseOptions(await helpText(exe));
  return runCaches.options;
}

module.exports = {
  HELP_TIMEOUT_MS, RUN_MODES, isFile, whichRaw, resolveExecutable, helpText, parseOptions,
  cliOptions,
};
