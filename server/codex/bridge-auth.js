// Whether a request carries the token the Codex bridge was given.

const crypto = require('node:crypto');
const { codexState } = require('./tile-state.js');

function _codexBridgeAuth(req) {
  const got = String(req.headers['x-xenon-bridge'] || '');
  if (!codexState.bridgeToken || got.length !== codexState.bridgeToken.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(codexState.bridgeToken)); }
  catch { return false; }
}

module.exports = { _codexBridgeAuth };
