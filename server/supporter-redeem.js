// Supporter-code redemption proxy. The dashboard never talks to the hub
// directly: the browser POSTs /api/community/redeem to this local server,
// which attaches the device id (a hash of the per-install UUID persisted in
// DATA_DIR — see "Scoped ids" below) and forwards to the author-owned
// Cloudflare Worker. The hub validates the
// one-time code (3-device cap, expiry gate) and answers with the content
// key the client then uses to decrypt the v2 remote-locked bundle.
//
// The POST discipline mirrors fetchText in community-catalog.js (https-only,
// timeout, bounded body, no-throw result objects) with one difference: a POST
// must never follow redirects, so any 3xx is treated as a failure.

require('./atomic-write.js');
require('./net-guard');

// Author-owned hub base URL — fixed like CATALOG_BASE, never user-configurable
// (a settings field would be attack/typo surface with no user benefit).
const HUB_BASE = 'https://xenon-supporter-hub.xenonedge.workers.dev';

const { FETCH_TIMEOUT_MS, postJson } = require('./store-supporters/hub-post.js');
const {
  ENTRY_ID_RE, canonCode, HUB_CODE_RE, TRIAL_RE, VERSION_RE, cleanKv,
} = require('./store-supporters/hub-shapes.js');
// Errors we pass through to the client verbatim; anything else maps to network.
// 'wrong_code' = valid code, wrong tier/entry (e.g. a supporter code on a
// limited drop, or an item code on a different entry than it was issued for).
// 'not_in_trial' = a trial code on something the trial does not open (a drop in
// its first 30 days, a paid item); 'trial_used' = this install already had one.
const KNOWN_ERRORS = new Set(['bad_request', 'bad_code', 'bad_entry', 'expired', 'limit', 'rate_limited', 'wrong_code', 'not_in_trial', 'trial_used']);
// What /update can answer besides success. 'not_owner' is the hub's ONE answer for
// every kind of refusal (it never says why), and the app treats it as "ask for the
// code the usual way".
const UPDATE_ERRORS = new Set(['bad_request', 'bad_entry', 'not_owner', 'rate_limited', 'unavailable']);
// A private (limited) bundle comes back inside the /update answer. The hub caps one
// at 2 MB; the JSON around it is small, so 3 MB is the ceiling and anything bigger
// is a broken or hostile answer, not a bundle.
const MAX_UPDATE_RESPONSE_BYTES = 3 * 1024 * 1024;
// Up to 3 MB on a slow link takes far longer than a small JSON answer: the idle
// timeout stays short, the whole-request cap (twice this) leaves a minute.
const UPDATE_TIMEOUT_MS = 30000;
const MAX_BUNDLE_CHARS = 2 * 1024 * 1024 + 4096;

const { redeemState } = require('./store-supporters/redeem-state.js');

const {
  getInstallId, SCOPE_RATINGS, SCOPE_DEVICES, SCOPE_WELCOME, _scopedCache, getScopedId, SAVEABLE_RE,
  readSavedCode, saveCode, forgetCode, savedStatus,
} = require('./store-supporters/install-data.js');



/**
 * Stores a pass the user typed in Settings, before any drop needs it.
 *
 * Shape-checked only, and deliberately: validity is a question only the hub can
 * answer, and it answers it against a specific ENTRY (`redeem` takes an
 * entryId), so there is nothing to verify against here. A typo therefore
 * survives until the first unlock, which is why the UI says this is a place to
 * keep the code and not a proof that it works.
 */
// With `verify` (Settings) the hub is asked once: a code it does not know is
// said now, not at the next drop or in Bit. Offline, or any other answer
// (an expired pass still opens its drops), it is saved as before.
async function saveTypedCode(dataDir, code, { verify = false } = {}) {
  const canon = canonCode(code);
  if (!SAVEABLE_RE.test(canon)) return { ok: false, error: 'bad_code' };
  if (verify && /^XS/.test(canon)) {
    const out = await hubPost('/ai/session', { code: canon }, undefined, FETCH_TIMEOUT_MS).catch(() => null);
    if (out && out.error === 'bad_code') return { ok: false, error: 'refused' };
  }
  const ok = await saveCode(dataDir, canon);
  return ok ? { ok: true, saved: true } : { ok: false, error: 'network' };
}

function useTrialPass(trialPass) { redeemState.trialPass = trialPass || null; }

function useRatingVotes(votes) { redeemState.ratingVotes = votes || null; }
async function withRatingId(payload) {
  if (!redeemState.ratingVotes) return payload;
  const ratingId = await redeemState.ratingVotes.ratingId().catch(() => '');
  return ratingId ? { ...payload, ratingId } : payload;
}
async function keepRatingTicket(entryId, out) {
  if (!redeemState.ratingVotes || !out || typeof out.ratingTicket !== 'string') return;
  await redeemState.ratingVotes.addTicket(entryId, out.ratingTicket, out.ratingTicketAt).catch(() => {});
}

// ── Outbound POST ────────────────────────────────────────────────────────────
let _transport = postJson; // swappable for tests

// A POST to another hub route (trial-pass.js, ai-xenon-credits.js), with the
// same discipline. A credits call waits on the model and answers with a whole
// turn, so it passes its own ceiling and timeout.
function hubPost(pathname, body, maxBytes, timeoutMs) {
  return _transport(HUB_BASE + pathname, body, maxBytes, timeoutMs);
}

// ── Redemption ───────────────────────────────────────────────────────────────
// `allowTrial: false` keeps the trial out of a redeem whose result is written to
// disk for good (the widget auto-updater): trial content lives in the vault only.
async function redeem({ entryId, code, dataDir, kv, viaTrial = false, allowTrial = true }) {
  const id = String(entryId || '');
  let canon = canonCode(code);
  // No code on the request means "use the pass this machine already redeemed
  // with". The client sends nothing rather than the value, so the pass stays on
  // disk here even while the tap comes from a paired phone.
  const fromSaved = !canon;
  if (fromSaved && !viaTrial) canon = await readSavedCode(dataDir);
  const fromTrial = fromSaved && !canon && !!redeemState.trialPass && allowTrial;
  if (fromTrial) canon = await redeemState.trialPass.activeCode();
  if (!ENTRY_ID_RE.test(id) || !HUB_CODE_RE.test(canon)) {
    return { ok: false, error: 'bad_request' };
  }
  let scopedId;
  try { scopedId = await getScopedId(dataDir, SCOPE_DEVICES); }
  catch { return { ok: false, error: 'network' }; }
  let out;
  // The key version the file was sealed with, when the file says so; the hub
  // answers with its latest key when it is left out (every app before versions).
  const payload = { entryId: id, code: canon, scopedId };
  const keyVersion = cleanKv(kv);
  if (keyVersion) payload.kv = keyVersion;
  try { out = await _transport(HUB_BASE + '/redeem', await withRatingId(payload)); }
  catch { return { ok: false, error: 'network' }; }
  if (out && out.ok === true && typeof out.cek === 'string' && out.cek) {
    await keepRatingTicket(id, out);
    // Remember it only once it has been proven to work, and only when the user
    // typed it: a pass that came FROM disk has nothing to learn.
    const saved = !fromSaved && await saveCode(dataDir, canon);
    const answer = {
      ok: true,
      cek: out.cek,
      name: typeof out.name === 'string' ? out.name.slice(0, 120) : '',
      saved: saved === true,
    };
    // A trial code: the hub bound the trial to this install; its end is the hub's.
    // Opened with a trial code: the route keeps the key on this server (trial-vault.js).
    if (TRIAL_RE.test(canon)) answer.trial = true;
    if (TRIAL_RE.test(canon) && Number.isFinite(out.trialEndsAt)) {
      if (redeemState.trialPass) await redeemState.trialPass.remember(canon, out.trialEndsAt);
      answer.trialEndsAt = out.trialEndsAt * 1000;
    }
    return answer;
  }
  const error = out && KNOWN_ERRORS.has(out.error) ? out.error : 'network';
  // The hub refused the running trial's code: ask it now, so the trial state is
  // not left saying "active" for the rest of its 48 hours of trust.
  if (fromTrial && redeemState.trialPass && error !== 'network' && typeof redeemState.trialPass.check === 'function') {
    try { await redeemState.trialPass.check(); } catch { /* the next scheduled look settles it */ }
  }
  // A pass the hub no longer knows was REPLACED or revoked: reissuing a code
  // hub-side deactivates the previous one, and a saved pass had already worked
  // once, so 'bad_code' here means it is dead rather than mistyped. Drop it, or
  // the user re-presses Import forever against a code they cannot even see.
  //
  // Only this error. 'expired' must NOT clear it: the hub extends the SAME code
  // on renewal (upsertSupporter finds the supporter by email and raises
  // expires_at; nothing deactivates a code on expiry), so the saved pass comes
  // back to life on its own the moment the user renews. 'limit' and
  // 'wrong_code' are statements about this request, not about the code.
  // An ex-supporter's saved pass ran out (or is not for this entry) while a pass
  // trial runs here: the trial is what opens it, so ask with that instead.
  if (fromSaved && !fromTrial && allowTrial && redeemState.trialPass && (error === 'expired' || error === 'wrong_code')
      && await redeemState.trialPass.activeCode()) {
    return redeem({ entryId: id, dataDir, kv, viaTrial: true });
  }
  if (fromSaved && !fromTrial && error === 'bad_code') {
    const dropped = await forgetCode(dataDir);
    if (dropped && dropped.ok) return { ok: false, error, forgot: true };
  }
  return { ok: false, error };
}

// ── Owner update ─────────────────────────────────────────────────────────────
// "I already unlocked this on this install: is there a newer version, and may I
// have its key?" No code is sent and none is needed: the hub answers a device it
// has already recorded as an owner of the entry (the same activation /redeem
// writes), with the ONE refusal 'not_owner' for everything else. What comes back
// is used once, in the browser, to open the new version, and is never stored here.
//
// This is how the owner of a purchased (XL) or limited copy is updated without
// retyping a code the app never kept, and the only way a limited copy CAN be
// updated at all: its file is private on the hub, so the answer carries it.
async function update({ entryId, have, kv, dataDir }) {
  const id = String(entryId || '');
  if (!ENTRY_ID_RE.test(id)) return { ok: false, error: 'bad_request' };
  const haveVersion = VERSION_RE.test(String(have || '')) ? String(have) : '';
  let scopedId;
  try { scopedId = await getScopedId(dataDir, SCOPE_DEVICES); }
  catch { return { ok: false, error: 'network' }; }
  const payload = { entryId: id, scopedId };
  if (haveVersion) payload.have = haveVersion;
  const keyVersion = cleanKv(kv);
  if (keyVersion) payload.kv = keyVersion;
  let out;
  try { out = await _transport(HUB_BASE + '/update', payload, MAX_UPDATE_RESPONSE_BYTES, UPDATE_TIMEOUT_MS); }
  catch { return { ok: false, error: 'network' }; }
  if (out && out.ok === true && out.upToDate === true) return { ok: true, upToDate: true };
  if (out && out.ok === true && typeof out.cek === 'string' && out.cek
      && typeof out.version === 'string' && VERSION_RE.test(out.version) && cleanKv(out.kv)) {
    const answer = {
      ok: true,
      version: out.version,
      kv: out.kv,
      cek: out.cek,
      changelog: typeof out.changelog === 'string' ? out.changelog.slice(0, 300) : '',
      name: typeof out.name === 'string' ? out.name.slice(0, 120) : '',
    };
    if (typeof out.bundle === 'string' && out.bundle && out.bundle.length <= MAX_BUNDLE_CHARS) answer.bundle = out.bundle;
    return answer;
  }
  return { ok: false, error: out && UPDATE_ERRORS.has(out.error) ? out.error : 'network' };
}

module.exports = {
  redeem,
  update,
  hubPost,
  useRatingVotes,
  withRatingId,
  keepRatingTicket,
  useTrialPass,
  savedStatus,
  readSavedCode,
  saveTypedCode,
  forgetCode,
  getInstallId,
  getScopedId,
  SCOPE_RATINGS,
  SCOPE_DEVICES,
  SCOPE_WELCOME,
  HUB_BASE,
  _setTransport(fn) { _transport = fn || postJson; },
  _resetInstallIdCache() { redeemState.installId = null; _scopedCache.clear(); },
};
