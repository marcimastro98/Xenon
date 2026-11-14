'use strict';
// The Sparks client's session with the hub: the saved pass or Sparks code turned into a token,
// asked for again before it ends or when the hub stops taking it, and one hub call made with
// it.

const redeem = require('../supporter-redeem.js');
const sparksWallet = require('../sparks-wallet.js');
const { SMALL_TIMEOUT_MS, TOKEN_MARGIN_SEC, KNOWN_ERRORS } = require('./credits-limits.js');
const { creditsState } = require('./credits-state.js');

// `detail` is the hub's reason (Anthropic's message on a refused request): it
// goes to the server log, never to the user.
function fail(code, balance, detail) {
  const err = new Error('Xenon credits: ' + code);
  err.code = code;
  if (Number.isFinite(balance)) err.balance = balance;
  if (typeof detail === 'string' && detail) err.detail = detail.slice(0, 300);
  return err;
}

function rememberBalance(n) {
  if (Number.isFinite(n)) creditsState.lastBalance = n;
}

// The pass first; without one, the Sparks code of someone who bought Sparks
// without being a supporter (sparks-wallet.js). The hub tells them apart.
async function savedCode(dataDir) {
  return await redeem.readSavedCode(dataDir) || await sparksWallet.readWalletCode(dataDir);
}

// Whether this install holds a code that can spend Sparks: what a feature on
// the user's AI checks before it asks, so a missing code never costs a round trip.
async function hasCode(dataDir) {
  return !!(await savedCode(dataDir));
}

async function sessionToken(dataDir) {
  const now = Math.floor(Date.now() / 1000);
  const code = await savedCode(dataDir);
  // A session belongs to the code that opened it: a Sparks code typed in while
  // the trial's is open has to be the one that pays from the next round on.
  if (creditsState.session && code && creditsState.session.code === code && creditsState.session.exp - TOKEN_MARGIN_SEC > now) return creditsState.session.token;
  creditsState.session = null;
  if (!code) throw fail('no_code');
  let out = await redeem.hubPost('/ai/session', { code }, undefined, SMALL_TIMEOUT_MS);
  // A pass the hub no longer knows (replaced, revoked) must not hide the Sparks
  // code saved beside it. The session stays filed under the saved code, so the
  // dead pass is not asked again each round.
  if (out && out.error === 'bad_code') {
    const wallet = await sparksWallet.readWalletCode(dataDir);
    if (wallet && wallet !== code) out = await redeem.hubPost('/ai/session', { code: wallet }, undefined, SMALL_TIMEOUT_MS);
  }
  if (out && out.ok === true && typeof out.token === 'string' && Number.isInteger(out.exp)) {
    creditsState.session = { code, token: out.token, exp: out.exp };
    return out.token;
  }
  // The trial Sparks ended: their code will never work again, so this PC is
  // simply one with no code, and the chat offers the Sparks or a key.
  if (out && out.error === 'welcome_over') {
    await sparksWallet.forgetWalletCode(dataDir);
    throw fail('no_code');
  }
  throw fail(out && KNOWN_ERRORS.has(out.error) ? out.error : 'network');
}

// One hub call with the session; a token the hub stopped accepting (a new
// secret, a revoked code) is dropped and asked for again, once.
async function withSession(dataDir, pathname, body, maxBytes, timeoutMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await sessionToken(dataDir);
    const out = await redeem.hubPost(pathname, { ...body, token }, maxBytes, timeoutMs);
    if (out && out.error === 'bad_token') { creditsState.session = null; continue; }
    return out;
  }
  throw fail('bad_code');
}

module.exports = { fail, rememberBalance, savedCode, hasCode, sessionToken, withSession };
