// Commands the assistant proposed and a person has not approved yet: kept by a one-time code
// for a few minutes.

const crypto = require('node:crypto');

// Returns { fnResult, clientActions, pendingScreenImage }.
// ── Consent-gated PC commands (Xenon AI "run_pc_command") ─────────────────
// The AI never runs a shell command directly. It PROPOSES one; we store the
// exact command under a single-use, unguessable nonce and surface a confirmation
// card to the user. The command runs ONLY after the user approves it
// (POST /ai/pc-run) and is looked up by nonce server-side, so the browser can
// never tamper with what actually executes. Gated behind the off-by-default
// aiFeatures.pcControl flag and re-checked on both issue and run.
const PC_ACTION_TTL_MS = 5 * 60 * 1000;
const PC_ACTION_TIMEOUT_MS = 60 * 1000;
const _pcActions = new Map(); // nonce -> { command, purpose, ts }

function issuePcAction(command, purpose) {
  const now = Date.now();
  for (const [k, v] of _pcActions) if (now - v.ts > PC_ACTION_TTL_MS) _pcActions.delete(k);
  const nonce = crypto.randomBytes(18).toString('hex');
  _pcActions.set(nonce, { command, purpose, ts: now });
  return nonce;
}

module.exports = { PC_ACTION_TTL_MS, PC_ACTION_TIMEOUT_MS, _pcActions, issuePcAction };
