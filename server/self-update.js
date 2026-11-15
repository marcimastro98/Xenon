'use strict';
const { psQuote } = require('./powershell/ps-quote');

// ── Self-update (safe two-step) ───────────────────────────────────────────────
// The "safer variant": preparing an update is fully NON-destructive — we download
// the new release zip and extract+validate it into DATA_DIR/update/app while the
// live install is never touched. Only when the user explicitly clicks "Apply &
// restart" do we hand off to an EXTERNAL applier — update-apply.ps1 on Windows,
// update-apply.sh on macOS — that swaps the staged files in, runs npm install
// and restarts, outside this Node process, with backup + rollback. Both appliers
// carry the SAME three guarantees (rename-snapshot of node_modules, rollback
// that also removes what the update added, success only after the new server
// answers /version); a change to one belongs in the other. If prepare fails
// (offline, bad zip), the running install is untouched and the user simply keeps
// the current version.
//
// Auto-update is disabled on a git checkout (a developer should `git pull`).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn: defaultSpawn } = require('child_process');
const { Readable } = require('stream');

const REPO = 'marcimastro98/Xenon';

// ── Release integrity (mandatory, fail-closed) ───────────────────────────────
// Every release carries two extra assets attached by CI (release-integrity.yml):
//   SHA256SUMS      "<sha256 hex>  source.zip" — hash of the tag's source zip
//   SHA256SUMS.sig  base64 Ed25519 signature over the raw SHA256SUMS bytes
// prepare() refuses to even EXTRACT a download unless the signature verifies
// against this pinned public key and the zip hashes to the signed value. This
// closes the documented gap where the update trusted TLS alone: a MITM'd
// download or a swapped release asset now fails with a clear reason instead of
// executing. The signing PRIVATE key lives only in the GitHub Actions secret
// XENON_UPDATE_SIGNING_KEY (never in the repo). Rotating it = new keypair,
// update the secret, replace this constant, ship that in a release signed by
// the OLD key first. The signature is required, not opportunistic — an
// attacker who could strip a "verify if present" signature would defeat it.
const UPDATE_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAlH0Ju7LRPoy6sJlBwPHAhTCv1ck9RmPz9C2V1AzvOBk=
-----END PUBLIC KEY-----`;

// Name the source-zip hash is filed under inside SHA256SUMS (tag-agnostic so
// the parser never has to reconstruct GitHub's "Xenon-<tag>.zip" naming).
const SUMS_ENTRY_NAME = 'source.zip';

// GitHub serves a tag's source as a zip whose single top-level folder we unwrap.
function buildZipUrl(repo, tag) {
  return `https://github.com/${repo}/archive/refs/tags/${encodeURIComponent(tag)}.zip`;
}

// Direct-download URL for an asset attached to the tag's release.
function buildAssetUrl(repo, tag, name) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${name}`;
}

// Extract the hex digest recorded for `name` from SHA256SUMS text (the
// standard "<hex><space><space-or-*><name>" sha256sum line format). Returns ''
// when the entry is absent or malformed.
function parseSumsEntry(text, name) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(line.trim());
    if (m && m[2].trim() === name) return m[1].toLowerCase();
  }
  return '';
}

// The lone top-level directory GitHub wraps the archive in (e.g. "Xenon-3.3.0").
function pickSingleDir(entries) {
  const dirs = (entries || []).filter((e) => e && e.isDirectory && e.isDirectory());
  return dirs.length === 1 ? dirs[0].name : null;
}

const { makeApply } = require('./updates/self-update-apply.js');

const { makeSupport } = require('./updates/self-update-support.js');

// opts (all injectable for tests): root, dataDir, repo, fetchImpl, spawn,
// fsImpl, publicKeyPem, platform.
function createSelfUpdate(opts) {
  const o = opts || {};
  const root = o.root;
  const dataDir = o.dataDir;
  const repo = o.repo || REPO;
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  const spawn = o.spawn || defaultSpawn;
  const f = o.fsImpl || fs;
  const publicKeyPem = o.publicKeyPem || UPDATE_PUBKEY_PEM;
  const platform = o.platform || process.platform;
  // macOS and Linux share one applier (update-apply.sh) and one extractor; only
  // how the applier is LAUNCHED differs between them (see apply()).
  const isPosix = platform === 'darwin' || platform === 'linux';

  const updDir = path.join(dataDir, 'update');
  const extractDir = path.join(updDir, '_extract');
  const appDir = path.join(updDir, 'app');          // unwrapped staged tree (applier reads this)
  const zipPath = path.join(updDir, 'download.zip');
  const markerPath = path.join(updDir, 'staged.json');
  // Both appliers are tracked files, so BOTH exist in every checkout; which one
  // can actually run is what the platform decides.
  const applierPath = path.join(root, 'server', isPosix ? 'update-apply.sh' : 'update-apply.ps1');
  // Full explicit path to Windows PowerShell, so launching the applier can never
  // be misread as "open this .ps1 with its file association" (which pops the
  // Windows "select an app for this .ps1" picker on machines where the bare
  // `powershell` name resolves oddly under ShellExecute).
  const psExe = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  const {
    isGitCheckout, unsupportedReason, supported, _installWritable, needsElevation,
    shellUpdatesSilently,
  } = makeSupport({ root, f, platform, isPosix, applierPath });

  function _rm(p) { try { f.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }

  function _readStagedVersion() {
    try {
      const m = JSON.parse(f.readFileSync(markerPath, 'utf8'));
      if (m && typeof m.version === 'string' && f.existsSync(path.join(appDir, 'server', 'server.js'))) {
        return m.version;
      }
    } catch { /* no/invalid staging */ }
    return '';
  }

  // Non-destructive: returns { version } if a validated staged build is ready.
  function staged() {
    const v = _readStagedVersion();
    return v ? { version: v } : null;
  }

  function _expandArchive() {
    return new Promise((resolve, reject) => {
      // macOS/Linux: `unzip` is part of the base system on macOS and a package
      // install.sh reports as missing on Linux, and the argv array keeps both
      // paths as discrete arguments (no shell, nothing to quote). Windows keeps
      // the PowerShell path it has always used, where the single quotes inside
      // the -Command string are doubled for the same reason.
      const [file, args] = isPosix
        ? ['unzip', ['-qq', '-o', zipPath, '-d', extractDir]]
        : ['powershell', ['-NoProfile', '-NonInteractive', '-Command',
          `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(extractDir)} -Force`]];
      const p = spawn(file, args, { windowsHide: true });
      let err = '';
      if (p.stderr) p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('archive extraction failed: ' + err.slice(0, 300)))));
    });
  }

  // Fetch a small release asset as text (the SHA256SUMS pair). Distinct from
  // the zip download: tiny, so no streaming, and a miss means the release has
  // no integrity data yet (CI attaches it ~a minute after publish) — the
  // caller fails closed with a retryable reason instead of applying blind.
  async function _fetchAssetText(tag, name) {
    const res = await fetchImpl(buildAssetUrl(repo, tag, name), {
      headers: { 'User-Agent': 'XenonEdgeHub' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res || !res.ok) return null;
    return await res.text();
  }

  // Verify the downloaded zip against the release's signed SHA256SUMS before
  // anything touches it (even extraction — never feed an unverified archive to
  // Expand-Archive). Throws integrity_missing / signature_invalid /
  // integrity_mismatch; on success the download is exactly what CI hashed.
  async function _verifyDownload(tag, zipSha256Hex) {
    let sums = null, sigB64 = null;
    try {
      [sums, sigB64] = await Promise.all([
        _fetchAssetText(tag, 'SHA256SUMS'),
        _fetchAssetText(tag, 'SHA256SUMS.sig'),
      ]);
    } catch { /* network problem → treated as missing below */ }
    if (!sums || !sigB64) throw new Error('integrity_missing');

    let sigOk = false;
    try {
      const key = crypto.createPublicKey(publicKeyPem);
      sigOk = crypto.verify(null, Buffer.from(sums, 'utf8'), key, Buffer.from(sigB64.trim(), 'base64'));
    } catch { sigOk = false; }
    if (!sigOk) throw new Error('signature_invalid');

    const expected = parseSumsEntry(sums, SUMS_ENTRY_NAME);
    if (!expected || expected !== zipSha256Hex) throw new Error('integrity_mismatch');
  }

  const suRun = {
    // Download + extract + validate the target release into appDir. Throws on any
    // problem WITHOUT touching the live install (everything happens under DATA_DIR).
    //
    // One at a time, and never while an applier runs. _prepare() starts by wiping
    // DATA_DIR/update: a second prepare racing the first corrupts the same folder,
    // and a prepare during an apply deletes update/app while the applier is
    // copying from it. Two dashboards, or the automatic updater and a tap on
    // "Update now", are enough to get there.
    preparing: null,
    // Hand off to the external applier. The staged build must be ready; the live
    // install is only modified from here on, outside this Node process.
    applyStartedAt: 0, // in-flight guard — two appliers racing = a mixed tree
    lastSpawnError: '',
  };
  function prepare(args) {
    if (suRun.preparing) return Promise.reject(new Error('prepare_in_flight'));
    if (applyInFlight()) return Promise.reject(new Error('apply_in_flight'));
    suRun.preparing = _prepare(args || {}).finally(() => { suRun.preparing = null; });
    return suRun.preparing;
  }
  function isPreparing() { return !!suRun.preparing; }

  async function _prepare({ tag, version }) {
    if (!tag || !version) throw new Error('bad_args');
    if (isGitCheckout()) throw new Error('git_checkout');

    _rm(updDir);
    f.mkdirSync(updDir, { recursive: true });

    // 1) Download the source zip for the tag (streamed to disk), hashing the
    //    bytes as they pass so verification needs no second read.
    const res = await fetchImpl(buildZipUrl(repo, tag), {
      headers: { 'User-Agent': 'XenonEdgeHub' },
      signal: AbortSignal.timeout(180000),
    });
    if (!res || !res.ok || !res.body) throw new Error('download_failed');
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const ws = f.createWriteStream(zipPath);
      const rs = Readable.fromWeb(res.body);
      rs.on('data', (chunk) => hash.update(chunk));
      rs.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });

    // 1b) Mandatory integrity gate — signed SHA256SUMS must match the download.
    await _verifyDownload(tag, hash.digest('hex'));

    // 2) Extract and unwrap the single top-level folder into appDir.
    await _expandArchive();
    const entries = f.readdirSync(extractDir, { withFileTypes: true });
    const top = pickSingleDir(entries);
    if (!top) throw new Error('unexpected_archive');
    f.renameSync(path.join(extractDir, top), appDir);

    // 3) Validate: it must look like Xenon and carry the expected version.
    //    Compare with a leading "v" stripped from both sides — a "v"-prefixed
    //    package.json version once shipped and made this check reject every
    //    otherwise-valid build (staged "v3.2.6" vs release tag "3.2.6"), so
    //    prepare always failed with version_mismatch and forced a manual,
    //    data-losing download. Normalizing keeps a stray "v" from recurring.
    if (!f.existsSync(path.join(appDir, 'server', 'server.js'))) throw new Error('invalid_build');
    let pkgVer = '';
    try { pkgVer = String(JSON.parse(f.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version || ''); } catch { /* below */ }
    const normVer = (s) => String(s || '').trim().replace(/^v/i, '');
    if (normVer(pkgVer) !== normVer(version)) throw new Error('version_mismatch');

    // 4) Mark ready; drop the now-useless zip + extract scratch.
    f.writeFileSync(markerPath, JSON.stringify({ version, at: Date.now() }));
    _rm(zipPath);
    _rm(extractDir);
    return { ok: true, version };
  }

  const {
    applyInFlight, apply,
  } = makeApply({ spawn, f, platform, isPosix, applierPath, psExe, supported, _installWritable, staged, suRun });

  return {
    isGitCheckout, supported, unsupportedReason, applierPath, staged, prepare, apply,
    isPreparing, applyInFlight, needsElevation, shellUpdatesSilently, lastSpawnError: () => suRun.lastSpawnError,
    _buildZipUrl: (t) => buildZipUrl(repo, t),
  };
}

module.exports = {
  createSelfUpdate, buildZipUrl, buildAssetUrl, pickSingleDir, parseSumsEntry,
  SELF_UPDATE_REPO: REPO, UPDATE_PUBKEY_PEM, SUMS_ENTRY_NAME,
};
