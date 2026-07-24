'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// linux-notif.js — desktop notifications on Linux, in the protocol winnotif.js
// already speaks.
//
// winnotif.js owns the feed: the bounded buffer, the exclusions, the cap, the
// privacy rule that drops everything when no dashboard is watching. All of that
// is platform-agnostic already; the only Windows-specific part is the child it
// spawns. So this is not a second notification system, it is a second child —
// one that emits the same `{"event":"notification","item":{…}}` lines the
// helper's notifications-serve mode does.
//
// The source is the freedesktop Notifications spec: every notification on a
// Linux desktop is a `Notify` method call on the session bus, so watching that
// bus sees all of them, from any app, with no per-app integration. dbus-monitor
// is the shim — the same role wpctl, wmctrl and playerctl play elsewhere here.
//
// PRIVACY. This reads the text of every notification the user receives, which is
// as sensitive as data in this project gets. It inherits the rules that already
// govern the Windows mirror rather than inventing its own: the child runs ONLY
// while the feature is enabled AND a dashboard is open, the buffer is dropped
// when it stops, nothing is written to disk, and nothing leaves the machine.
// ─────────────────────────────────────────────────────────────────────────────

// The org.freedesktop.Notifications.Notify signature, in order:
//   app_name(s) replaces_id(u) app_icon(s) summary(s) body(s)
//   actions(as) hints(a{sv}) expire_timeout(i)
// So the first four top-level strings are app_name, app_icon, summary, body —
// and every later string lives inside the actions array or the hints dict,
// which is why counting the first four is enough and reading further is not.
const STRING_LINE = /^\s*string\s+"((?:[^"\\]|\\.)*)"\s*$/;

function unescapeDbus(s) {
  return String(s).replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

// One dbus-monitor block into the item shape winnotif.js projects. Returns null
// when the block is not a usable notification, which includes the ones with no
// text at all: an app that notifies with only an icon has nothing to show.
function parseNotifyBlock(block) {
  const lines = String(block || '').split(/\r?\n/);
  const strings = [];
  for (const line of lines) {
    const m = STRING_LINE.exec(line);
    // A body containing a newline arrives as an unterminated line and simply
    // does not match. Dropping the value is right: the alternative is stitching
    // lines together by guesswork and attributing text to the wrong field.
    if (m) strings.push(unescapeDbus(m[1]));
    if (strings.length >= 4) break;
  }
  if (strings.length < 4) return null;
  const [app, , summary, body] = strings;
  const item = {
    app: (app || '').trim(),
    // There is no AUMID on Linux; the app name is the only identity the spec
    // gives, and the exclusion list matches on it either way.
    aumid: '',
    title: (summary || '').trim(),
    body: (body || '').trim(),
    at: Date.now(),
    // The spec's app_icon is a themed icon NAME or a file path, never image
    // data — and winnotif's projection only accepts a data: URI, so sending
    // either would be dropped downstream anyway.
    icon: null,
  };
  if (!item.app && !item.title && !item.body) return null;
  return item;
}

// dbus-monitor prints one block per message, each starting with a header line.
// Splitting on that header rather than on blank lines is what keeps a
// multi-line body inside its own block.
const BLOCK_START = /^(method call|signal|method return|error)\b/;

function splitBlocks(text) {
  const out = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (BLOCK_START.test(line)) {
      if (current) out.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) out.push(current.join('\n'));
  return out;
}

// Only a Notify call is a notification. A GetCapabilities call or the
// NotificationClosed signal share the bus and must not become feed items.
function isNotifyCall(block) {
  return /^method call\b/.test(String(block || '')) && /member=Notify\b/.test(String(block || ''));
}

// The argv for the watcher. `--session` is the user's own bus, and the match
// rule narrows it to the one member we want, so the monitor is not handed every
// message on the desktop to filter in JavaScript.
const MONITOR_ARGS = [
  '--session',
  "interface='org.freedesktop.Notifications',member='Notify'",
];


// Locate dbus-monitor without spawning anything. Absolute paths first, then a
// PATH walk — the same shape linux-media.js uses to find playerctl.
function findDbusMonitor() {
  const fs = require('fs');
  const path = require('path');
  for (const p of ['/usr/bin/dbus-monitor', '/bin/dbus-monitor']) {
    try { if (fs.existsSync(p)) return p; } catch { /* unreadable */ }
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'dbus-monitor');
    try { if (fs.existsSync(p)) return p; } catch { /* unreadable */ }
  }
  return null;
}

module.exports = { parseNotifyBlock, splitBlocks, isNotifyCall, unescapeDbus, findDbusMonitor, MONITOR_ARGS, STRING_LINE };
