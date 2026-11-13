// Whether a request carries the token the Claude Code bridge was given.

const crypto = require('node:crypto');
const { claudeState } = require('./tile-state.js');

// Constant-time compare so the token can't be probed byte-by-byte.
function _claudeBridgeAuth(req) {
  const got = String(req.headers['x-xenon-bridge'] || '');
  if (!claudeState.bridgeToken || got.length !== claudeState.bridgeToken.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(claudeState.bridgeToken)); }
  catch { return false; }
}

module.exports = { _claudeBridgeAuth };
