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
// canonicalize to a 2-letter prefix + 12 symbols: 'XS' (supporter pass) or
// 'XL' (per-entry item code for limited/purchased drops).
const canonCode = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const HUB_CODE_RE = /^X[SL][A-Z0-9]{12}$/;
// Errors we pass through to the client verbatim; anything else maps to network.
// 'wrong_code' = valid code, wrong tier/entry (e.g. a supporter code on a
// limited drop, or an item code on a different entry than it was issued for).
const KNOWN_ERRORS = new Set(['bad_request', 'bad_code', 'bad_entry', 'expired', 'limit', 'rate_limited', 'wrong_code']);

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

// ── Outbound POST ────────────────────────────────────────────────────────────
let _transport = postJson; // swappable for tests

function postJson(url, body) {
  return new Promise((resolve) => {
    if (!/^https:\/\//i.test(url)) return resolve({ ok: false, error: 'network' });
    const payload = JSON.stringify(body);
    let req;
    try {
      req = https.request(url, {
        method: 'POST',
        timeout: FETCH_TIMEOUT_MS,
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
        if (size > MAX_RESPONSE_BYTES) { req.destroy(new Error('body too large')); return; }
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
async function redeem({ entryId, code, dataDir }) {
  const id = String(entryId || '');
  let canon = canonCode(code);
  // No code on the request means "use the pass this machine already redeemed
  // with". The client sends nothing rather than the value, so the pass stays on
  // disk here even while the tap comes from a paired phone.
  const fromSaved = !canon;
  if (fromSaved) canon = await readSavedCode(dataDir);
  if (!ENTRY_ID_RE.test(id) || !HUB_CODE_RE.test(canon)) {
    return { ok: false, error: 'bad_request' };
  }
  let scopedId;
  try { scopedId = await getScopedId(dataDir, SCOPE_DEVICES); }
  catch { return { ok: false, error: 'network' }; }
  let out;
  try { out = await _transport(HUB_BASE + '/redeem', { entryId: id, code: canon, scopedId }); }
  catch { return { ok: false, error: 'network' }; }
  if (out && out.ok === true && typeof out.cek === 'string' && out.cek) {
    // Remember it only once it has been proven to work, and only when the user
    // typed it: a pass that came FROM disk has nothing to learn.
    const saved = !fromSaved && await saveCode(dataDir, canon);
    return {
      ok: true,
      cek: out.cek,
      name: typeof out.name === 'string' ? out.name.slice(0, 120) : '',
      saved: saved === true,
    };
  }
  const error = out && KNOWN_ERRORS.has(out.error) ? out.error : 'network';
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
  if (fromSaved && error === 'bad_code') {
    const dropped = await forgetCode(dataDir);
    if (dropped && dropped.ok) return { ok: false, error, forgot: true };
  }
  return { ok: false, error };
}

module.exports = {
  redeem,
  savedStatus,
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
