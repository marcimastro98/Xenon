'use strict';

// ── Sparks: buying a drop, and the Sparks code ────────────────────────────
// A Store entry can be sold for Sparks (catalog `sparks`, the hub's
// entries.sparks_price). Buying it is POST /buy on the hub with the buyer's own
// code: the supporter pass (XS) when this PC has one, else the Sparks code (XC)
// that someone who is not a supporter got by email with their first pack.
// The answer is the content key, exactly as a redeem answers, so the browser
// opens the file the same way.
//
// The XC code is remembered like the pass (supporter-redeem.js): here, in
// DATA_DIR, never in settings.json, and the browser only ever learns a boolean.
// When this PC holds both, the Sparks code is moved onto the pass once
// (POST /wallet/merge) and then forgotten, so one code holds everything.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { writeFileAtomic } = require('./atomic-write.js');
const supporterRedeem = require('./supporter-redeem.js');

const WALLET_FILE = 'sparks-code.json';
const ENTRY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
const WALLET_RE = /^XC[A-Z0-9]{12}$/;
const PASS_RE = /^XS[A-Z0-9]{12}$/;
const canonCode = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const cleanKv = (v) => (Number.isInteger(v) && v >= 1 && v <= 1000 ? v : null);
const whole = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
// What /buy can answer besides success; anything else is 'network'.
const BUY_ERRORS = new Set(['included', 'not_for_sale', 'no_sparks', 'sold_out', 'revoked', 'limit',
  'wrong_code', 'bad_code', 'bad_entry', 'bad_request', 'rate_limited', 'busy']);

async function readWalletCode(dataDir) {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(dataDir, WALLET_FILE), 'utf8'));
    const canon = canonCode(parsed && parsed.code);
    return WALLET_RE.test(canon) ? canon : '';
  } catch { return ''; }
}

async function saveWalletCode(dataDir, code) {
  const canon = canonCode(code);
  if (!WALLET_RE.test(canon)) return false;
  try {
    await writeFileAtomic(path.join(dataDir, WALLET_FILE), JSON.stringify({ code: canon }));
    return true;
  } catch { return false; }
}

async function forgetWalletCode(dataDir) {
  try { await fsp.unlink(path.join(dataDir, WALLET_FILE)); }
  catch (e) { if (e && e.code !== 'ENOENT') return { ok: false, error: 'network' }; }
  return { ok: true, saved: false };
}

/** A Sparks code typed in Settings or the Store. Shape only: the hub answers whether it works. */
async function saveTypedWalletCode(dataDir, code) {
  if (!WALLET_RE.test(canonCode(code))) return { ok: false, error: 'bad_code' };
  if (!await saveWalletCode(dataDir, code)) return { ok: false, error: 'network' };
  await mergeIfBoth(dataDir);
  return { ok: true, saved: !!(await readWalletCode(dataDir)) || !!(await supporterRedeem.readSavedCode(dataDir)) };
}

/** What the dashboard may know: whether this PC can pay with Sparks, and with what kind of code. */
async function walletStatus(dataDir) {
  const pass = !!(await supporterRedeem.readSavedCode(dataDir));
  const wallet = !!(await readWalletCode(dataDir));
  return { ok: true, pass, wallet, canBuy: pass || wallet };
}

// Both codes on this PC: the Sparks code goes onto the pass, once. Only a code
// the hub says is dead is forgotten, never the Sparks one because the pass failed.
async function mergeIfBoth(dataDir) {
  const pass = await supporterRedeem.readSavedCode(dataDir);
  const wallet = await readWalletCode(dataDir);
  if (!pass || !wallet) return { ok: true, merged: false };
  let out;
  try { out = await supporterRedeem.hubPost('/wallet/merge', { code: pass, walletCode: wallet }); }
  catch { return { ok: false, error: 'network' }; }
  if (out && out.ok === true) {
    await forgetWalletCode(dataDir);
    return { ok: true, merged: true };
  }
  if (out && out.error === 'bad_code' && out.which === 'wallet') await forgetWalletCode(dataDir);
  return { ok: false, error: out && out.error === 'bad_code' ? 'bad_code' : 'network' };
}

/**
 * Buys `entryId` with Sparks. `code` empty = the codes this PC remembers (the
 * pass first, it holds the monthly Sparks too). A typed code is remembered once
 * the hub has accepted it, like a typed pass.
 * → {ok, cek, name, bought, balance} | {ok:false, error, balance?, price?}
 */
async function buy({ entryId, code, kv, dataDir }) {
  const id = String(entryId || '');
  const typed = canonCode(code);
  if (!ENTRY_ID_RE.test(id) || (typed && !WALLET_RE.test(typed) && !PASS_RE.test(typed))) {
    return { ok: false, error: 'bad_request' };
  }
  if (!typed) await mergeIfBoth(dataDir);
  const payer = typed || await supporterRedeem.readSavedCode(dataDir) || await readWalletCode(dataDir);
  if (!payer) return { ok: false, error: 'no_code' };
  let scopedId;
  try { scopedId = await supporterRedeem.getScopedId(dataDir, supporterRedeem.SCOPE_DEVICES); }
  catch { return { ok: false, error: 'network' }; }
  const payload = { entryId: id, code: payer, scopedId };
  const keyVersion = cleanKv(kv);
  if (keyVersion) payload.kv = keyVersion;
  let out;
  try { out = await supporterRedeem.hubPost('/buy', payload); }
  catch { return { ok: false, error: 'network' }; }
  if (out && out.ok === true && typeof out.cek === 'string' && out.cek) {
    if (typed && WALLET_RE.test(typed)) await saveTypedWalletCode(dataDir, typed);
    if (typed && PASS_RE.test(typed)) await supporterRedeem.saveTypedCode(dataDir, typed);
    return {
      ok: true,
      cek: out.cek,
      name: typeof out.name === 'string' ? out.name.slice(0, 120) : '',
      bought: out.bought === true,
      balance: whole(out.balance),
    };
  }
  const error = out && BUY_ERRORS.has(out.error) ? out.error : 'network';
  // A remembered Sparks code the hub no longer knows was replaced or switched off.
  if (!typed && error === 'bad_code' && WALLET_RE.test(payer)) await forgetWalletCode(dataDir);
  const answer = { ok: false, error };
  if (error === 'no_sparks') {
    if (whole(out.balance) != null) answer.balance = out.balance;
    if (whole(out.price) != null) answer.price = out.price;
  }
  return answer;
}

module.exports = {
  buy,
  readWalletCode,
  saveTypedWalletCode,
  forgetWalletCode,
  walletStatus,
  mergeIfBoth,
};
