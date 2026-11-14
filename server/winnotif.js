'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Windows notification mirror — owns the notifications-serve child process,
// the bounded feed buffer and the access-state flag.
//
// The child (native helper's `notifications-serve` mode when the exe exists,
// notifications.ps1 otherwise — same line protocol) polls the WinRT
// UserNotificationListener and emits status / seed / notification JSON lines.
// It is spawned ONLY while the feature is enabled AND a dashboard is open
// (server.js calls sync() from the SSE connect/close hooks and the settings
// save) — a closed dashboard or a disabled toggle keeps zero children and
// zero polling. Stopping also drops the buffered feed: notification text is
// private user data, so nothing lingers in memory while nobody is watching;
// the next start re-seeds from what's actually in Action Center.
//
// A helper exe that keeps dying young (corrupt download, AV block) is pinned
// out in favour of the PS fallback, like the game-detect probe.
// ─────────────────────────────────────────────────────────────────────────

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { lowerPriority } = require('./child-priority');

const RESTART_DELAY_MS = 5000;   // wait before relaunching after an exit
const FAIL_BACKOFF_MS = 60000;   // back off after repeated instant failures
const FEED_MAX = 30;

const PS_SCRIPT = path.join(__dirname, 'notifications.ps1');
const HELPER_EXE = path.join(__dirname, 'helper', 'xenon-helper.exe');

// Wired once by server.js via init(). isExcluded filters per-app mutes; onItem
// pushes one live notification; onFeed announces state/feed replacement.
let _isExcluded = () => false;
let _onItem = null;
let _onFeed = null;
let _onPresent = null;

const { notifWatch } = require('./notification-open/winnotif-state.js');
const {
  POLL_MS, _stopChild, setPace, getState, getFeed, isSupported, reportedState,
} = require('./notification-open/winnotif-control.js');

const { _project } = require('./notification-open/winnotif-shape.js');

notifWatch.pollMs = POLL_MS;

function init(deps) {
  if (deps && typeof deps.isExcluded === 'function') _isExcluded = deps.isExcluded;
  if (deps && typeof deps.onItem === 'function') _onItem = deps.onItem;
  if (deps && typeof deps.onFeed === 'function') _onFeed = deps.onFeed;
  if (deps && typeof deps.onPresent === 'function') _onPresent = deps.onPresent;
}

function _excluded(item) {
  try { return !!_isExcluded(item); } catch { return false; }
}

function _emitFeed() {
  if (_onFeed) { try { _onFeed(); } catch { /* listener errors never kill the watch */ } }
}

function _handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== 'object') return;

  if (msg.event === 'status') {
    const s = ['allowed', 'denied', 'unavailable'].includes(msg.status) ? msg.status : 'unavailable';
    if (s !== notifWatch.state) { notifWatch.state = s; _emitFeed(); }
  } else if (msg.event === 'seed') {
    // The child seeds with what's in Action Center right now (newest first).
    // Replace wholesale: correct for the first start, for a crash-restart and
    // for a dashboard-reopen alike — never a duplicate-merge problem.
    const items = Array.isArray(msg.items) ? msg.items : [];
    notifWatch.items = items.map(_project).filter(it => !_excluded(it)).slice(0, FEED_MAX);
    _emitFeed();
  } else if (msg.event === 'present') {
    // Which toasts are still in Action Center. Only the incoming-call card cares:
    // a ringing toast is transient, so its disappearance is the end of the ring.
    // The feed itself is deliberately NOT pruned by this — the Notifications tile
    // is a history of what arrived, not a mirror of what is still pending, and
    // making rows vanish as Windows expires them would be a different feature.
    if (!_onPresent) return;
    const ids = Array.isArray(msg.ids) ? msg.ids.filter(n => Number.isFinite(n)) : [];
    try { _onPresent(ids); } catch { /* listener errors never kill the watch */ }
  } else if (msg.event === 'notification') {
    const item = _project(msg.item);
    if (!item.app && !item.title && !item.body) return;   // no usable text → drop
    if (_excluded(item)) return;
    notifWatch.items.unshift(item);
    if (notifWatch.items.length > FEED_MAX) notifWatch.items.length = FEED_MAX;
    if (_onItem) { try { _onItem(item); } catch { /* ignore */ } }
  }
}

function _onData(chunk) {
  notifWatch.buffer += chunk;
  let nl;
  while ((nl = notifWatch.buffer.indexOf('\n')) >= 0) {
    const line = notifWatch.buffer.slice(0, nl).replace(/\r$/, '').trim();
    notifWatch.buffer = notifWatch.buffer.slice(nl + 1);
    if (!line) continue;
    notifWatch.consecutiveFastFails = 0; // receiving data → healthy
    _handleLine(line);
  }
}

// Linux speaks a different dialect: dbus-monitor prints message blocks, not
// JSON lines. Everything AFTER the child — the buffer, the exclusions, the cap,
// the privacy rules — is shared, so the translation happens here and feeds the
// same _handleLine the Windows children drive.
// Required unconditionally: it is a pure parser module with no side effects on
// load, and the dbus translation below is only ever DRIVEN on Linux (by the
// child's stdout), so loading it elsewhere costs nothing and lets the flush
// logic be tested off-platform.
const linuxNotif = require('./linux-notif');

// A parsed dbus-monitor block only becomes "complete" when the NEXT message's
// header arrives — but the match rule narrows the stream to Notify calls only,
// so on a quiet desktop the next message can be minutes away or never come.
// Holding the last block until then meant the most recent notification was
// invisible until another one fired. So the header-based split still handles
// the definitely-complete blocks, and an idle timer flushes the trailing one
// once it stops growing.
const LINUX_FLUSH_MS = 250;

function _emitNotifyBlock(block) {
  if (!linuxNotif.isNotifyCall(block)) return false;
  const item = linuxNotif.parseNotifyBlock(block);
  if (!item) return false;
  _handleLine(JSON.stringify({ event: 'notification', item }));
  return true;
}

// The buffer stopped growing: treat what is left as a whole block. Emit it only
// if it parses as a complete Notify — a genuinely mid-write tail returns null
// from the parser and is left for the next chunk to finish, so this never
// emits a partial. On success the buffer is cleared: the block is one whole
// message and the next notification opens with its own header, so clearing
// cannot drop or double anything.
function _flushLinuxTail() {
  notifWatch.linuxFlushTimer = null;
  if (!notifWatch.buffer || notifWatch.proc === null) return;
  if (_emitNotifyBlock(notifWatch.buffer)) notifWatch.buffer = '';
}

function _armLinuxFlush() {
  if (notifWatch.linuxFlushTimer) clearTimeout(notifWatch.linuxFlushTimer);
  notifWatch.linuxFlushTimer = setTimeout(_flushLinuxTail, LINUX_FLUSH_MS);
  if (typeof notifWatch.linuxFlushTimer.unref === 'function') notifWatch.linuxFlushTimer.unref();
}

function _onDbusData(chunk) {
  notifWatch.buffer += chunk;
  const blocks = linuxNotif.splitBlocks(notifWatch.buffer);
  // The last block may still be arriving, so it is left in the buffer until the
  // next header proves it complete — or the idle flush below does.
  const complete = blocks.slice(0, -1);
  notifWatch.buffer = blocks.length ? blocks[blocks.length - 1] : '';
  for (const block of complete) {
    notifWatch.consecutiveFastFails = 0;                      // receiving data → healthy
    _emitNotifyBlock(block);
  }
  // Re-arm on every chunk: while data keeps arriving the tail is still growing,
  // and only the last chunk's timer actually fires.
  if (notifWatch.buffer) _armLinuxFlush();
}

function _startLinux(startedAt) {
  const bin = linuxNotif.findDbusMonitor();
  if (!bin) {
    // No dbus-monitor: report it and do NOT schedule a retry. Nothing about a
    // missing package changes on a timer, and the tile says "unavailable"
    // rather than spinning.
    _handleLine(JSON.stringify({ event: 'status', status: 'unavailable' }));
    return;
  }
  let child;
  try {
    child = spawn(bin, linuxNotif.MONITOR_ARGS);
  } catch {
    notifWatch.proc = null;
    _scheduleRestart(startedAt);
    return;
  }
  notifWatch.proc = child;
  // The session bus is the user's own, so there is no permission gate to wait
  // for: if the monitor started, it is watching.
  _handleLine(JSON.stringify({ event: 'status', status: 'allowed' }));
  child.stdout.on('data', (d) => { if (notifWatch.proc === child) _onDbusData(d.toString('utf8')); });
  child.stderr.on('data', () => { /* match-rule warnings; ignore */ });
  const onGone = () => { if (notifWatch.proc === child) { notifWatch.proc = null; _scheduleRestart(startedAt); } };
  child.on('error', onGone);
  child.on('close', onGone);
}

function _start() {
  if (notifWatch.stopped) return;
  if (process.platform !== 'win32' && process.platform !== 'linux') return;
  if (notifWatch.restartTimer) { clearTimeout(notifWatch.restartTimer); notifWatch.restartTimer = null; }
  notifWatch.buffer = '';
  notifWatch.state = 'starting';
  const startedAt = Date.now();
  if (process.platform === 'linux') { _startLinux(startedAt); return; }
  let useHelper = false;
  if (!notifWatch.helperDisabled) {
    try { useHelper = fs.existsSync(HELPER_EXE); } catch { useHelper = false; }
  }
  notifWatch.lastSpawnWasHelper = useHelper;
  let child;
  try {
    child = useHelper
      ? spawn(HELPER_EXE, ['notifications-serve', String(notifWatch.pollMs)], { windowsHide: true })
      : spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', PS_SCRIPT, '-IntervalMs', String(POLL_MS),
        ], { windowsHide: true });
  } catch {
    notifWatch.proc = null;
    _scheduleRestart(startedAt);
    return;
  }
  notifWatch.proc = child;
  lowerPriority(child.pid);
  // Every handler checks identity against the child it was registered on: a
  // stop→start bounce (dashboard reload while the old child's async close is
  // still queued) would otherwise null out — and leave orphaned + duplicated —
  // the replacement listener. Mirrors wakeword.js.
  child.stdout.on('data', d => { if (notifWatch.proc === child) _onData(d.toString('utf8')); });
  child.stderr.on('data', () => { /* probe warnings; ignore */ });
  // setPace() writes here: a pipe that breaks raises 'error' on the stream, and an
  // unhandled one takes the server down. 'close' below is what handles the exit.
  child.stdin.on('error', () => {});
  const onGone = () => { if (notifWatch.proc === child) { notifWatch.proc = null; _scheduleRestart(startedAt); } };
  child.on('error', onGone);
  child.on('close', onGone);
}

function _scheduleRestart(startedAt) {
  if (notifWatch.stopped || !notifWatch.wanted) return;   // deliberate stop — not a crash
  if (Date.now() - startedAt < 2500) notifWatch.consecutiveFastFails++; else notifWatch.consecutiveFastFails = 0;
  if (notifWatch.consecutiveFastFails >= 3 && notifWatch.lastSpawnWasHelper && !notifWatch.helperDisabled) {
    notifWatch.helperDisabled = true;           // broken exe → pin the PS fallback
    notifWatch.consecutiveFastFails = 0;
  }
  const delay = notifWatch.consecutiveFastFails >= 3 ? FAIL_BACKOFF_MS : RESTART_DELAY_MS;
  if (notifWatch.restartTimer) clearTimeout(notifWatch.restartTimer);
  notifWatch.restartTimer = setTimeout(_start, delay);
}

// Reconcile the child with the desired state. server.js computes `want` as
// (feature enabled && SSE clients > 0) and calls this from every trigger.
function sync(want) {
  // Gate on the reader that exists, not on Windows: the Linux child is spawned
  // from _start() too, and gating this on win32 left _startLinux unreachable —
  // the whole dbus path was dead code, since notifWatch.wanted could never be true there.
  notifWatch.wanted = !!want && isSupported();
  if (notifWatch.wanted && !notifWatch.proc && !notifWatch.restartTimer && !notifWatch.stopped) _start();
  // 'unavailable' is terminal: no child, no timer, nothing to tear down. Treat
  // it like 'off' here or every sync() re-runs _stopChild() and re-announces a
  // state that did not change (sync fires on each SSE connect/close and save).
  else if (!notifWatch.wanted && (notifWatch.proc || notifWatch.restartTimer || notifWatch.items.length || (notifWatch.state !== 'off' && notifWatch.state !== 'unavailable'))) {
    _stopChild();
    _emitFeed();
  }
}

// Re-filter the stored feed after the excluded-apps list changed; announces
// only when something was actually dropped.
function applyExclusions() {
  const before = notifWatch.items.length;
  notifWatch.items = notifWatch.items.filter(it => !_excluded(it));
  if (notifWatch.items.length !== before) _emitFeed();
}

function stop() {
  notifWatch.stopped = true;
  notifWatch.wanted = false;
  _stopChild();
}

module.exports = {
  init, sync, setPace, applyExclusions, getState, getFeed, stop,
  isSupported, reportedState,
  // Test hook: the exact line handler the child reader drives, so the
  // seed/push/filter/cap behaviour is testable without spawning a process.
  _handleLine,
  // Test hooks for the Linux dbus path: drive raw dbus-monitor output through
  // the same split/hold/flush the child's stdout feeds, and trigger the idle
  // flush directly so the "last block delivered without waiting for the next"
  // fix is testable without real timers or a live bus.
  _onDbusData, _flushLinuxTail,
  _setProcForTest: (v, helper = false) => { notifWatch.proc = v; notifWatch.lastSpawnWasHelper = helper; },
};
