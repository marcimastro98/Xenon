'use strict';
// What Claude Code says about itself without a model being called: the models this account can
// use and its plan, asked through the control protocol and kept for a while.

const claudeRun = require('../claude-run.js');
const { MODELS_TTL_MS } = require('./cli-limits.js');
const { workDir } = require('./cli-places.js');
const { childEnv, runWithOptional } = require('./cli-run.js');
const { parseClaudeInit } = require('./cli-status-text.js');

// ── status and models ───────────────────────────────────────────────────────
// Claude Code answers both through the control protocol of its stream-json
// mode, the one Anthropic's own Agent SDK speaks: an `initialize` request gets
// back, among other things, the models this account can use today (with the
// exact model each one currently resolves to) and the account's plan. No user
// message is sent, so no model is called and no quota is spent; the program
// exits when its input closes. It is the same list its own /model picker
// shows, so it moves when Anthropic ships a model, with no change here.
const INIT_TIMEOUT_MS = 45000;      // a cold start on Windows is slow; this is not on the chat path
const initCache = { at: 0, value: null };
async function claudeInit({ fresh = false } = {}) {
  if (!fresh && initCache.value && Date.now() - initCache.at < MODELS_TTL_MS) return initCache.value;
  const exe = await claudeRun.resolveExecutable();
  if (!exe) return null;
  const req = JSON.stringify({ type: 'control_request', request_id: 'xenon-init', request: { subtype: 'initialize' } }) + '\n';
  const r = await runWithOptional(exe, (skip) => {
    const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', ''];
    for (const f of ['--safe-mode', '--no-session-persistence']) if (!skip.has(f)) a.push(f);
    return a;
  }, ['--safe-mode', '--no-session-persistence'], { input: req, env: childEnv('claudecode'), cwd: await workDir(), timeoutMs: INIT_TIMEOUT_MS });
  const value = parseClaudeInit(r.stdout);
  if (value) { initCache.at = Date.now(); initCache.value = value; }
  return value;
}

module.exports = { INIT_TIMEOUT_MS, initCache, claudeInit };
