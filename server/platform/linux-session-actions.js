'use strict';
// What Xenon does to the Linux session when asked: lock it, send keys, show the desktop, raise
// a notification.

const { run } = require('./linux-read.js');
const { held } = require('./linux-held.js');
const { runX } = require('./linux-windows.js');
const { ydotoolArgs } = require('./linux-keys.js');
const { linuxSession, pickHideTool } = require('./linux-hide-tool.js');

// Lock the screen now — the Deck's lockWorkstation key. loginctl asks the
// session's own locker, which is why it is the one call that works under both
// X11 and Wayland where the screensaver D-Bus names do not.
async function lock() {
  await run('loginctl', ['lock-session'], 5000);
}

// Which sender this session has, if any. Cached: it is read on the path that
// decides whether to draw an Answer button, and neither tool appears or
// disappears while the server runs.
async function keysTool() {
  if (held.keysProbe !== null) return held.keysProbe;
  const wayland = !!(process.env.WAYLAND_DISPLAY || String(process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland');
  const probe = async (bin, args) => {
    try { await run(bin, args, 3000); return true; } catch { return false; }
  };
  // Under Wayland xdotool may well be installed and still deliver nothing, so
  // it is not even tried there — offering a button that silently fails is the
  // failure this whole feature is written to avoid.
  if (!wayland && await probe('xdotool', ['--version'])) held.keysProbe = 'xdotool';
  else if (await probe('ydotool', ['--help'])) held.keysProbe = 'ydotool';
  else held.keysProbe = '';
  return held.keysProbe;
}

async function keysAvailable() { return !!(await keysTool()); }

async function sendKeys(combo) {
  const tool = await keysTool();
  if (!tool) return { ok: false, error: 'no_key_tool' };
  if (tool === 'xdotool') {
    // --clearmodifiers so a modifier the user is physically holding does not
    // combine into a different shortcut than the one requested.
    try { await run('xdotool', ['key', '--clearmodifiers', String(combo)], 5000); return { ok: true }; }
    catch { return { ok: false, error: 'xdotool_failed' }; }
  }
  const args = ydotoolArgs(combo);
  if (!args) return { ok: false, error: 'bad_combo' };
  try { await run('ydotool', ['key', ...args], 5000); return { ok: true }; }
  catch { return { ok: false, error: 'ydotool_failed' }; }
}

// Why it cannot, when it cannot: 'wayland' (no desktop API) or 'needs_wmctrl'.
async function hideWindowsTool() {
  if (held.hideProbe) return held.hideProbe;
  const session = linuxSession();
  const answers = async (bin, args) => {
    try { await run(bin, args, 3000); return true; } catch { return false; }
  };
  const has = {
    wmctrl: !session.wayland && await answers('wmctrl', ['-m']),
    dbusSend: session.kde && await answers('dbus-send', ['--version']),
  };
  const tool = pickHideTool(session, has);
  held.hideProbe = { tool, reason: tool ? '' : (session.wayland ? 'wayland' : 'needs_wmctrl') };
  return held.hideProbe;
}

async function hideWindows() {
  const { tool, reason } = await hideWindowsTool();
  if (tool === 'wmctrl') {
    if (await runX('wmctrl', ['-k', 'on'], 5000) === null) throw new Error('wmctrl_failed');
    return;
  }
  if (tool === 'kwin') {
    await run('dbus-send', ['--session', '--type=method_call', '--dest=org.kde.kglobalaccel', '/component/kwin',
      'org.kde.kglobalaccel.Component.invokeShortcut', 'string:Show Desktop'], 5000);
    return;
  }
  const err = new Error(reason);
  err.code = reason;
  throw err;
}

// A desktop notification: the fallback for Bit's popup when no Xenon app window
// can draw it. notify-send is libnotify's, on every common desktop.
async function notify(title, text) {
  await run('notify-send', ['--app-name=Xenon', '--', String(title), String(text)], 5000);
}

module.exports = { lock, keysTool, keysAvailable, sendKeys, hideWindowsTool, hideWindows, notify };
