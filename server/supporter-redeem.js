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

const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./atomic-write.js');

// Author-owned hub base URL — fixed like CATALOG_BASE, never user-configurable
// (a settings field would be attack/typo surface with no user benefit).
const HUB_BASE = 'https://xenon-supporter-hub.xenonedge.workers.dev';

const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const ENTRY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
// Same canonical form as preset-share: uppercase, [A-Z0-9] only. Hub codes
// canonicalize to a 2-letter prefix + 12 symbols: 'XS' (supporter pass), 'XL'
// (per-entry item code for limited/purchased drops) or 'XT' (the 7-day pass
// trial, see trial-pass.js).
const canonCode = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const HUB_CODE_RE = /^X[SLT][A-Z0-9]{12}$/;
const TRIAL_RE = /^XT[A-Z0-9]{12}$/;
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
const MAX_BUNDLE_CHARS = 2 * 1024 * 1024 + 4096;
const VERSION_RE = /^[0-9]+(\.[0-9]+)*$/;
// A key version names which of the entry's keys a file was sealed with (see the
// hub's versions.js). Small positive integer or nothing.
const cleanKv = (v) => (Number.isInteger(v) && v >= 1 && v <= 1000 ? v : null);

// ── Install id ───────────────────────────────────────────────────────────────
// One random UUID per install, persisted in DATA_DIR. Not a secret — just a
// stable anonymous identifier, and the seed for the scoped ids below. It is
// LOCAL: nothing sends this value itself to the hub.
let _installId = null;
let _installIdInflight = null;   // shared promise so concurrent cold reads resolve once

async function getInstallId(dataDir) {
  if (_installId) return _installId;
  // Serialize concurrent first-run calls (reachable now that ratings' mine=1
  // reads and votes can fire together): without this, two callers both miss the
  // cache, mint different UUIDs, and — sharing the same `.tmp-<pid>` path —
  // clobber each other's temp file so one rename ENOENTs and the persisted id
  // disagrees with the in-memory one.
  if (_installIdInflight) return _installIdInflight;
  _installIdInflight = (async () => {
    const file = path.join(dataDir, 'install-id.json');
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (parsed && typeof parsed.installId === 'string'
        && /^[0-9a-f-]{36}$/i.test(parsed.installId)) {
        _installId = parsed.installId;
        return _installId;
      }
    } catch { /* missing or corrupt — regenerate below */ }
    const fresh = crypto.randomUUID();
    // Temp + rename so a crash mid-write can never leave a corrupt file behind
    // (same discipline as writeFileAtomic in server.js, local to avoid a cycle).
    // The temp name carries a random suffix so it never collides with a
    // parallel writer sharing this pid.
    const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
    await fsp.writeFile(tmp, JSON.stringify({ installId: fresh }), 'utf8');
    await fsp.rename(tmp, file);
    _installId = fresh;
    return _installId;
  })();
  try {
    return await _installIdInflight;
  } finally {
    _installIdInflight = null;
  }
}

// ── Scoped ids ───────────────────────────────────────────────────────────────
// The install id itself never leaves this machine. What goes to the hub is a
// per-purpose hash of it: SHA-256 over `<uuid>|<scope>`.
//
// Sending the raw UUID to both /redeem and /ratings put the same value in the
// hub's `activations` and `ratings` tables, which made "which star ratings did
// this named supporter cast" answerable with one join (a supporter's code links
// to their Discord account). Two scopes, two unlinkable values, and the thing
// that ties them together stays on the user's disk.
//
// The scope labels are a wire contract with the hub (src/scoped-ids.js there):
// change one and every existing row is orphaned — the user would lose their
// vote and burn a fresh device slot on their next redeem.
const SCOPE_RATINGS = 'ratings';
const SCOPE_DEVICES = 'activations';
const _scopedCache = new Map();

async function getScopedId(dataDir, scope) {
  const cached = _scopedCache.get(scope);
  if (cached) return cached;
  const raw = await getInstallId(dataDir);
  const scoped = crypto.createHash('sha256').update(raw.toLowerCase() + '|' + scope).digest('hex');
  _scopedCache.set(scope, scoped);
  return scoped;
}

// ── The remembered supporter pass ────────────────────────────────────────────
// A supporter pass unlocks every supporter drop, so before this the same code
// was typed again for every single one. It is remembered HERE, next to the
// install id, and never in settings.json: that blob is mirrored into every
// surface's localStorage and travels to every paired phone (the geminiApiKey
// lesson, v4.11.0). The browser is told a BOOLEAN and never the value.
//
// Only the XS pass is saved. An XL code opens exactly one drop, so reusing it
// on the next one would answer 'wrong_code' at a user who typed nothing.
const SUPPORTER_FILE = 'supporter-code.json';
const SAVEABLE_RE = /^XS[A-Z0-9]{12}$/;

// Deliberately uncached: it is read once per unlock tap, and a cache would have
// to be invalidated by both the save and the forget below to stay honest.
async function readSavedCode(dataDir) {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(dataDir, SUPPORTER_FILE), 'utf8'));
    const canon = canonCode(parsed && parsed.code);
    return SAVEABLE_RE.test(canon) ? canon : '';
  } catch { return ''; }
}

async function saveCode(dataDir, code) {
  const canon = canonCode(code);
  if (!SAVEABLE_RE.test(canon)) return false;
  try {
    await writeFileAtomic(path.join(dataDir, SUPPORTER_FILE), JSON.stringify({ code: canon }));
    return true;
  } catch { return false; }
}

/** Reset path for the remembered pass. Missing file = already forgotten. */
async function forgetCode(dataDir) {
  try { await fsp.unlink(path.join(dataDir, SUPPORTER_FILE)); }
  catch (e) { if (e && e.code !== 'ENOENT') return { ok: false, error: 'network' }; }
  return { ok: true, saved: false };
}

/** What the dashboard is allowed to know: whether there is one, not what it is. */
async function savedStatus(dataDir) {
  return { ok: true, saved: !!(await readSavedCode(dataDir)) };
}

/**
 * Stores a pass the user typed in Settings, before any drop needs it.
 *
 * Shape-checked only, and deliberately: validity is a question only the hub can
 * answer, and it answers it against a specific ENTRY (`redeem` takes an
 * entryId), so there is nothing to verify against here. A typo therefore
 * survives until the first unlock, which is why the UI says this is a place to
 * keep the code and not a proof that it works.
 */
async function saveTypedCode(dataDir, code) {
  const canon = canonCode(code);
  if (!SAVEABLE_RE.test(canon)) return { ok: false, error: 'bad_code' };
  const ok = await saveCode(dataDir, canon);
  return ok ? { ok: true, saved: true } : { ok: false, error: 'network' };
}

// ── The running pass trial ───────────────────────────────────────────────────
// server.js plugs trial-pass.js in here (it depends on this module, so it cannot
// be required back). With it, a redeem the user typed nothing into uses the trial
// code while the trial runs, and an XT the hub accepted is remembered there.
let _trialPass = null;
function useTrialPass(trialPass) { _trialPass = trialPass || null; }

// ── Outbound POST ────────────────────────────────────────────────────────────
let _transport = postJson; // swappable for tests

// A POST to another hub route (trial-pass.js, ai-xenon-credits.js), with the
// same discipline. A credits call waits on the model and answers with a whole
// turn, so it passes its own ceiling and timeout.
function hubPost(pathname, body, maxBytes, timeoutMs) {
  return _transport(HUB_BASE + pathname, body, maxBytes, timeoutMs);
}

function postJson(url, body, maxBytes = MAX_RESPONSE_BYTES, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!/^https:\/\//i.test(url)) return resolve({ ok: false, error: 'network' });
    const payload = JSON.stringify(body);
    let req;
    try {
      req = https.request(url, {
        method: 'POST',
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, onResponse);
    } catch {
      return resolve({ ok: false, error: 'network' });
    }
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ ok: false, error: 'network' }));
    req.end(payload);

    function onResponse(res) {
      // Never follow a redirect on a POST carrying a redeemable code. Non-3xx
      // statuses (including 400/429) carry a JSON body from the hub — parse it.
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return resolve({ ok: false, error: 'network' });
      }
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error('body too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve({ ok: false, error: 'network' }); }
      });
      res.on('error', () => resolve({ ok: false, error: 'network' }));
    }
  });
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
  const fromTrial = fromSaved && !canon && !!_trialPass && allowTrial;
  if (fromTrial) canon = await _trialPass.activeCode();
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
  try { out = await _transport(HUB_BASE + '/redeem', payload); }
  catch { return { ok: false, error: 'network' }; }
  if (out && out.ok === true && typeof out.cek === 'string' && out.cek) {
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
      if (_trialPass) await _trialPass.remember(canon, out.trialEndsAt);
      answer.trialEndsAt = out.trialEndsAt * 1000;
    }
    return answer;
  }
  const error = out && KNOWN_ERRORS.has(out.error) ? out.error : 'network';
  // The hub refused the running trial's code: ask it now, so the trial state is
  // not left saying "active" for the rest of its 48 hours of trust.
  if (fromTrial && _trialPass && error !== 'network' && typeof _trialPass.check === 'function') {
    try { await _trialPass.check(); } catch { /* the next scheduled look settles it */ }
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
  if (fromSaved && !fromTrial && allowTrial && _trialPass && (error === 'expired' || error === 'wrong_code')
      && await _trialPass.activeCode()) {
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
  try { out = await _transport(HUB_BASE + '/update', payload, MAX_UPDATE_RESPONSE_BYTES); }
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
  useTrialPass,
  savedStatus,
  readSavedCode,
  saveTypedCode,
  forgetCode,
  getInstallId,
  getScopedId,
  SCOPE_RATINGS,
  SCOPE_DEVICES,
  HUB_BASE,
  _setTransport(fn) { _transport = fn || postJson; },
  _resetInstallIdCache() { _installId = null; _scopedCache.clear(); },
};
