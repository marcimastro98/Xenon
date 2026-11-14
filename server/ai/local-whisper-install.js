'use strict';
// Installs whisper.cpp when the user asks for local speech to text: the pinned download on
// Windows, Homebrew on macOS.

const { psEscape } = require('../ps-quote.js');
const { checkPinnedSha256 } = require('../pinned-hash.js');
const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { whisperPaths, whisperExe } = require('./local-stt.js');

// The exact whisper.cpp build Xenon installs, and the SHA-256 of its zip. The
// zip's whisper-cli.exe is executed on every voice request, so "whatever the
// newest release is" was code from a third party's account running here with
// nothing checking it, including pre-releases nobody had looked at. One tagged
// version, one asset, one hash: bump all three together after checking that the
// new zip still carries whisper-cli.exe (whisper.cpp stopped attaching binaries
// to its tags at v1.9.4, so a newer TAG is not automatically a usable one).
const WHISPER_VERSION = 'v1.9.2';
const WHISPER_ASSET = 'whisper-bin-x64.zip';
const WHISPER_ZIP_SHA256 = '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a';
const WHISPER_ZIP_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/${WHISPER_ASSET}`;

// HTTPS GET to a file, following 30x redirects (GitHub asset and HuggingFace
// URLs both redirect to a CDN). Streams to destPath and reports received/total
// bytes from content-length. Rejects on non-200 (after redirects) or timeout.
function _downloadToFile(url, destPath, onProgress, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'XenonEdgeHub' } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(_downloadToFile(next, destPath, onProgress, _redirects + 1));
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error('download http ' + code + ' for ' + url));
      }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      const file = fs.createWriteStream(destPath);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (typeof onProgress === 'function') { try { onProgress(received, total); } catch { /* ignore */ } }
      });
      res.on('error', (e) => { file.close(); fs.promises.unlink(destPath).catch(() => {}); reject(e); });
      file.on('error', (e) => { res.destroy(); fs.promises.unlink(destPath).catch(() => {}); reject(e); });
      file.on('finish', () => file.close(() => resolve()));
      res.pipe(file);
    });
    req.on('error', reject);
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('download timed out: ' + url)); });
  });
}

// Extract a zip via the .NET ZipFile API. We deliberately AVOID Expand-Archive:
// that pure-PowerShell cmdlet is 10–50× slower and streams no progress, so a
// large extraction looked frozen. ZipFile::ExtractToDirectory is the fast native
// path. The caller passes a FRESH (non-existent) destDir, so the plain 2-arg
// overload is enough — the overwrite (3-arg) overload is missing on Windows
// PowerShell 5.1 / .NET Framework, so we never rely on it. Single quotes in paths
// are doubled so the PowerShell single-quoted literals stay intact.
function _unzipWindows(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const z = psEscape(zipPath);
    const d = psEscape(destDir);
    const ps =
      `Unblock-File -LiteralPath '${z}' -ErrorAction SilentlyContinue; ` +
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${z}','${d}')`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 120000 },
      (err) => err ? reject(new Error('unzip failed: ' + err.message)) : resolve());
  });
}

// ── Homebrew (macOS only) ────────────────────────────────────────────────────
// The server usually runs from a LaunchAgent, whose PATH does not include either
// Homebrew prefix, so `brew` is located by absolute path rather than by name.
function _findBrew() {
  for (const p of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

// Run `brew install <formula>`. Rejects with brew's own last words rather than a
// generic failure — a formula that needs Xcode Command Line Tools says so, and
// that message is the whole answer for the user. 20 minutes: a source build on a
// cold machine is genuinely slow, and a timeout mid-build leaves a half state
// brew itself has to clean up.
function _runBrewInstall(brewPath, formula) {
  return new Promise((resolve, reject) => {
    execFile(brewPath, ['install', formula], { timeout: 20 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve();
        const detail = String(stderr || stdout || err.message || '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
        reject(new Error(`brew install ${formula} failed: ${detail || err.message}`));
      });
  });
}

// Recursively locate a whisper executable under `dir`. Returns the full path or
// null. Used after unzip to find where the release placed the binary.
function _findWhisperExeRecursive(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const names = ['whisper-cli.exe', 'main.exe', 'whisper.exe'];
  for (const ent of entries) {
    if (ent.isFile() && names.includes(ent.name.toLowerCase())) return path.join(dir, ent.name);
  }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      const found = _findWhisperExeRecursive(path.join(dir, ent.name));
      if (found) return found;
    }
  }
  return null;
}

// Download + set up Whisper.cpp on demand. onProgress({ status, percent }).
//  1. Ensure the whisper dir exists.
//  2. If no exe: download the pinned whisper.cpp Windows x64 zip (0→40%),
//     check it against WHISPER_ZIP_SHA256, unzip, delete the zip, then flatten
//     so the exe sits in the dir root next to its ggml*.dll siblings.
//  3. If the ggml-small model is missing: download it (45→100%).
// Returns { ok } reflecting whether both the exe and model are now present.
async function installWhisper(serverDir, onProgress) {
  const report = (status, percent) => {
    if (typeof onProgress === 'function') { try { onProgress({ status, percent }); } catch { /* ignore */ } }
  };
  const { dir, model } = whisperPaths(serverDir);
  await fs.promises.mkdir(dir, { recursive: true });

  // macOS has no prebuilt whisper.cpp to download: the project's releases carry
  // Windows binaries only. Homebrew's `whisper-cpp` formula is the supported
  // path, and it builds with Metal — so on Apple Silicon this is also the FASTER
  // install, not a workaround. Everything after this branch (the model download)
  // is shared.
  if (process.platform === 'darwin') {
    if (!whisperExe(serverDir)) {
      const brew = _findBrew();
      if (!brew) {
        throw new Error('Whisper needs Homebrew on macOS. Install Homebrew from https://brew.sh, then run: brew install whisper-cpp');
      }
      report('Installazione Whisper (Homebrew)…', 5);
      await _runBrewInstall(brew, 'whisper-cpp');
      if (!whisperExe(serverDir)) {
        throw new Error('brew install whisper-cpp completed but whisper-cli was not found. Run it manually to see why.');
      }
    }
  } else if (process.platform !== 'win32') {
    // whisper.cpp publishes no Linux binary Xenon could unpack without a build
    // toolchain, and the Windows zip is useless here. The distro package puts
    // whisper-cli on a system path whisperExe() already looks in.
    if (!whisperExe(serverDir)) {
      throw new Error('Install whisper.cpp with your package manager (it provides whisper-cli), then press Download again to fetch the voice model.');
    }
  } else if (!whisperExe(serverDir)) {
    report('Download Whisper…', 0);
    const zipPath = path.join(dir, 'whisper.zip');
    await _downloadToFile(WHISPER_ZIP_URL, zipPath, (received, total) => {
      const frac = total > 0 ? received / total : 0;
      report('Download Whisper…', Math.round(frac * 40));
    });
    // Before anything is unpacked: a zip that is not the reviewed build is
    // deleted here, and its exe never reaches the folder localStt() runs from.
    await checkPinnedSha256(zipPath, WHISPER_ZIP_SHA256, 'whisper.cpp ' + WHISPER_VERSION);
    report('Estrazione Whisper…', 42);
    // Extract into a FRESH subfolder (removed first in case a prior attempt left
    // it behind), so the plain ZipFile overload never hits an "already exists"
    // conflict — then flatten the exe + its sibling DLLs up into `dir`.
    const unpackDir = path.join(dir, '_unpack');
    await fs.promises.rm(unpackDir, { recursive: true, force: true }).catch(() => {});
    await _unzipWindows(zipPath, unpackDir);
    await fs.promises.unlink(zipPath).catch(() => {});

    const exePath = _findWhisperExeRecursive(unpackDir);
    if (exePath) {
      const exeDir = path.dirname(exePath);
      const files = await fs.promises.readdir(exeDir);
      // Copy only what STT actually needs: the CLI exe and its runtime DLLs.
      // The release zip also ships ~8.5 MB of demo tools (talk-llama, wchess,
      // stream, bench, …) plus SDL2.dll, which only those demos use — skip them.
      const KEEP_EXES = new Set(['whisper-cli.exe', 'whisper.exe', 'main.exe']);
      const isNeeded = (name) => {
        const n = name.toLowerCase();
        if (KEEP_EXES.has(n)) return true;
        return n.endsWith('.dll') && n !== 'sdl2.dll';
      };
      for (const f of files) {
        if (!isNeeded(f)) continue;
        await fs.promises.copyFile(path.join(exeDir, f), path.join(dir, f)).catch(() => {});
      }
    }
    await fs.promises.rm(unpackDir, { recursive: true, force: true }).catch(() => {});
  }

  if (!fs.existsSync(model)) {
    report('Download modello vocale…', 45);
    await _downloadToFile('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin', model,
      (received, total) => {
        const frac = total > 0 ? received / total : 0;
        report('Download modello vocale…', 45 + Math.round(frac * 55));
      });
  }

  report('success', 100);
  if (typeof onProgress === 'function') { try { onProgress({ status: 'success', percent: 100, done: true }); } catch { /* ignore */ } }
  return { ok: !!whisperExe(serverDir) && fs.existsSync(model) };
}

module.exports = {
  WHISPER_VERSION, WHISPER_ASSET, WHISPER_ZIP_SHA256, WHISPER_ZIP_URL, _downloadToFile,
  _unzipWindows, _findBrew, _runBrewInstall, _findWhisperExeRecursive, installWhisper,
};
