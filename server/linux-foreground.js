'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// linux-foreground.js — the foreground-window probe gamedetect.js runs on.
//
// gamedetect.js decides "a game owns the screen" from a stream of
// {fullscreen, process, pid} samples. On Windows those come from foreground.ps1
// (or the native helper); there is neither here, and gamedetect's start() bails
// out on non-Windows without a helper — so on Linux game mode, Performance
// Mode's activity classification, the Game Companion pill and the screen-time
// app breakdown were all permanently inert. This is that missing probe.
//
// Three backends, picked by what the session actually offers:
//
//   • Hyprland / sway — their own IPC, which reports the focused window
//     directly. Exact, and the only honest option on wlroots.
//   • X11 *and* Xwayland — _NET_ACTIVE_WINDOW plus a property read. Note the
//     second half: under a Wayland session Xwayland still maintains the EWMH
//     properties for X11 clients, and games are almost always X11 clients
//     (Proton and Wine render through Xwayland; SDL2 still defaults to the X11
//     video driver). So this path keeps working on GNOME/KDE Wayland for
//     exactly the applications game mode cares about.
//
// What it deliberately does NOT do is guess. Under a Wayland session whose
// focused window is a native Wayland client, _NET_ACTIVE_WINDOW points at
// Xwayland's internal focus-proxy window, which owns none of the properties
// below. That reads as "some window we cannot see has focus" — reported as not
// full-screen with no process — and never as "the last X11 window we saw".
// Reporting a stale window would pin game mode on after the game exits, which
// is worse than admitting the session is opaque.
//
// Only xprop is required, from x11-utils — no wmctrl, no xdotool. Those two are
// needed to *act* on a window (focus/close); reading the foreground is a
// property fetch and should not cost the user an install.
// ─────────────────────────────────────────────────────────────────────────────

const { execFile } = require('child_process');
const fs = require('fs');

const DEFAULT_INTERVAL_MS = 2000;
const CMD_TIMEOUT_MS = 3000;

// ── pure parsers (exported for tests) ───────────────────────────────────────

// `_NET_ACTIVE_WINDOW(WINDOW): window id # 0x4200003`. A zero id means "no
// window is focused", which the spec allows and which must not become 0x0.
function parseActiveWindowId(raw) {
  const s = String(raw || '');
  // The "window id #" wording is how xprop renders a WINDOW-typed property,
  // which is what the spec requires here. The bare `= 0x…` form is accepted too
  // because xprop falls back to it whenever it does not know the property's
  // format — including on a root window whose property some tool rewrote.
  const m = s.match(/window id # (0x[0-9a-fA-F]+)/) || s.match(/=\s*(0x[0-9a-fA-F]+)\s*$/m);
  if (!m) return null;
  const dec = parseInt(m[1], 16);
  return Number.isFinite(dec) && dec > 0 ? m[1].toLowerCase() : null;
}

// The window ids in _NET_CLIENT_LIST, normalised the same way, so a caller can
// tell a real X11 client from Xwayland's focus proxy.
function parseClientList(raw) {
  const m = String(raw || '').match(/window id # (.*)$/m);
  if (!m) return [];
  return m[1].split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]+$/.test(s));
}

// One `xprop -id <id> WM_CLASS _NET_WM_PID _NET_WM_STATE` reply.
//
// WM_CLASS is "instance", "Class"; the INSTANCE is the one that matches a
// binary name (steam's is "steam", Firefox's is "firefox"), which is what
// gamedetect's ignore list is written against — the Class is a display name
// ("Firefox", "Xenon-native"). The exe basename is better still and is
// preferred by the caller when /proc grants it.
function parseWindowInfo(raw) {
  // xprop answers "PROPERTY:  not found." per missing property rather than
  // failing, so a window owning none of them parses to nothing — which is the
  // correct reading of Xwayland's focus proxy.
  const s = String(raw || '');
  let instance = '';
  const cls = s.match(/WM_CLASS\(STRING\)\s*=\s*"([^"]*)"(?:\s*,\s*"([^"]*)")?/);
  if (cls) instance = cls[1] || cls[2] || '';
  const pidM = s.match(/_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)/);
  const pid = pidM ? Number(pidM[1]) : 0;
  const fullscreen = /_NET_WM_STATE_FULLSCREEN/.test(s);
  if (!instance && !pid) return null;
  return { process: instance.toLowerCase(), pid, fullscreen };
}

// `hyprctl activewindow -j`. `fullscreen` is an enum in current Hyprland
// (0 none, 1 maximized, 2 fullscreen) and was a boolean in older ones; both
// shapes have to read correctly or the probe silently reports "windowed"
// forever on whichever version it did not expect.
function parseHyprctl(raw) {
  let j;
  try { j = JSON.parse(String(raw || '')); } catch { return null; }
  if (!j || typeof j !== 'object' || !j.class) return null;
  const fs_ = j.fullscreen;
  const fullscreen = fs_ === true || (typeof fs_ === 'number' && fs_ >= 2);
  return {
    process: String(j.class || '').toLowerCase(),
    pid: Number(j.pid) || 0,
    fullscreen: !!fullscreen,
  };
}

// `swaymsg -t get_tree`: walk to the node carrying focused:true. `app_id` is
// the Wayland name, `window_properties.instance` the Xwayland one.
function findFocusedSwayNode(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.focused === true && node.type !== 'workspace' && node.type !== 'root') return node;
  for (const key of ['nodes', 'floating_nodes']) {
    const kids = Array.isArray(node[key]) ? node[key] : [];
    for (const kid of kids) {
      const hit = findFocusedSwayNode(kid);
      if (hit) return hit;
    }
  }
  return null;
}

function parseSwayTree(raw) {
  let tree;
  try { tree = JSON.parse(String(raw || '')); } catch { return null; }
  const n = findFocusedSwayNode(tree);
  if (!n) return null;
  const name = n.app_id || (n.window_properties && n.window_properties.instance) || '';
  if (!name) return null;
  return {
    process: String(name).toLowerCase(),
    pid: Number(n.pid) || 0,
    fullscreen: n.fullscreen_mode === 1 || n.fullscreen_mode === 2 || n.fullscreen === true,
  };
}

// ── runtime ─────────────────────────────────────────────────────────────────

// The server can be started by systemd --user without a session environment,
// so DISPLAY may be unset even though an X server is right there.
function xEnv() {
  const env = { ...process.env };
  if (!env.DISPLAY) env.DISPLAY = ':0';
  return env;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    let p;
    try {
      p = execFile(cmd, args, { timeout: CMD_TIMEOUT_MS, env: xEnv(), windowsHide: true },
        (err, stdout) => resolve(err ? null : String(stdout || '')));
    } catch {
      resolve(null);
      return;
    }
    p.on('error', () => resolve(null));
  });
}

// The binary name behind a pid. Preferred over WM_CLASS: it is what the
// Windows probe reports, so one ignore list covers both platforms.
function exeName(pid) {
  if (!pid) return '';
  try {
    const exe = fs.readlinkSync(`/proc/${pid}/exe`);
    return (exe.split('/').filter(Boolean).pop() || '').toLowerCase();
  } catch {
    return '';
  }
}

async function sampleHyprland() {
  const out = await run('hyprctl', ['activewindow', '-j']);
  return out === null ? null : parseHyprctl(out);
}

async function sampleSway() {
  const out = await run('swaymsg', ['-t', 'get_tree']);
  return out === null ? null : parseSwayTree(out);
}

async function sampleX11() {
  const active = parseActiveWindowId(await run('xprop', ['-root', '_NET_ACTIVE_WINDOW']));
  if (!active) return { process: '', pid: 0, fullscreen: false };
  // Xwayland's focus proxy is not in _NET_CLIENT_LIST. Checking membership is
  // what distinguishes "a Wayland-native window has focus" (opaque, correctly
  // reported as nothing) from "an X11 window has focus" (readable).
  const list = parseClientList(await run('xprop', ['-root', '_NET_CLIENT_LIST']));
  if (list.length && !list.includes(active)) return { process: '', pid: 0, fullscreen: false };
  const info = parseWindowInfo(
    await run('xprop', ['-id', active, 'WM_CLASS', '_NET_WM_PID', '_NET_WM_STATE']));
  if (!info) return { process: '', pid: 0, fullscreen: false };
  return { ...info, process: exeName(info.pid) || info.process };
}

// Which backend this session can answer with, resolved once per start().
function pickBackend() {
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) return sampleHyprland;
  if (process.env.SWAYSOCK) return sampleSway;
  return sampleX11;
}

// A probe with the same contract as the spawned Windows one: it calls back with
// a sample object every intervalMs until stop(). In-process rather than a child
// emitting JSON lines, because there is no script to spawn — the work is three
// xprop reads, and a Node interval is cheaper and easier to shut down cleanly
// than a shell loop.
function createLinuxForeground(o = {}) {
  const intervalMs = Number(o.intervalMs) > 0 ? Number(o.intervalMs) : DEFAULT_INTERVAL_MS;
  const backend = typeof o.backend === 'function' ? o.backend : pickBackend();
  const onSample = typeof o.onSample === 'function' ? o.onSample : () => {};
  let timer = null;
  let inFlight = false;
  let stopped = false;

  async function tick() {
    // A slow xprop (an X server mid-VT-switch) must not queue up probes.
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const s = await backend();
      if (!stopped && s) {
        onSample({
          fullscreen: s.fullscreen === true,
          process: String(s.process || ''),
          pid: Number(s.pid) || 0,
        });
      }
    } catch { /* a probe failure is "unknown", not a crash */ }
    inFlight = false;
  }

  return {
    start() {
      if (timer || stopped) return;
      tick();
      timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

module.exports = {
  createLinuxForeground,
  parseActiveWindowId,
  parseClientList,
  parseWindowInfo,
  parseHyprctl,
  parseSwayTree,
  findFocusedSwayNode,
};
