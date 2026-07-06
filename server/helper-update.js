'use strict';

// ── Verified native-helper auto-refresh (the boot self-heal path) ─────────────
// The in-app self-update applies only the signed source zip; the native helper
// (xenon-helper.exe) ships as a SEPARATE release asset, so a freshly updated
// install would keep running a stale helper until the user re-ran INSTALL. The
// server heals it at boot — but, unlike the installer's TLS-only download
// (helper-update.ps1, the acknowledged first-install gap that code-signing will
// close), THIS path is cryptographically verified: it refuses to install any
// helper whose SHA-256 is not the one recorded in the release's Ed25519-SIGNED
// SHA256SUMS. Same signed manifest, same PINNED public key and same fail-closed
// discipline as self-update.js. Because this download auto-executes (the server
// spawns the exe), verifying it closes the "helper is the weakest link" gap: a
// swapped release asset or a MITM'd download no longer gets code run here.
//
// Trust chain: releases/latest → SHA256SUMS (+ .sig) → verify the signature
// against the pinned key → the expected xenon-helper.exe hash → the downloaded
// exe must hash to exactly that before it can replace anything. Anything that
// does not verify fails closed and the helper simply stays on the PowerShell path.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { UPDATE_PUBKEY_PEM, SELF_UPDATE_REPO, parseSumsEntry } = require('./self-update');

const HELPER_ASSET = 'xenon-helper.exe';
const SUMS_ASSET = 'SHA256SUMS';
const SIG_ASSET = 'SHA256SUMS.sig';

const normVer = (s) => String(s || '').trim().replace(/^v/i, '');

// opts (deps injectable for tests): helperExe (abs path), helperDir, appVersion,
// repo, fetchImpl, fsImpl, publicKeyPem, now.
function createHelperUpdate(opts) {
  const o = opts || {};
  const helperExe = o.helperExe;
  const helperDir = o.helperDir || path.dirname(helperExe);
  const appVersion = normVer(o.appVersion);
  const repo = o.repo || SELF_UPDATE_REPO;
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  const f = o.fsImpl || fs;
  const publicKeyPem = o.publicKeyPem || UPDATE_PUBKEY_PEM;
  const now = o.now || Date.now;

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

  function _sha256File(p) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      const rs = f.createReadStream(p);
      rs.on('data', (c) => h.update(c));
      rs.on('error', reject);
      rs.on('end', () => resolve(h.digest('hex')));
    });
  }

  function _assetUrl(rel, name) {
    const a = ((rel && rel.assets) || []).find((x) => x && x.name === name);
    return a ? a.browser_download_url : '';
  }

  // Drop temp/rename leftovers from a previous refresh (a .download that never
  // completed, or a .old-<ts> image released once the old server restarted).
  function _cleanupLeftovers() {
    try {
      for (const n of f.readdirSync(helperDir)) {
        if (n.startsWith('xenon-helper.old-') || n === 'xenon-helper.exe.download') {
          try { f.rmSync(path.join(helperDir, n), { force: true }); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  // Returns a status string; never throws. See server.js ensureHelperUpToDate for
  // how each status maps to "done" vs "retry":
  //   up-to-date | installed | skip-not-latest | no-helper  → terminal (record)
  //   not-ready | signature-invalid | mismatch | error      → retry
  async function refresh() {
    try {
      if (!f.existsSync(helperExe)) return 'no-helper';
      _cleanupLeftovers();

      const rel = await _json(`https://api.github.com/repos/${repo}/releases/latest`);
      if (!rel) return 'not-ready';

      // Only heal the helper to the version the running app expects. If the app
      // isn't on the latest release, latest's helper could pair a newer helper with
      // an older server — leave it until the app itself updates (which re-triggers).
      if (appVersion && normVer(rel.tag_name) !== appVersion) return 'skip-not-latest';

      const sumsUrl = _assetUrl(rel, SUMS_ASSET);
      const sigUrl = _assetUrl(rel, SIG_ASSET);
      const exeUrl = _assetUrl(rel, HELPER_ASSET);
      if (!sumsUrl || !sigUrl || !exeUrl) return 'not-ready'; // CI still attaching assets

      const [sums, sigB64] = await Promise.all([_text(sumsUrl), _text(sigUrl)]);
      if (!sums || !sigB64) return 'not-ready';

      let sigOk = false;
      try {
        const key = crypto.createPublicKey(publicKeyPem);
        sigOk = crypto.verify(null, Buffer.from(sums, 'utf8'), key, Buffer.from(sigB64.trim(), 'base64'));
      } catch { sigOk = false; }
      if (!sigOk) return 'signature-invalid';

      const expected = parseSumsEntry(sums, HELPER_ASSET);
      if (!expected) return 'not-ready'; // this release's signed sums don't cover the helper yet

      // Already the exact signed helper? Nothing to download.
      let installed = '';
      try { installed = await _sha256File(helperExe); } catch { /* re-download below */ }
      if (installed && installed === expected) return 'up-to-date';

      // Download to a temp file, hashing as it streams, and verify against the
      // signed hash BEFORE it can replace the running exe.
      const dl = helperExe + '.download';
      try { f.rmSync(dl, { force: true }); } catch { /* ignore */ }
      const res = await fetchImpl(exeUrl, { headers: { 'User-Agent': 'XenonEdgeHub' }, signal: AbortSignal.timeout(180000) });
      if (!res || !res.ok || !res.body) return 'not-ready';
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
      if (h.digest('hex') !== expected) {
        try { f.rmSync(dl, { force: true }); } catch { /* ignore */ }
        return 'mismatch';
      }

      // Install. A running server may hold the old exe mapped: deleting is blocked,
      // but RENAMING a running image is allowed — the fresh exe is picked up on the
      // next restart and the .old leftover is cleaned next run. rename() can't
      // overwrite an existing target on Windows, so the old exe must go first.
      try { f.rmSync(helperExe, { force: true }); }
      catch { try { f.renameSync(helperExe, helperExe + '.old-' + now()); } catch { /* left in place → next rename throws → retry */ } }
      f.renameSync(dl, helperExe);
      return 'installed';
    } catch {
      return 'error';
    }
  }

  return { refresh };
}

module.exports = { createHelperUpdate, HELPER_ASSET };
