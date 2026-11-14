'use strict';
// Which desktop session a Linux machine runs and which tool can hide its windows there.

// --- Showing the desktop: Bit's "I'll hide your windows" (vitals-nag.js) -----
// X11 has a standard for it: _NET_SHOWING_DESKTOP, which `wmctrl -k on` sets on
// every EWMH window manager (GNOME, KDE, Xfce, Cinnamon, MATE…). Wayland has no
// protocol for one app to hide the others; KDE's KWin still answers its own
// global shortcut over D-Bus ("Show Desktop", Meta+D, src/useractions.cpp), so
// Plasma works there too. GNOME on Wayland exposes nothing an app may call, so
// it is the one desktop where this is not possible.
function linuxSession(env = process.env) {
  const wayland = !!(env.WAYLAND_DISPLAY || String(env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland');
  const desktop = String(env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || '').toLowerCase();
  return { wayland, kde: /kde|plasma/.test(desktop) };
}

// → 'wmctrl' | 'kwin' | '' (cannot here), given which tools answer.
function pickHideTool(session, has) {
  if (!session.wayland && has.wmctrl) return 'wmctrl';
  if (session.kde && has.dbusSend) return 'kwin';
  return '';
}

module.exports = { linuxSession, pickHideTool };
