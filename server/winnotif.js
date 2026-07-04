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

const POLL_MS = 2000;            // child polling cadence
const RESTART_DELAY_MS = 5000;   // wait before relaunching after an exit
const FAIL_BACKOFF_MS = 60000;   // back off after repeated instant failures
const FEED_MAX = 30;
const TEXT_MAX = 200;
const BODY_MAX = 400;
const ICON_MAX = 128 * 1024;     // data: URI cap (helper caps the raw logo lower)

const PS_SCRIPT = path.join(__dirname, 'notifications.ps1');
const HELPER_EXE = path.join(__dirname, 'helper', 'xenon-helper.exe');

// Wired once by server.js via init(). isExcluded filters per-app mutes; onItem
// pushes one live notification; onFeed announces state/feed replacement.
let _isExcluded = () => false;
let _onItem = null;
let _onFeed = null;

let _proc = null;
let _wanted = false;             // desired state from the last sync()
let _stopped = false;            // process shutdown — never restart after
let _buffer = '';
let _restartTimer = null;
let _consecutiveFastFails = 0;
let _helperDisabled = false;
let _lastSpawnWasHelper = false;

let _state = 'off';              // 'off'|'starting'|'allowed'|'denied'|'unavailable'
let _seq = 0;
let _items = [];                 // newest first, capped at FEED_MAX

function init(deps) {
  if (deps && typeof deps.isExcluded === 'function') _isExcluded = deps.isExcluded;
  if (deps && typeof deps.onItem === 'function') _onItem = deps.onItem;
  if (deps && typeof deps.onFeed === 'function') _onFeed = deps.onFeed;
}

// Server-side re-projection at the trust boundary: known keys only, length
// caps, server-assigned monotonic id (child ids reset per session, so they
// are unusable as feed keys). Anything malformed collapses to a safe shape.
function _project(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const icon = typeof r.icon === 'string' && r.icon.startsWith('data:image/') && r.icon.length <= ICON_MAX
    ? r.icon : null;
  return {
    id: ++_seq,
    app: String(r.app || '').slice(0, TEXT_MAX),
    aumid: String(r.aumid || '').slice(0, TEXT_MAX),
    title: String(r.title || '').slice(0, TEXT_MAX),
    body: String(r.body || '').slice(0, BODY_MAX),
    at: Number.isFinite(r.at) && r.at > 0 ? Math.floor(r.at) : Date.now(),
    icon,
  };
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
    if (s !== _state) { _state = s; _emitFeed(); }
  } else if (msg.event === 'seed') {
    // The child seeds with what's in Action Center right now (newest first).
    // Replace wholesale: correct for the first start, for a crash-restart and
    // for a dashboard-reopen alike — never a duplicate-merge problem.
    const items = Array.isArray(msg.items) ? msg.items : [];
    _items = items.map(_project).filter(it => !_excluded(it)).slice(0, FEED_MAX);
    _emitFeed();
  } else if (msg.event === 'notification') {
    const item = _project(msg.item);
    if (!item.app && !item.title && !item.body) return;   // no usable text → drop
    if (_excluded(item)) return;
    _items.unshift(item);
    if (_items.length > FEED_MAX) _items.length = FEED_MAX;
    if (_onItem) { try { _onItem(item); } catch { /* ignore */ } }
  }
}

function _onData(chunk) {
  _buffer += chunk;
  let nl;
  while ((nl = _buffer.indexOf('\n')) >= 0) {
    const line = _buffer.slice(0, nl).replace(/\r$/, '').trim();
    _buffer = _buffer.slice(nl + 1);
    if (!line) continue;
    _consecutiveFastFails = 0; // receiving data → healthy
    _handleLine(line);
  }
}

function _start() {
  if (_stopped || process.platform !== 'win32') return;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  _buffer = '';
  _state = 'starting';
  const startedAt = Date.now();
  let useHelper = false;
  if (!_helperDisabled) {
    try { useHelper = fs.existsSync(HELPER_EXE); } catch { useHelper = false; }
  }
  _lastSpawnWasHelper = useHelper;
  let child;
  try {
    child = useHelper
      ? spawn(HELPER_EXE, ['notifications-serve', String(POLL_MS)], { windowsHide: true })
      : spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', PS_SCRIPT, '-IntervalMs', String(POLL_MS),
        ], { windowsHide: true });
  } catch {
    _proc = null;
    _scheduleRestart(startedAt);
    return;
  }
  _proc = child;
  // Every handler checks identity against the child it was registered on: a
  // stop→start bounce (dashboard reload while the old child's async close is
  // still queued) would otherwise null out — and leave orphaned + duplicated —
  // the replacement listener. Mirrors wakeword.js.
  child.stdout.on('data', d => { if (_proc === child) _onData(d.toString('utf8')); });
  child.stderr.on('data', () => { /* probe warnings; ignore */ });
  const onGone = () => { if (_proc === child) { _proc = null; _scheduleRestart(startedAt); } };
  child.on('error', onGone);
  child.on('close', onGone);
}

function _scheduleRestart(startedAt) {
  if (_stopped || !_wanted) return;   // deliberate stop — not a crash
  if (Date.now() - startedAt < 2500) _consecutiveFastFails++; else _consecutiveFastFails = 0;
  if (_consecutiveFastFails >= 3 && _lastSpawnWasHelper && !_helperDisabled) {
    _helperDisabled = true;           // broken exe → pin the PS fallback
    _consecutiveFastFails = 0;
  }
  const delay = _consecutiveFastFails >= 3 ? FAIL_BACKOFF_MS : RESTART_DELAY_MS;
  if (_restartTimer) clearTimeout(_restartTimer);
  _restartTimer = setTimeout(_start, delay);
}

function _stopChild() {
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  if (_proc) {
    const p = _proc;
    _proc = null;                     // detach first so 'close' won't restart
    try { p.stdin.end(); } catch { /* helper exits on EOF */ }
    try { p.kill(); } catch { /* the PS loop needs the kill */ }
  }
  _buffer = '';
  // Privacy: drop the buffered notification text the moment nobody watches.
  _items = [];
  _state = 'off';
}

// Reconcile the child with the desired state. server.js computes `want` as
// (feature enabled && SSE clients > 0) and calls this from every trigger.
function sync(want) {
  _wanted = !!want && process.platform === 'win32';
  if (_wanted && !_proc && !_restartTimer && !_stopped) _start();
  else if (!_wanted && (_proc || _restartTimer || _items.length || _state !== 'off')) {
    _stopChild();
    _emitFeed();
  }
}

// Re-filter the stored feed after the excluded-apps list changed; announces
// only when something was actually dropped.
function applyExclusions() {
  const before = _items.length;
  _items = _items.filter(it => !_excluded(it));
  if (_items.length !== before) _emitFeed();
}

function getState() { return _state; }
function getFeed() { return _items; }

function stop() {
  _stopped = true;
  _wanted = false;
  _stopChild();
}

module.exports = {
  init, sync, applyExclusions, getState, getFeed, stop,
  // Test hook: the exact line handler the child reader drives, so the
  // seed/push/filter/cap behaviour is testable without spawning a process.
  _handleLine,
};
