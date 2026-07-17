'use strict';
// SignalRGB integration (Windows-only, opt-in) — scene switcher, not a colour
// provider.
//
// SignalRGB (WhirlwindFX) is driven ONLY by launching its helper with a URL:
//   SignalRgbLauncher.exe --url=effect/apply/<name>
// It applies a NAMED, pre-built lighting scene; there is no per-LED colour
// protocol. So Xenon treats SignalRGB as a SCENE SWITCHER exposed as a Deck
// action ("apply effect"), NOT as a provider inside the unified lighting engine
// (which drives real-time colour, album-follow and notification flashes across
// iCUE/Hue/WLED/…). This module only detects the launcher, lists the installed
// effects (async + cached), and applies one by name.
//
// Every filesystem path derives from environment dirs (LOCALAPPDATA / APPDATA /
// home) — no caller input reaches the FS. On non-Windows (or when SignalRGB
// isn't installed) detection returns false and the effect list is empty, so the
// feature simply stays dark.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SCAN_TTL_MS = 60 * 1000;      // effect libraries change rarely; re-scan at most ~once/min
const MAX_EFFECTS = 2000;           // hard cap on the returned list
const MAX_SCAN_FILES = 20000;       // hard cap on the FS walk (a huge library can't hang the scan)
const MAX_DEPTH = 6;                // effect html sits a couple levels deep; bound the recursion
const TITLE_READ_BYTES = 8192;      // the <title> lives near the top of an effect's html
const APPLY_TIMEOUT_MS = 10000;

let _cache = { at: 0, effects: null };
let _scanPromise = null;

function launcherPath() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return '';
  return path.join(localAppData, 'VortxEngine', 'SignalRgbLauncher.exe');
}

function isInstalled() {
  const p = launcherPath();
  try { return !!p && fs.existsSync(p); } catch { return false; }
}

// The set of dirs SignalRGB keeps effects in, tagged by kind. All from env/home.
function effectDirs() {
  const dirs = [];
  const localAppData = process.env.LOCALAPPDATA;
  const roaming = process.env.APPDATA;
  const home = os.homedir();

  // Built-in effects live under the newest installed app-* version folder.
  if (localAppData) {
    const vortx = path.join(localAppData, 'VortxEngine');
    let appDirs = [];
    try {
      appDirs = fs.readdirSync(vortx, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith('app-'))
        .map(e => e.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch { /* no VortxEngine dir */ }
    if (appDirs.length) dirs.push({ dir: path.join(vortx, appDirs[0], 'Signal-x64', 'effects'), type: 'Built-in' });
    dirs.push({ dir: path.join(localAppData, 'WhirlwindFX', 'SignalRgb', 'cache', 'effects'), type: 'Downloaded' });
  }
  if (roaming) dirs.push({ dir: path.join(roaming, 'WhirlwindFX', 'SignalRgb', 'cache', 'effects'), type: 'Downloaded' });
  if (home) {
    dirs.push({ dir: path.join(home, 'Documents', 'WhirlwindFX', 'Effects'), type: 'Custom' });
    dirs.push({ dir: path.join(home, 'OneDrive', 'Documents', 'WhirlwindFX', 'Effects'), type: 'Custom' });
  }
  return dirs;
}

// Read just the head of an effect's html and pull its <title> (the effect name).
async function effectTitle(file) {
  let fh = null;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(TITLE_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, TITLE_READ_BYTES, 0);
    const text = buf.toString('utf8', 0, bytesRead);
    const m = text.match(/<title>\s*([^<]+?)\s*<\/title>/i);
    return m ? m[1].trim().slice(0, 120) : null;
  } catch {
    return null;
  } finally {
    if (fh) { try { await fh.close(); } catch { /* already gone */ } }
  }
}

// Bounded async walk collecting .html paths into `out`.
async function walkHtml(dir, depth, out) {
  if (depth > MAX_DEPTH || out.length >= MAX_SCAN_FILES) return;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (out.length >= MAX_SCAN_FILES) return;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) await walkHtml(full, depth + 1, out);
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.html')) out.push({ file: full });
  }
}

async function doScan() {
  const seen = new Set();
  const list = [];
  for (const { dir, type } of effectDirs()) {
    if (list.length >= MAX_EFFECTS) break;
    const files = [];
    await walkHtml(dir, 0, files);
    for (const { file } of files) {
      if (list.length >= MAX_EFFECTS) break;
      const name = await effectTitle(file);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      list.push({ value: name, label: name + ' (' + type + ')' });
    }
  }
  list.sort((a, b) => a.value.localeCompare(b.value));
  return list;
}

// Cached, coalesced effect list. A concurrent second caller rides the same scan;
// the result is reused for SCAN_TTL_MS so the Deck editor opening repeatedly
// doesn't re-walk the disk each time.
async function scanEffects() {
  if (_cache.effects && Date.now() - _cache.at < SCAN_TTL_MS) return _cache.effects;
  if (_scanPromise) return _scanPromise;
  _scanPromise = (async () => {
    if (!isInstalled()) return [];
    return doScan();
  })()
    .then((effects) => { _cache = { at: Date.now(), effects }; return effects; })
    .finally(() => { _scanPromise = null; });
  return _scanPromise;
}

function clearCache() { _cache = { at: 0, effects: null }; }

// Apply a named effect by launching the helper. The name is encoded with
// encodeURIComponent so it can never inject extra params/fragments into the
// launcher's --url scheme; execFile takes an argv array (no shell), so there is
// no command-injection surface either.
function applyEffect(effectName) {
  return new Promise((resolve) => {
    const launcher = launcherPath();
    if (!launcher || !isInstalled()) { resolve({ ok: false, error: 'not_installed' }); return; }
    const name = String(effectName == null ? '' : effectName).trim();
    if (!name) { resolve({ ok: false, error: 'empty_effect' }); return; }
    const arg = '--url=effect/apply/' + encodeURIComponent(name) + '?-silentlaunch-';
    execFile(launcher, [arg], { windowsHide: true, timeout: APPLY_TIMEOUT_MS }, (err) => {
      resolve(err ? { ok: false, error: String((err && err.message) || err) } : { ok: true });
    });
  });
}

module.exports = { isInstalled, launcherPath, scanEffects, clearCache, applyEffect };
