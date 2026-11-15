'use strict';
// One call of the macOS helper program, and how long it is left alone after it failed.

const { runSoft } = require('./darwin-read.js');
const { held } = require('./darwin-held.js');
const { HELPER_EXE } = require('./darwin-helper-path.js');

const HELPER_MAX_FAILURES = 3;
const HELPER_RETRY_MS = 5 * 60 * 1000;

async function runHelper(args, timeoutMs) {
  if (Date.now() < held.helperDownUntil) return null;
  const out = await runSoft(HELPER_EXE, args, timeoutMs);
  if (out === null) { held.helperDownUntil = Date.now() + HELPER_RETRY_MS; return null; }
  return out;
}

module.exports = { HELPER_MAX_FAILURES, HELPER_RETRY_MS, runHelper };
