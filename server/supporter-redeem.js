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
  const canon = canonCode(code);
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
    return { ok: true, cek: out.cek, name: typeof out.name === 'string' ? out.name.slice(0, 120) : '' };
  }
  const error = out && KNOWN_ERRORS.has(out.error) ? out.error : 'network';
  return { ok: false, error };
}

module.exports = {
  redeem,
  getInstallId,
  getScopedId,
  SCOPE_RATINGS,
  SCOPE_DEVICES,
  HUB_BASE,
  _setTransport(fn) { _transport = fn || postJson; },
  _resetInstallIdCache() { _installId = null; _scopedCache.clear(); },
};
