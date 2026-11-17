// Opening the search window, and what the search shortcut does.

const { spawn } = require('node:child_process');
const path = require('node:path');
const { POWERSHELL_SUPPORTED } = require('../powershell/supported.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const { findEdge } = require('../windows-tiles/embedded-browser.js');
const { PORT } = require('../engine/port.js');
const { DATA_DIR } = require('../engine/paths.js');
const { _spotlightPopupPids } = require('./spotlight-state.js');
const { runPowerShellScript } = require('../powershell/run-command.js');
const { createSpotlightClaim } = require('../spotlight-hotkey/claim.js');
const { DECK_POPUP_TOP_SCRIPT } = require('../deck/script-paths.js');

function openSpotlightPopupWindow() {
  // Reuse: alive popup → just re-pin it topmost (brings it above); else spawn.
  for (const pid of _spotlightPopupPids) {
    try {
      process.kill(pid, 0); // liveness probe only
      // Raising a window is a Win32 call. Elsewhere the browser's own
      // activate-on-reuse is all there is, and a popup that is already open
      // simply stays where the window manager put it.
      if (POWERSHELL_SUPPORTED) {
        runPowerShellScript(DECK_POPUP_TOP_SCRIPT, ['-ProcessId', String(pid), '-Title', 'Xenon Search'], 8000).catch(() => {});
      }
      return { ok: true };
    } catch { _spotlightPopupPids.delete(pid); }
  }
  // The same Chromium the embedded-browser tile drives — one detector for both,
  // so a machine that can show a web tile can also show the Spotlight popup.
  // The hardcoded Program Files pair only ever existed because this path was
  // Windows-only; findEdge covers those two and every Linux/macOS install.
  const edge = findEdge();
  if (!edge) return { ok: false, error: 'edge_not_found' };
  const args = [
    '--app=http://127.0.0.1:' + PORT + '/spotlight',
    '--user-data-dir=' + path.join(DATA_DIR, 'spotlight-popup-profile'),
    '--no-first-run', '--no-default-browser-check',
    '--window-size=760,540',
  ];
  let pid = 0;
  try {
    const child = spawn(edge, args, { detached: true, stdio: 'ignore' });
    child.unref();
    pid = child.pid || 0;
    _spotlightPopupPids.add(child.pid);
    child.on('exit', () => _spotlightPopupPids.delete(child.pid));
  } catch { return { ok: false, error: 'popup_failed' }; }
  if (POWERSHELL_SUPPORTED) {
    setTimeout(() => {
      try { runPowerShellScript(DECK_POPUP_TOP_SCRIPT, ['-ProcessId', String(pid), '-Title', 'Xenon Search'], 8000).catch(() => {}); }
      catch { /* best-effort */ }
    }, 1500).unref();
  }
  return { ok: true };
}

// Native first, the Edge popup when no native window claims it (spotlight-hotkey/claim.js).
const spotlightClaim = createSpotlightClaim({
  broadcast: () => broadcastSSE('spotlight_hotkey', { at: Date.now() }),
  openFallback: () => { try { openSpotlightPopupWindow(); } catch { /* best-effort */ } },
});
function routeSpotlightHotkey() { spotlightClaim.route(); }

module.exports = { openSpotlightPopupWindow, routeSpotlightHotkey, spotlightClaim };
