'use strict';
// The small tools every macOS reader uses: run a command and fail, run one and get nothing on
// failure, split lines, tell a number.

const { execFile } = require('node:child_process');

// Promise wrapper around execFile with a hard timeout; resolves stdout.
function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || ''));
    });
  });
}

// Same as run(), but a failure resolves null instead of rejecting -- for the
// probes where "the tool is not installed" is an ordinary answer.
function runSoft(cmd, args, timeoutMs, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, env: env || process.env }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''));
    });
  });
}

const splitLines = (text) => String(text || '').split(/\r?\n/);
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

module.exports = { run, runSoft, splitLines, isFiniteNum };
