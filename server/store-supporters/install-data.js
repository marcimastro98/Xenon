// What this install keeps in the data folder for the supporter hub: its own id, made once, the
// hashes of it that go out, one for each purpose so the hub cannot tie one to another, and the
// remembered supporter pass.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeFileAtomic } = require('../atomic-write.js');
const { canonCode } = require('./hub-shapes.js');
const { redeemState } = require('./redeem-state.js');

const fsp = fs.promises;

async function getInstallId(dataDir) {
  if (redeemState.installId) return redeemState.installId;
  // Serialize concurrent first-run calls (reachable now that ratings' mine=1
  // reads and votes can fire together): without this, two callers both miss the
  // cache, mint different UUIDs, and — sharing the same `.tmp-<pid>` path —
  // clobber each other's temp file so one rename ENOENTs and the persisted id
  // disagrees with the in-memory one.
  if (redeemState.installIdInflight) return redeemState.installIdInflight;
  redeemState.installIdInflight = (async () => {
    const file = path.join(dataDir, 'install-id.json');
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (parsed && typeof parsed.installId === 'string'
        && /^[0-9a-f-]{36}$/i.test(parsed.installId)) {
        redeemState.installId = parsed.installId;
        return redeemState.installId;
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
    redeemState.installId = fresh;
    return redeemState.installId;
  })();
  try {
    return await redeemState.installIdInflight;
  } finally {
    redeemState.installIdInflight = null;
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
const SCOPE_WELCOME = 'welcome';
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

module.exports = {
  fsp, getInstallId, SCOPE_RATINGS, SCOPE_DEVICES, SCOPE_WELCOME, _scopedCache, getScopedId,
  SUPPORTER_FILE, SAVEABLE_RE, readSavedCode, saveCode, forgetCode, savedStatus,
};
