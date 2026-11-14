'use strict';
// Starts the hidden browser behind the browser tile with its command line, reads the port it
// listens on, and ends it with everything it started.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { findEdge } = require('./browser-find.js');
const {
  pidFilePath, reapStaleProfileEdge, clearProfileLocks, sweepProfileEdge, resetPoisonedProfile,
} = require('./browser-profile.js');

// Read Edge's DevToolsActivePort file (line 1 = port, line 2 = browser ws path),
// polling until it appears or the timeout elapses.
function readDevToolsPort(portFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + (timeoutMs || 8000);
    const tick = () => {
      let txt = '';
      try { txt = fs.readFileSync(portFile, 'utf8'); } catch (e) { txt = ''; }
      const lines = txt.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length >= 2 && /^\d+$/.test(lines[0])) {
        resolve({ port: Number(lines[0]), wsPath: lines[1] });
        return;
      }
      if (Date.now() >= deadline) { reject(new Error('devtools_port_timeout')); return; }
      setTimeout(tick, 100).unref();
    };
    tick();
  });
}

// Kill the whole Edge process tree. `--headless=new` spawns child processes that
// hold the --user-data-dir singleton lock; on Windows a bare proc.kill() only
// signals the launcher and leaves those children orphaned, so the NEXT launch
// finds the profile in use, never writes DevToolsActivePort, and times out
// (surfacing as browser_err_launch). taskkill /T tears down the entire tree.
function killProcessTree(proc) {
  if (!proc) return;
  const pid = proc.pid;
  if (process.platform === 'win32' && pid) {
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); return; }
    catch (e) { /* fall through to the plain kill below */ }
  }
  try { proc.kill(); } catch (e) { /* ignore */ }
}


function edgeArgs(profileDir, extensionDirs) {
  const exts = Array.isArray(extensionDirs) ? extensionDirs.filter(Boolean) : [];
  const loadExts = exts.length > 0;
  return [
    '--headless=new',
    // `--headless=new` still creates real (hidden) top-level windows at the
    // screen's top-left. On some machines the compositor occasionally leaves a
    // visible black "phantom" of one of them on the desktop (observed live:
    // DWM residue at the exact rect of the hidden Edge window, cleared only by
    // a DWM restart). Park the windows far off-screen so even a mis-composited
    // frame can never land on a monitor. Rendering is unaffected — the
    // screencast draws the emulated viewport, not the OS window.
    '--window-position=-32000,-32000',
    // Parking every window off-screen (above) makes Chromium's occlusion
    // detection consider EVERY tile — even the one the user is actively watching
    // — hidden/occluded, so it backgrounds the renderer and throttles background
    // timers. A live HLS stream drives its segment/playlist fetches off those
    // timers, so ~5 min in the throttled fetch times out and the player dies with
    // `hls.networkError.levelLoadTimeOut` while the source is still online
    // (GitHub #116). These are the same flags Puppeteer/Playwright/Electron ship
    // by default; they keep the page running at full speed so a stream stays live.
    // CalculateNativeWinOcclusion (disabled in --disable-features below) is the
    // Windows-specific half — without it the off-screen window is still marked
    // occluded and rAF/decoding can stall regardless of the throttling flags.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    // Drop the "controlled by automation" blink flag so navigator.webdriver reads
    // false natively (some sites, e.g. Twitch login, block a webdriver browser as
    // "not supported"). The injected shim also spoofs it as a belt-and-suspenders.
    '--disable-blink-features=AutomationControlled',
    // Render on SwiftShader instead of the real GPU. `--headless=new` streams
    // all-black frames on many machines (older/hybrid GPU drivers, no active
    // session) — reported as a working address bar over a black tile. Software
    // rendering is plenty for a single small tile and renders correctly everywhere.
    '--disable-gpu',
    // NOTE: intentionally NOT `--mute-audio`. Web content should be audible, but
    // per-page (only the visible/active tab) — that gating is done in-page via the
    // AUDIO_SHIM, driven by startScreencast/stopScreencast, not by a global flag.
    // Keep the footprint minimal: a dashboard tile has no use for extensions,
    // background sync/networking, component updates or the crash reporter, each
    // of which is an extra msedge child process. Trimming them keeps one lean
    // browser (main + network + renderer) instead of a cluster of helpers.
    // EXCEPTION: when the user opts into the ad-blocker, we must NOT pass
    // --disable-extensions (it would also disable the --load-extension one) and
    // instead load the unpacked MV3 extension the user chose to install. This is
    // the only path that adds an extension process, and only on explicit opt-in.
    ...(loadExts ? ['--load-extension=' + exts.join(',')] : ['--disable-extensions']),
    '--disable-component-extensions-with-background-pages',
    '--disable-background-networking',
    // NOTE: do NOT add --disable-component-update here. It blocks Edge from
    // registering its bundled Widevine CDM, so DRM sites (Twitch, Netflix, Spotify
    // Web…) declare the tile an "unsupported browser" and refuse to work — even
    // though the UA/webdriver/brands all look like a normal Edge. Verified: with the
    // flag, requestMediaKeySystemAccess('com.widevine.alpha') is rejected and Twitch
    // shows its wall; without it, Widevine is supported and Twitch behaves.
    '--disable-sync',
    '--disable-default-apps',
    '--disable-breakpad',
    '--no-pings',
    // CalculateNativeWinOcclusion: see the anti-throttling block above — the
    // off-screen window must not be reported occluded, or the renderer stalls
    // (frozen rAF / paused media decode) even with the backgrounding flags set.
    '--disable-features=Translate,TranslateUI,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion',
    'about:blank',
  ];
}

// One spawn+port-read. Records the PID first so a later run can reap this exact
// Edge, and — critically — tree-kills its own process if the port never appears,
// so a failed attempt (e.g. it lost a race for a locked profile) can't itself
// become the next orphan.
async function spawnEdge(exe, profileDir, extensionDirs) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const proc = spawn(exe, edgeArgs(profileDir, extensionDirs), { windowsHide: true });
  proc.on('error', () => {});      // surfaced via the 'exit'/connect path
  if (proc.stderr) proc.stderr.on('data', () => {});
  if (proc.unref) proc.unref();
  try { fs.writeFileSync(pidFilePath(profileDir), String(proc.pid)); } catch (e) { /* ignore */ }
  try {
    const { port, wsPath } = await readDevToolsPort(portFile, 8000);
    return { proc, wsUrl: 'ws://127.0.0.1:' + port + wsPath };
  } catch (e) {
    killProcessTree(proc);         // don't leave the failed attempt running
    throw e;
  }
}

// Default real launcher. Self-heals a profile left locked by a previous run:
// first a precise reap of the Edge we recorded, then a spawn; if that still times
// out (something we didn't record is holding the lock) sweep any Edge bound to
// this profile and try once more.
async function defaultLaunch(profileDir, getExtensionDirs) {
  const exe = findEdge();
  if (!exe) throw new Error('edge_not_found');
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (e) { /* ignore */ }
  await reapStaleProfileEdge(profileDir);   // must run before the reset: it reads edge.pid inside the profile
  resetPoisonedProfile(profileDir);
  clearProfileLocks(profileDir);
  let extensionDirs = [];
  try { extensionDirs = (typeof getExtensionDirs === 'function' ? getExtensionDirs() : []) || []; }
  catch (e) { extensionDirs = []; }   // an extension resolver fault must never block the browser
  try {
    return await spawnEdge(exe, profileDir, extensionDirs);
  } catch (e) {
    if (!/devtools_port_timeout/.test(String(e && e.message))) throw e;
    await sweepProfileEdge(profileDir);
    clearProfileLocks(profileDir);
    return await spawnEdge(exe, profileDir, extensionDirs);
  }
}

module.exports = { readDevToolsPort, killProcessTree, edgeArgs, spawnEdge, defaultLaunch };
