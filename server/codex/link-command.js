'use strict';
// The command line Codex runs our hook with: quoted for a POSIX shell, and on Windows the bare
// path of a small .cmd in the data folder that holds the quoted node and script, because Codex
// wraps the line in one pair of quotes.

const path = require('node:path');

// ── the command line ─────────────────────────────────────────────────────────
// Codex runs it through the platform shell: `%COMSPEC% /C "<command>"` on
// Windows (it adds the outer quotes itself, which cmd strips), `$SHELL -lc
// <command>` elsewhere (read from codex-rs/hooks/src/engine/command_runner.rs).
// The node binary is named by absolute path: the ChatGPT desktop app's
// environment does not necessarily have node on PATH.
//
// Windows is the exception that needs a wrapper. Codex (checked on the ChatGPT
// app 26.1007 and codex-cli 0.147/0.153, openai/codex#38168) wraps the whole
// line in ONE pair of quotes and hands it to cmd, whose legacy quote rules then
// mangle any quote INSIDE it: a line with a quoted node and a quoted script
// never starts, and Codex only reports "hook exited with code 1". So on
// Windows the hook command holds no quote at all: it is the path of a small
// codex-hook.cmd, which holds the quoted node and script. That also means a
// Node upgrade rewrites the .cmd only, and costs no re-trust.
function quotePosix(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
// A path cmd reads as one bare word: ASCII, no space, no metacharacter ("~" is
// one only after a "%", so a short name like C:\Users\MARYAN~1 passes). Only
// DATA_DIR is used, in the user's own install like the script the .cmd runs: a
// machine-wide folder would let another local user plant the file Codex runs.
// Any other DATA_DIR (a user name with a space) keeps the old quoted command.
const CMD_SAFE_PATH = /^[A-Za-z0-9_.:~\\/-]+$/;
function wrapperPath(dataDir, platform = process.platform) {
  if (platform !== 'win32') return null;
  const p = path.join(dataDir, 'codex-hook.cmd');
  return CMD_SAFE_PATH.test(p) ? p : null;
}
function wrapperBody(nodePath, scriptPath) {
  const pct = (s) => String(s).replace(/%/g, '%%');
  return '@echo off\r\n"' + pct(nodePath) + '" "' + pct(scriptPath) + '" %*\r\n';
}
function hookCommand(platform, nodePath, scriptPath, mode, wrapper = null) {
  if (platform === 'win32') return wrapper ? wrapper + ' ' + mode : '"' + nodePath + '" "' + scriptPath + '" ' + mode;
  return quotePosix(nodePath) + ' ' + quotePosix(scriptPath) + ' ' + mode;
}

module.exports = { quotePosix, CMD_SAFE_PATH, wrapperPath, wrapperBody, hookCommand };
