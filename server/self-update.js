'use strict';

// ── Self-update (safe two-step) ───────────────────────────────────────────────
// The "safer variant": preparing an update is fully NON-destructive — we download
// the new release zip and extract+validate it into DATA_DIR/update/app while the
// live install is never touched. Only when the user explicitly clicks "Apply &
// restart" do we hand off to an EXTERNAL PowerShell applier (update-apply.ps1)
// that swaps the staged files in, runs npm install and restarts — outside this
// Node process, with backup + rollback. If prepare fails (offline, bad zip), the
// running install is untouched and the user simply keeps the current version.
//
// Auto-update is disabled on a git checkout (a developer should `git pull`).

const fs = require('fs');
const path = require('path');
const { spawn: defaultSpawn } = require('child_process');
const { Readable } = require('stream');

const REPO = 'marcimastro98/Xenon';

// GitHub serves a tag's source as a zip whose single top-level folder we unwrap.
function buildZipUrl(repo, tag) {
  return `https://github.com/${repo}/archive/refs/tags/${encodeURIComponent(tag)}.zip`;
}

// The lone top-level directory GitHub wraps the archive in (e.g. "Xenon-3.3.0").
function pickSingleDir(entries) {
  const dirs = (entries || []).filter((e) => e && e.isDirectory && e.isDirectory());
  return dirs.length === 1 ? dirs[0].name : null;
}

// opts (all injectable for tests): root, dataDir, repo, fetchImpl, spawn, fsImpl.
function createSelfUpdate(opts) {
  const o = opts || {};
  const root = o.root;
  const dataDir = o.dataDir;
  const repo = o.repo || REPO;
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  const spawn = o.spawn || defaultSpawn;
  const f = o.fsImpl || fs;

  const updDir = path.join(dataDir, 'update');
  const extractDir = path.join(updDir, '_extract');
  const appDir = path.join(updDir, 'app');          // unwrapped staged tree (applier reads this)
  const zipPath = path.join(updDir, 'download.zip');
  const markerPath = path.join(updDir, 'staged.json');
  const applierPath = path.join(root, 'server', 'update-apply.ps1');
  // Full explicit path to Windows PowerShell, so launching the applier can never
  // be misread as "open this .ps1 with its file association" (which pops the
  // Windows "select an app for this .ps1" picker on machines where the bare
  // `powershell` name resolves oddly under ShellExecute).
  const psExe = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  function isGitCheckout() {
    try { return f.existsSync(path.join(root, '.git')); } catch { return false; }
  }

  // Auto-update needs the external applier script present and must not run on a
  // dev checkout (git). The helper exe / node version don't matter here.
  function supported() {
    try { return !isGitCheckout() && f.existsSync(applierPath); } catch { return false; }
  }

  function _rm(p) { try { f.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }

  // True when the current user can write the install root — i.e. the swap needs
  // no admin rights (the common case: Xenon unzipped into a user-writable folder
  // like Desktop/Downloads, not under Program Files). Probing with a throwaway
  // file is cheaper and more honest than guessing from the path.
  function _installWritable() {
    const probe = path.join(root, '.xenon-update-write-test');
    try {
      f.writeFileSync(probe, '');
      f.rmSync(probe, { force: true });
      return true;
    } catch { return false; }
  }

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
      const args = ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`];
      const p = spawn('powershell', args, { windowsHide: true });
      let err = '';
      if (p.stderr) p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('Expand-Archive failed: ' + err.slice(0, 300)))));
    });
  }

  // Download + extract + validate the target release into appDir. Throws on any
  // problem WITHOUT touching the live install (everything happens under DATA_DIR).
  async function prepare({ tag, version }) {
    if (!tag || !version) throw new Error('bad_args');
    if (isGitCheckout()) throw new Error('git_checkout');

    _rm(updDir);
    f.mkdirSync(updDir, { recursive: true });

    // 1) Download the source zip for the tag (streamed to disk).
    const res = await fetchImpl(buildZipUrl(repo, tag), {
      headers: { 'User-Agent': 'XenonEdgeHub' },
      signal: AbortSignal.timeout(180000),
    });
    if (!res || !res.ok || !res.body) throw new Error('download_failed');
    await new Promise((resolve, reject) => {
      const ws = f.createWriteStream(zipPath);
      Readable.fromWeb(res.body).pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });

    // 2) Extract and unwrap the single top-level folder into appDir.
    await _expandArchive();
    const entries = f.readdirSync(extractDir, { withFileTypes: true });
    const top = pickSingleDir(entries);
    if (!top) throw new Error('unexpected_archive');
    f.renameSync(path.join(extractDir, top), appDir);

    // 3) Validate: it must look like Xenon and carry the expected version.
    if (!f.existsSync(path.join(appDir, 'server', 'server.js'))) throw new Error('invalid_build');
    let pkgVer = '';
    try { pkgVer = String(JSON.parse(f.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version || ''); } catch { /* below */ }
    if (pkgVer !== version) throw new Error('version_mismatch');

    // 4) Mark ready; drop the now-useless zip + extract scratch.
    f.writeFileSync(markerPath, JSON.stringify({ version, at: Date.now() }));
    _rm(zipPath);
    _rm(extractDir);
    return { ok: true, version };
  }

  // Hand off to the external applier. The staged build must be ready; the live
  // install is only modified from here on, outside this Node process.
  function apply() {
    if (!supported()) return { ok: false, error: 'unsupported' };
    if (!staged()) return { ok: false, error: 'not_staged' };
    // The applier always re-launches itself as an independent -Worker child, which
    // breaks out of Node's kill-on-close job (Windows "silent breakaway") and so
    // survives this server being stopped mid-swap. We only choose HOW it relaunches:
    //
    // - Install dir is WRITABLE (common case): pass -NoElevate. The applier
    //   relaunches via a plain Start-Process (no 'runas'), so NO UAC prompt ever
    //   appears. This is the fix for multi-monitor / touchscreen setups (e.g. the
    //   Xeneon Edge): the UAC secure-desktop prompt lands on the primary monitor
    //   and can be impossible to find or tap.
    // - Install dir is NOT writable: the applier relaunches elevated via
    //   ShellExecute 'runas' (one UAC prompt) so it can write a protected location.
    //
    // The launcher here must keep a console (so NOT detached): a console-less
    // powershell (DETACHED_PROCESS) silently exits without running the script.
    const noElevate = _installWritable();
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', applierPath];
    if (noElevate) args.push('-NoElevate');
    const child = spawn(psExe, args, { windowsHide: false, stdio: 'ignore' });
    child.unref();
    return { ok: true, started: true };
  }

  return { isGitCheckout, supported, staged, prepare, apply, _buildZipUrl: (t) => buildZipUrl(repo, t) };
}

module.exports = { createSelfUpdate, buildZipUrl, pickSingleDir, SELF_UPDATE_REPO: REPO };
