'use strict';
// Verified download of ONE named asset of the latest release, for scripts.
//
//   node release-asset-cli.js <assetName> <destDir>
//
// Prints one line of JSON: {"ok":true,"path":"...","sha256":"..."} or
// {"ok":false,"error":"..."}. Exit code 0 when verified, 1 otherwise.
//
// Why: the PowerShell installers used to fetch release binaries over TLS and
// check nothing but a version number (helper-update.ps1 and xenon-helper.exe
// on a first install). A swapped release asset, a compromised mirror or a man
// in the middle with a trusted root would then get code run on the next start.
// This is the same trust chain native-installer.js gives the native app setup
// and helper-update.js gives the boot-time helper refresh, for any asset the
// signed list carries:
//
//   releases/latest -> SHA256SUMS + SHA256SUMS.sig -> Ed25519 signature checked
//   against the PINNED public key (self-update.js) -> the line for <assetName>
//   -> the downloaded bytes must hash to exactly that before the file is kept.
//
// Anything that does not verify fails closed: the partial download is deleted
// and nothing is left under the asset's name. The calling script hashes the file
// again right before it uses it, so a file swapped after this check is refused.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { UPDATE_PUBKEY_PEM, SELF_UPDATE_REPO, parseSumsEntry } = require('./self-update');

const SUMS_ASSET = 'SHA256SUMS';
const SIG_ASSET = 'SHA256SUMS.sig';

// A plain file name: it becomes a path component under destDir, so nothing that
// could climb out of it (separators, "..") and nothing exotic. The signed list
// itself is not an "asset" this can hand out.
function isValidAssetName(name) {
  if (typeof name !== 'string') return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) return false;
  if (name.includes('..')) return false;
  if (name === SUMS_ASSET || name === SIG_ASSET) return false;
  return true;
}

// opts (deps injectable for tests): assetName, destDir (where the verified file
// lands, as destDir/assetName), repo, fetchImpl, fsImpl, publicKeyPem.
function createReleaseAssetFetch(opts) {
  const o = opts || {};
  const assetName = o.assetName;
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
  // manifest, or { ok: false, error }. Never throws.
  async function fetchVerified() {
    if (!isValidAssetName(assetName)) return { ok: false, error: 'bad_asset' };
    if (typeof destDir !== 'string' || !destDir || !path.isAbsolute(destDir)) return { ok: false, error: 'no_dest' };
    const target = path.join(destDir, assetName);
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
      const assetUrl = _assetUrl(rel, assetName);
      if (!assetUrl) return { ok: false, error: 'no_asset' };
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

      const expected = parseSumsEntry(sums, assetName);
      if (!expected) return { ok: false, error: 'integrity_missing' };

      const res = await fetchImpl(assetUrl, { headers: { 'User-Agent': 'XenonEdgeHub' }, signal: AbortSignal.timeout(300000) });
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
      // Only a verified file ever carries the asset's own name.
      f.renameSync(dl, target);
      return { ok: true, path: target, sha256: expected };
    } catch {
      drop();
      return { ok: false, error: 'download_failed' };
    }
  }

  return { fetchVerified };
}

async function main(argv, deps) {
  const assetName = argv[2];
  const destDir = argv[3];
  if (!isValidAssetName(assetName)) return { ok: false, error: 'bad_asset' };
  if (!destDir) return { ok: false, error: 'no_dest' };
  return createReleaseAssetFetch({ ...(deps || {}), assetName, destDir: path.resolve(destDir) }).fetchVerified();
}

if (require.main === module) {
  main(process.argv)
    .catch(() => ({ ok: false, error: 'download_failed' }))
    .then((r) => {
      process.stdout.write(JSON.stringify(r) + '\n');
      process.exitCode = r && r.ok ? 0 : 1;
    });
}

module.exports = { createReleaseAssetFetch, isValidAssetName, main };
