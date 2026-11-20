'use strict';

// The pass trial without copying a code, this PC's side. The trial sheet
// (js/store-supporters/trial-sheet.js) sends the address here; this module asks
// the hub to email the trial (POST /trial/request) with a CLAIM: 32 random bytes
// made for this one request, never an id this PC already has. The email's
// "Start the trial" button confirms the address on the hub; the sheet then asks
// here (/poll) and this module asks the hub (POST /trial/claim), which hands the
// XT code over once. The sheet redeems it through the same path a pasted code
// takes, so there is no second way in.
//
//   - The claim waits in DATA_DIR/trial-claim.json for at most 24 hours (the
//     hub's link life), so a reload or a restart keeps waiting where it was.
//   - The hub sees only the claim and keeps only its hash. The email and the hub's
//     button page show 4 characters made from it (matchCodeOf, the same rule as
//     the hub's trial-link-store.js); the sheet shows them too, so the inbox owner
//     can tell their own request from someone else's.
//   - Nothing here polls on its own: the hub is asked only when a screen asks,
//     and at most every POLL_GAP_MS.

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('../files/atomic-write.js');
const supporterRedeem = require('./supporter-redeem.js');

const FILE = 'trial-claim.json';
const LIFE_MS = 24 * 60 * 60 * 1000;
const POLL_GAP_MS = 3000;
const CLAIM_RE = /^[A-Za-z0-9_-]{43}$/;
// No 0/O, 1/I/L, 2/Z, 5/S, 6/G, 8/B. Same alphabet and rule as the hub.
const MATCH_ALPHABET = 'ACDEFHJKMNPRTUVWXY3479';
const READY_CODE_RE = /^XT-?[A-Z0-9]{4}-?[A-Z0-9]{4}-?[A-Z0-9]{4}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const EMAIL_MAX = 254;
const LANG_RE = /^[a-z]{2}$/;
const REQUEST_ERRORS = new Set(['bad_request', 'bad_email', 'rate_limited', 'trial_used', 'closed', 'app_cap']);

/** The 4 characters the email, the hub's page and the sheet all show for a claim. */
function matchCodeOf(claim) {
  if (!CLAIM_RE.test(String(claim || ''))) return '';
  const digest = crypto.createHash('sha256').update('trial-match.' + claim).digest();
  return Array.from(digest.subarray(0, 4), (b) => MATCH_ALPHABET[b % MATCH_ALPHABET.length]).join('');
}

// The stored claim, or null when malformed, expired or not there.
function cleanState(raw, at) {
  if (!raw || typeof raw !== 'object' || !CLAIM_RE.test(String(raw.claim || ''))) return null;
  const startedAt = Number(raw.startedAt);
  const expiresAt = Number(raw.expiresAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(expiresAt) || expiresAt <= at) return null;
  // A clock moved back past the request: the window is still at most LIFE_MS.
  if (expiresAt - startedAt > LIFE_MS || startedAt > at + LIFE_MS) return null;
  const code = READY_CODE_RE.test(String(raw.code || '')) ? raw.code : '';
  return { claim: raw.claim, startedAt, expiresAt, code };
}

/**
 * @param {{ dataDir: string, trialPass: { status: () => Promise<any> },
 *   post?: (path: string, body: object) => Promise<any>, scopedId?: () => Promise<string>, now?: () => number }} opts
 */
function createTrialClaim({ dataDir, trialPass, post = supporterRedeem.hubPost, scopedId, now = Date.now }) {
  const file = path.join(dataDir, FILE);
  const deviceId = scopedId || (() => supporterRedeem.getScopedId(dataDir, supporterRedeem.SCOPE_DEVICES));
  let lastAsk = 0;

  async function read() {
    try { return cleanState(JSON.parse(await fsp.readFile(file, 'utf8')), now()); } catch { return null; }
  }
  async function forget() {
    try { await fsp.unlink(file); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    return { ok: true };
  }
  async function trialState() {
    try { const s = await trialPass.status(); return (s?.state) || 'none'; } catch { return 'none'; }
  }
  const waiting = (s) => ({ ok: true, pending: true, match: matchCodeOf(s.claim), expiresAt: s.expiresAt });

  /** @param {{ email?: unknown, news?: unknown, lang?: unknown }} [body] */
  async function request({ email, news, lang } = {}) {
    const address = typeof email === 'string' ? email.trim() : '';
    if (address.length > EMAIL_MAX || !EMAIL_RE.test(address)) return { ok: false, error: 'bad_email' };
    // This PC had its trial: the hub would say the same, without an email.
    if ((await trialState()) !== 'none') return { ok: false, error: 'trial_used' };
    let id;
    try { id = await deviceId(); } catch { return { ok: false, error: 'network' }; }
    const claim = crypto.randomBytes(32).toString('base64url');
    let out;
    try {
      out = await post('/trial/request', {
        email: address, news: news === true, lang: LANG_RE.test(String(lang || '')) ? lang : 'en', claim, scopedId: id,
      });
    } catch { out = null; }
    if (out?.ok !== true) return { ok: false, error: out && REQUEST_ERRORS.has(out.error) ? out.error : 'network' };
    const at = now();
    const state = { claim, startedAt: at, expiresAt: at + LIFE_MS, code: '' };
    await writeFileAtomic(file, JSON.stringify(state));
    lastAsk = 0;
    return waiting(state);
  }

  // A pure read for a screen opening: is a request waiting, and with which match code.
  async function pending() {
    const s = await read();
    return s ? waiting(s) : { ok: true, pending: false };
  }

  // One look: 'none' (nothing waiting), 'started' (the trial runs here already,
  // the claim is done), 'ready' with the code to redeem, or 'pending'.
  async function poll() {
    const s = await read();
    if (!s) return { ok: true, state: 'none' };
    if ((await trialState()) !== 'none') { await forget(); return { ok: true, state: 'started' }; }
    // Kept until the redeem lands (forget), so a second screen redeems the same code.
    if (s.code) return { ok: true, state: 'ready', code: s.code };
    const at = now();
    if (at - lastAsk < POLL_GAP_MS) return { ...waiting(s), state: 'pending' };
    lastAsk = at;
    let out;
    try { out = await post('/trial/claim', { claim: s.claim }); } catch { out = null; }
    if (out && out.ok === true && out.state === 'ready' && READY_CODE_RE.test(String(out.code || ''))) {
      await writeFileAtomic(file, JSON.stringify({ ...s, code: out.code }));
      return { ok: true, state: 'ready', code: out.code };
    }
    return { ...waiting(s), state: 'pending' };
  }

  return { request, pending, poll, forget };
}

module.exports = { createTrialClaim, matchCodeOf, LIFE_MS, POLL_GAP_MS, MATCH_ALPHABET, FILE };
