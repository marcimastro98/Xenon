// Opening a Deck in a window of its own.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { PORT } = require('../engine/port.js');
const { DATA_DIR } = require('../engine/paths.js');
const { runPowerShellScript } = require('../powershell/run-command.js');
const { _deckPopupPids } = require('./popup-pids.js');
const { DECK_POPUP_TOP_SCRIPT } = require('./script-paths.js');

// Open the Virtual Deck as an Edge app-mode window on the main PC. Argv array
// only; the instance id is charset-validated before it enters the URL. Edge's
// dedicated profile dir remembers the window's size/position across launches,
// so no geometry needs persisting. The child is tracked and closed in
// _gracefulShutdown (stop-what-you-start). Shared by POST /deck/popup/open and
// the AI's open_virtual_deck tool.
function openDeckPopupWindow(instanceRaw, topmost) {
  const instRaw = String(instanceRaw || '').trim();
  const instance = /^deck(~[a-z0-9]+)?$/.test(instRaw) ? instRaw : '';
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
    .find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!edge) return { ok: false, error: 'edge_not_found' };
  const url = 'http://127.0.0.1:' + PORT + '/deck-popup' + (instance ? '?instance=' + encodeURIComponent(instance) : '');
  const args = [
    '--app=' + url,
    '--user-data-dir=' + path.join(DATA_DIR, 'deck-popup-profile'),
    '--no-first-run', '--no-default-browser-check',
    '--window-size=460,560',
  ];
  let popupPid = 0;
  try {
    const child = spawn(edge, args, { detached: true, stdio: 'ignore' });
    child.unref();
    popupPid = child.pid || 0;
    _deckPopupPids.add(child.pid);
    child.on('exit', () => _deckPopupPids.delete(child.pid));
  } catch { return { ok: false, error: 'popup_failed' }; }
  if (topmost !== false) {
    // One-shot: after the window settles, pin it above other windows. No loop,
    // no lingering process — the script exits after one SetWindowPos. The pin
    // targets the spawned PID (exact title + msedge.exe is only the fallback),
    // so a browser tab that merely CONTAINS "Xenon Deck" can never be pinned.
    setTimeout(() => {
      try { runPowerShellScript(DECK_POPUP_TOP_SCRIPT, ['-ProcessId', String(popupPid), '-Title', 'Xenon Deck'], 8000).catch(() => {}); }
      catch { /* best-effort */ }
    }, 1800).unref();
  }
  return { ok: true };
}

module.exports = { openDeckPopupWindow };
