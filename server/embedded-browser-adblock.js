'use strict';
// One-click, opt-in ad-blocker for the embedded Browser widget.
//
// The Browser tile normally runs headless Edge with `--disable-extensions` to stay
// lean. When the user opts in (Settings → Browser), we fetch uBlock Origin Lite
// (MV3) — the vendor ships a ready-to-load Edge build as a GitHub release asset —
// unpack it into the runtime data dir, and `embedded-browser.js` relaunches Edge
// with `--load-extension` pointing at it. Off by default: nothing is downloaded or
// loaded until the user turns it on, so the default footprint is unchanged.
//
// uBOL (Lite) is used rather than full uBlock Origin because current Edge/Chromium
// disable Manifest V2 at the browser level, which makes an unpacked MV2 uBO
// unreliable; uBOL's MV3 Edge zip is a clean, store-free, one-click artifact.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const RELEASE_API = 'https://api.github.com/repos/uBlockOrigin/uBOL-home/releases/latest';

function dir(dataDir) { return path.join(dataDir, 'embedded-browser-adblock'); }
// The live, fully-installed extension lives under `current/` and is only ever
// created by an atomic rename at the very end of install() — so its mere presence
// means a complete install. Staging happens in a sibling temp dir first.
function currentDir(dataDir) { return path.join(dir(dataDir), 'current'); }
function stageDir(dataDir) { return path.join(dir(dataDir), '_stage'); }

// Recursively locate the directory that holds the extension's manifest.json. Used
// ONLY during install to find where the zip placed it (the uBOL edge zip puts it at
// the archive root today; a recursive search keeps us robust if it's ever nested).
function _findManifestDir(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  if (entries.some((e) => e.isFile() && e.name.toLowerCase() === 'manifest.json')) return root;
  for (const ent of entries) {
    if (ent.isDirectory()) {
      const found = _findManifestDir(path.join(root, ent.name));
      if (found) return found;
    }
  }
  return null;
}

// The directory to pass to Edge's --load-extension, or null when not installed. A
// shallow check (manifest at the promoted `current/` root) — no tree walk on the
// request/launch path, and true only for a complete install (see install()).
function extensionDir(dataDir) {
  const cur = currentDir(dataDir);
  try { if (fs.existsSync(path.join(cur, 'manifest.json'))) return cur; } catch { /* ignore */ }
  return null;
}

function isInstalled(dataDir) { return !!extensionDir(dataDir); }

// HTTPS GET → parsed JSON, following redirects (GitHub API sends the recommended
// Accept + User-Agent headers). Mirrors the pattern in ai-local.js.
function _httpsJson(url, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'XenonEdgeHub', 'Accept': 'application/vnd.github+json' } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        return resolve(_httpsJson(new URL(res.headers.location, url).toString(), _redirects + 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error('http ' + code + ' for ' + url)); }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid JSON from ' + url)); } });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('request timed out: ' + url)); });
  });
}

// HTTPS GET → file, following the CDN redirects GitHub release assets use.
function _downloadToFile(url, destPath, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'XenonEdgeHub' } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        return resolve(_downloadToFile(new URL(res.headers.location, url).toString(), destPath, _redirects + 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error('download http ' + code + ' for ' + url)); }
      const file = fs.createWriteStream(destPath);
      res.on('error', (e) => { file.close(); fs.promises.unlink(destPath).catch(() => {}); reject(e); });
      file.on('error', (e) => { res.destroy(); fs.promises.unlink(destPath).catch(() => {}); reject(e); });
      file.on('finish', () => file.close(() => resolve()));
      res.pipe(file);
    });
    req.on('error', reject);
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('download timed out: ' + url)); });
  });
}

// Extract a zip via the .NET ZipFile API (fast native path; Expand-Archive is far
// slower). The destDir must not already exist — the plain 2-arg overload can't
// overwrite. Single quotes in paths are doubled so the PS literals stay intact.
function _unzipWindows(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const z = zipPath.replace(/'/g, "''");
    const d = destDir.replace(/'/g, "''");
    const ps =
      `Unblock-File -LiteralPath '${z}' -ErrorAction SilentlyContinue; ` +
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${z}','${d}')`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 120000 },
      (err) => err ? reject(new Error('unzip failed: ' + err.message)) : resolve());
  });
}

// Promote the staged tree with retries. Right after extraction Windows Defender
// (and the search indexer) still hold handles on the freshly-written files, and a
// directory rename then fails with a transient EPERM — reproduced reliably on a
// real install: the same rename succeeds moments later. Retrying with backoff
// (~15s worst case) turns "Impossibile installare" into a normal install.
async function _renameWithRetry(from, to) {
  const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
  let delay = 250;
  for (let attempt = 0; ; attempt++) {
    try { await fs.promises.rename(from, to); return; }
    catch (e) {
      if (attempt >= 7 || !RETRYABLE.has(e && e.code)) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 4000);
    }
  }
}

let _installing = null;   // in-flight install promise — coalesces concurrent requests

// Download + unpack uBOL on demand. Idempotent: a concurrent call joins the same
// promise; a completed install is detected up-front and returns immediately.
async function install(dataDir) {
  if (isInstalled(dataDir)) return { ok: true, installed: true };
  if (_installing) return _installing;
  _installing = (async () => {
    const base = dir(dataDir);
    const stage = stageDir(dataDir);
    const cur = currentDir(dataDir);
    await fs.promises.mkdir(base, { recursive: true });
    await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});   // clear any prior partial attempt

    const release = await _httpsJson(RELEASE_API);
    const assets = Array.isArray(release && release.assets) ? release.assets : [];
    const pick = (re) => assets.find((a) => a && typeof a.name === 'string' && a.browser_download_url && re.test(a.name));
    // Prefer the Edge-specific build (the tile IS Edge); fall back to the generic
    // Chromium build. Never the firefox/safari assets.
    const asset = pick(/\.edge\.zip$/i) || pick(/\.chromium\.zip$/i);
    if (!asset) throw new Error('No uBOL Edge/Chromium release asset found');

    const zipPath = path.join(base, 'ubol.zip');
    await _downloadToFile(asset.browser_download_url, zipPath);
    await _unzipWindows(zipPath, stage);
    await fs.promises.unlink(zipPath).catch(() => {});

    // Verify the unpack, then promote it to `current` atomically: a rename is the
    // last step, so `current/manifest.json` never exists for a half-extracted tree
    // (a crash/timeout mid-unzip leaves only `_stage`, which the next run wipes).
    const manifestDir = _findManifestDir(stage);
    if (!manifestDir) throw new Error('uBOL manifest.json not found after unpack');
    await fs.promises.rm(cur, { recursive: true, force: true }).catch(() => {});
    await _renameWithRetry(manifestDir, cur);
    await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});   // leftover wrapper if it was nested
    return { ok: true, installed: true };
  })();
  try { return await _installing; }
  finally { _installing = null; }
}

function isBusy() { return !!_installing; }

module.exports = { dir, extensionDir, isInstalled, install, isBusy };
