'use strict';

// ── Welcome Sparks: the app's half ──────────────────────────────────
// A fresh install gets Bit as its AI and a small trial balance from the hub, with
// no email (the hub's src/welcome-sparks.js holds the amount, the end date and
// every limit: nothing here can extend them). The first boot of an empty data
// folder leaves a marker; the first message to Bit turns the marker into a
// Sparks code, so the days only start once somebody actually tries Bit.
//
// The code then lives where every Sparks code does (sparks-wallet.js) and the
// browser never sees it. An update never leaves the marker, so nobody who
// already has Xenon is touched.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { writeFileAtomic } = require('./atomic-write.js');
const supporterRedeem = require('./supporter-redeem.js');
const sparksWallet = require('./sparks-wallet.js');

const MARKER_FILE = 'welcome-sparks.json';
const CLAIM_TIMEOUT_MS = 15000;
// The hub was closed or unreachable: asked again after this, not on every message.
const RETRY_AFTER_MS = 10 * 60 * 1000;

let _inflight = null;
let _notBefore = 0;
let _now = () => Date.now();

const missing = (file) => {
  try { fs.statSync(file); return false; }
  catch (e) { return !!e && e.code === 'ENOENT'; }
};

/**
 * Is this the first start on an empty data folder? Every file in `stores` has
 * to be truly absent, with no snapshots of an earlier one: a file that cannot be
 * read, or settings lost from a folder with notes or an install id in it, is not
 * a new user. (Snapshots alone would not tell: a 4.x data folder has none yet.)
 * Synchronous on purpose: it runs once at startup, before anything writes.
 */
function isFreshDataDir(stores, snapshotsDir) {
  return stores.every(missing) && missing(snapshotsDir);
}

async function markPending(dataDir) {
  try { await writeFileAtomic(path.join(dataDir, MARKER_FILE), JSON.stringify({ pending: true })); return true; }
  catch { return false; }
}

async function pending(dataDir) {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(dataDir, MARKER_FILE), 'utf8'));
    return !!parsed && parsed.pending === true;
  } catch { return false; }
}

// Will the next message bring the Sparks? Not while the hub just said no, so the
// chat offers Sparks or a key instead of failing on every message.
async function available(dataDir) {
  return _now() >= _notBefore && pending(dataDir);
}

async function clearMarker(dataDir) {
  try { await fsp.unlink(path.join(dataDir, MARKER_FILE)); } catch { /* already gone */ }
}

async function askHub(dataDir) {
  let out;
  try {
    const scopedId = await supporterRedeem.getScopedId(dataDir, supporterRedeem.SCOPE_WELCOME);
    out = await supporterRedeem.hubPost('/welcome/claim', { scopedId }, undefined, CLAIM_TIMEOUT_MS);
  } catch { out = null; }
  if (out && out.ok === true && typeof out.code === 'string') {
    const saved = await sparksWallet.saveTypedWalletCode(dataDir, out.code);
    if (saved && saved.ok) { await clearMarker(dataDir); return true; }
    _notBefore = _now() + RETRY_AFTER_MS;
    return false;
  }
  // 'used' is final for this install. Anything else may change: try again later.
  if (out && out.error === 'used') await clearMarker(dataDir);
  else _notBefore = _now() + RETRY_AFTER_MS;
  return false;
}

/** Turns the marker into a Sparks code, once. → true when a code was saved now. */
function claim(dataDir) {
  if (_inflight) return _inflight;
  if (_now() < _notBefore) return Promise.resolve(false);
  // Taken before the first await: two messages at once must share one claim.
  _inflight = pending(dataDir)
    .then((waiting) => (waiting ? askHub(dataDir) : false))
    .finally(() => { _inflight = null; });
  return _inflight;
}

module.exports = {
  isFreshDataDir,
  markPending,
  pending,
  available,
  claim,
  _setNowForTests: (fn) => { _now = fn || (() => Date.now()); _notBefore = 0; },
};
