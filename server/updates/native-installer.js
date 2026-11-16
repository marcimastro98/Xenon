'use strict';

// ── Verified download of the native app installer (dashboard one-tap install) ──
// POST /api/native/install runs the installer it fetches SILENTLY (/S), and when
// the backend is the LocalSystem service it hands it to a scheduled task in the
// logged-in user's session. Nothing about that gives the user a chance to look
// at what is being run, so TLS alone is not enough: a swapped release asset, a
// compromised mirror or a man in the middle with a trusted root would get code
// executed with no prompt. So the installer is held to the same trust chain as
// the source zip (self-update.js) and the helper (helper-update.js):
//
//   releases/latest → SHA256SUMS + SHA256SUMS.sig → Ed25519 signature checked
//   against the PINNED public key → the line for Xenon-Setup-x64.exe → the
//   downloaded bytes must hash to exactly that before the file is kept.
//
// Xenon-Setup-x64.exe is the asset because it is the one SHA256SUMS lists (and
// lists as REQUIRED, so a release cannot ship without it): release.yml stages it
// as a byte-for-byte copy of the versioned Xenon_X.Y.Z_x64-setup.exe, which is
// itself not in the signed manifest. Anything that does not verify fails closed:
// the file is deleted and nothing is run.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { UPDATE_PUBKEY_PEM, SELF_UPDATE_REPO, parseSumsEntry } = require('./self-update');

const SETUP_ASSET = 'Xenon-Setup-x64.exe';
const SUMS_ASSET = 'SHA256SUMS';
const SIG_ASSET = 'SHA256SUMS.sig';

// opts (deps injectable for tests): destDir (where the verified exe lands), repo,
// fetchImpl, fsImpl, publicKeyPem.
function createNativeInstallerFetch(opts) {
  const o = opts || {};
  const destDir = o.destDir;
  const repo = o.repo || SELF_UPDATE_REPO;
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  const f = o.fsImpl || fs;
  const publicKeyPem = o.publicKeyPem || UPDATE_PUBKEY_PEM;

  async function _json(url) {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': 'XenonEdgeHub', 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(25000),
    });
    if (!res || !res.ok) return null;
    return await res.json();
  }

  async function _text(url) {
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'XenonEdgeHub' }, signal: AbortSignal.timeout(25000) });
    if (!res || !res.ok) return null;
    return await res.text();
  }

  function _assetUrl(rel, name) {
    const a = ((rel && rel.assets) || []).find((x) => x && x.name === name);
    return a ? a.browser_download_url : '';
  }

  // Resolves { ok: true, path, sha256 } with a file whose bytes match the signed
  // manifest, or { ok: false, error } with a reason code the dashboard maps to a
  // sentence (native-bridge.js reasonText). Never throws.
  async function fetchVerified() {
    const target = path.join(destDir, SETUP_ASSET);
    const dl = target + '.download';
    const drop = () => { try { f.rmSync(dl, { force: true }); } catch { /* ignore */ } };
    try {
      f.mkdirSync(destDir, { recursive: true });
      // A file left from an earlier attempt is never trusted: it is replaced only
      // by a download verified in THIS call, so remove it before anything else.
      try { f.rmSync(target, { force: true }); } catch { /* ignore */ }
      drop();

      const rel = await _json(`https://api.github.com/repos/${repo}/releases/latest`);
      if (!rel) return { ok: false, error: 'download_failed' };
      const exeUrl = _assetUrl(rel, SETUP_ASSET);
      if (!exeUrl) return { ok: false, error: 'no_installer' };
      const sumsUrl = _assetUrl(rel, SUMS_ASSET);
      const sigUrl = _assetUrl(rel, SIG_ASSET);
      if (!sumsUrl || !sigUrl) return { ok: false, error: 'integrity_missing' };

      const [sums, sigB64] = await Promise.all([_text(sumsUrl), _text(sigUrl)]);
      if (!sums || !sigB64) return { ok: false, error: 'integrity_missing' };
      let sigOk = false;
      try {
        const key = crypto.createPublicKey(publicKeyPem);
        sigOk = crypto.verify(null, Buffer.from(sums, 'utf8'), key, Buffer.from(sigB64.trim(), 'base64'));
      } catch { sigOk = false; }
      if (!sigOk) return { ok: false, error: 'signature_invalid' };

      const expected = parseSumsEntry(sums, SETUP_ASSET);
      if (!expected) return { ok: false, error: 'integrity_missing' };

      const res = await fetchImpl(exeUrl, { headers: { 'User-Agent': 'XenonEdgeHub' }, signal: AbortSignal.timeout(300000) });
      if (!res || !res.ok || !res.body) return { ok: false, error: 'download_failed' };
      const h = crypto.createHash('sha256');
      await new Promise((resolve, reject) => {
        const ws = f.createWriteStream(dl);
        const rs = Readable.fromWeb(res.body);
        rs.on('data', (c) => h.update(c));
        rs.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', resolve);
        rs.pipe(ws);
      });
      const got = h.digest('hex');
      if (got !== expected) { drop(); return { ok: false, error: 'hash_mismatch' }; }
      // Only a verified file ever carries the name the install script runs.
      f.renameSync(dl, target);
      return { ok: true, path: target, sha256: expected };
    } catch {
      drop();
      return { ok: false, error: 'download_failed' };
    }
  }

  return { fetchVerified };
}

module.exports = { createNativeInstallerFetch, SETUP_ASSET };
