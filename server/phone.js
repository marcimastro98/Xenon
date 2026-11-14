'use strict';

// ── The paired phone: server-side lifecycle ────────────────────────────────
// Owns the helper's `phone-serve` host and turns what it returns into the two
// things the dashboard consumes: a phonebook with a call log, and a live
// call-state signal.
//
// Three decisions worth reading before changing anything here.
//
// 1. THE HOST STAYS UP WHILE THE FEATURE IS ON, but does no periodic work.
//    Its whole job between pulls is to sit on the OS call-state event and push
//    when it changes, which costs nothing while the phone is idle. That is also
//    why there is no polling timer in this file: a call must announce itself in
//    the same second it starts, and a tick that could do that would have to run
//    forever for the rare seconds it matters.
//
// 2. A PULL IS EXPENSIVE AND CONTENDED, so it is cached and never automatic.
//    Reading the phonebook opens a Bluetooth channel other software also wants
//    (Phone Link takes the same one), so it happens on a long TTL or when the
//    user asks, never on a timer. Failure keeps the last good copy and reports
//    the error alongside it: a stale contact list is far more useful than an
//    empty one, as long as the UI can say it is stale.
//
// 3. CAPABILITIES ARE REPORTED, NEVER INFERRED. The helper says whether it can
//    dial and whether it can answer, and the answer to the second is currently
//    false everywhere this runs. The dashboard renders buttons from those
//    flags. Nothing here should ever synthesise a capability it did not read.

const { spawn } = require('child_process');
const fs = require('fs');


const {
  RETRY_MS, REQ_TIMEOUT_MS, CONTACTS_TTL_MS, CALLS_TTL_MS, MAX_CONTACTS, MAX_CALLS, MESSAGES_TTL_MS,
  MAX_MESSAGES, MAX_MESSAGE_CHARS,
} = require('./transfer/paired-phone-limits.js');

// Where the Bluetooth side of this actually exists. Windows today, because the
// helper is where the RFCOMM/OBEX client lives and only the Windows helper has
// a `phone-serve` mode.
//
// Declared rather than discovered, and the difference is the whole point. On
// macOS the helper BINARY is present (it is the Swift twin, with a different
// set of modes), so "is the helper there" answers yes and the feature would
// then fail as `phone_unavailable` — which reads as "your phone is not
// answering" when the phone is fine and the platform is the thing missing.
// Saying so plainly is what lets the UI hide the widget instead of offering
// one that can only fail. When the Linux and macOS transports land, this is the
// line that changes.
const SUPPORTED_PLATFORMS = new Set(['win32']);

// The escape hatch for bringing a platform up. Writing a transport and
// DECLARING the platform supported are two different acts, and the second one
// has to come after somebody has watched the first one work: a release that
// flips the declaration early gives every Mac user a widget that promises and
// does not deliver, which is the failure this file exists to avoid.
//
//   XENON_PHONE_PLATFORMS=darwin,linux
//
// So the transport can be exercised on the machine it targets while the shipped
// answer for everyone else stays "not on this system yet". When a platform is
// verified, it moves into SUPPORTED_PLATFORMS above and this stops being needed
// for it.
function platformAllowed(platform) {
  if (SUPPORTED_PLATFORMS.has(platform)) return true;
  const raw = String(process.env.XENON_PHONE_PLATFORMS || '');
  if (!raw) return false;
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).includes(platform);
}

const { makeLists } = require('./transfer/paired-phone-lists.js');

const { makeStatus } = require('./transfer/paired-phone-status.js');

const { makeCalls } = require('./transfer/paired-phone-calls.js');

function createPhone(opts) {
  const o = opts || {};
  const helperExe = o.helperExe;
  const platform = o.platform || process.platform;
  const supported = platformAllowed(platform);
  const broadcast = typeof o.broadcast === 'function' ? o.broadcast : () => {};
  const getSettings = typeof o.getSettings === 'function' ? o.getSettings : () => ({});
  const onCallState = typeof o.onCallState === 'function' ? o.onCallState : () => {};

  const host = { proc: null, buf: '', nextId: 1, pending: new Map(), diedAt: 0 };
  let stopped = false;
  let testRunner = null;   // test seam: replaces the whole round trip

  // Where the ops actually go. Windows and macOS reach a helper child over
  // stdio; Linux has no helper by design and drives BlueZ and ofono over D-Bus
  // instead. Both answer the SAME op names with the SAME shapes, so everything
  // below this line is one code path rather than a platform branch — the same
  // seam the collectors use, for the same reason.
  let native = null;
  function nativeTransport() {
    if (platform !== 'linux') return null;
    if (!native && !stopped) {
      native = require('./linux-phone').createLinuxPhone({
        onEvent: (env) => { if (env && env.event === 'callstate') applyCallState(env); },
      });
    }
    return native;
  }

  // Last good data. Kept across failures on purpose — see decision 2 above.
  const cache = {
    contacts: { at: 0, list: [], index: new Map(), total: -1, error: '' },
    calls: { at: 0, list: [], error: '' },
    status: { at: 0, value: null, error: '' },
    // Per folder, because inbox and sent are different reads and caching them
    // together would make opening one throw the other away.
    messages: new Map(),
  };
  const state = { incoming: false, active: false };

  function enabled() {
    const s = getSettings() || {};
    return s.enabled === true;
  }

  function helperPresent() {
    // The test seam replaces the whole round trip, so it stands in for the exe
    // as well: without this, every path here would answer `helper_missing` in a
    // test and none of the logic above it would ever be reached.
    if (testRunner) return true;
    // Linux answers over D-Bus and has no helper to look for; asking whether
    // one is on disk would report a missing download for a platform that never
    // wanted one.
    if (platform === 'linux') return true;
    try { return !!helperExe && fs.existsSync(helperExe); } catch { return false; }
  }

  // ── The host ─────────────────────────────────────────────────────────────

  function rejectPending(id, err) {
    const p = host.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    host.pending.delete(id);
    p.reject(err);
  }

  function retire(reason) {
    const proc = host.proc;
    host.proc = null;
    host.buf = '';
    if (reason !== 'shutdown') host.diedAt = Date.now();
    for (const id of [...host.pending.keys()]) rejectPending(id, new Error(reason || 'phone_host_down'));
    if (!proc) return;
    try { proc.stdin.end(); } catch { /* already gone */ }
    const force = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, 3000);
    force.unref();
    proc.once('exit', () => clearTimeout(force));
  }

  function ensure() {
    if (host.proc) return host.proc;
    // Never spawn where the mode does not exist: the process would exit
    // non-zero, back off, and retry forever for a capability that is absent by
    // construction rather than by accident.
    // Linux never spawns a child: its transport is D-Bus, not a helper.
    if (stopped || !supported || platform === 'linux' || !enabled() || !helperPresent()) return null;
    if (Date.now() - host.diedAt < RETRY_MS) return null;

    let proc;
    try { proc = spawn(helperExe, ['phone-serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { return null; }

    host.proc = proc;
    host.buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      host.buf += chunk;
      let nl;
      while ((nl = host.buf.indexOf('\n')) !== -1) {
        const line = host.buf.slice(0, nl).trim();
        host.buf = host.buf.slice(nl + 1);
        if (!line.startsWith('XEPHN ')) continue;
        let env;
        try { env = JSON.parse(Buffer.from(line.slice(6), 'base64').toString('utf8')); }
        catch { continue; }

        if (env.event === 'callstate') { applyCallState(env); continue; }

        const p = host.pending.get(env.id);
        if (!p) continue;
        clearTimeout(p.timer);
        host.pending.delete(env.id);
        if (!env.ok) { p.reject(new Error(env.err || 'phone_error')); continue; }
        let payload = {};
        try { payload = JSON.parse(env.out || '{}'); } catch { payload = {}; }
        p.resolve(payload);
      }
    });
    // A write to a pipe whose child is already gone reports EPIPE/ECONNRESET
    // ASYNCHRONOUSLY, as an 'error' event on the stream — the try/catch around
    // stdin.write() never sees it, and an unhandled 'error' on a stream takes
    // the whole server down. Route it to the same retire path the exit handler
    // uses: the host is dead either way, and every caller already falls back.
    proc.stdin.on('error', () => { if (host.proc === proc) retire('phone_host_pipe_error'); });
    proc.on('error', () => { if (host.proc === proc) retire('phone_host_spawn_error'); });
    proc.on('exit', () => { if (host.proc === proc) retire('phone_host_exited'); });
    proc.unref();
    return proc;
  }

  function request(op, extra, timeout) {
    if (testRunner) return testRunner(op, extra || {});
    if (!supported) return Promise.reject(new Error('platform_unsupported'));
    const direct = nativeTransport();
    if (direct) return direct.request(op, extra || {});
    return new Promise((resolve, reject) => {
      const proc = ensure();
      if (!proc) { reject(new Error(helperPresent() ? 'phone_unavailable' : 'helper_missing')); return; }
      const id = host.nextId++;
      const timer = setTimeout(() => rejectPending(id, new Error('phone_timeout')), timeout || REQ_TIMEOUT_MS);
      host.pending.set(id, { resolve, reject, timer });
      try { proc.stdin.write(JSON.stringify({ id, op, ...(extra || {}) }) + '\n'); }
      catch (e) {
        clearTimeout(timer);
        host.pending.delete(id);
        reject(e);
      }
    });
  }

  // ── Call state ───────────────────────────────────────────────────────────

  const {
    resolve, deviceName, canAnswer, canHangUp, canDial, answer, hangUp, dial,
  } = makeCalls({ supported, cache, enabled, request });

  const {
    applyCallState, publicState, status,
  } = makeStatus({ supported, broadcast, getSettings, onCallState, cache, state, enabled, helperPresent, request, resolve });

  // ── Reads ────────────────────────────────────────────────────────────────

  // ── Messages ─────────────────────────────────────────────────────────────

  const FOLDERS = ['inbox', 'sent'];

  const {
    contacts, calls, messageList, messageBody, sendMessage,
  } = makeLists({ cache, enabled, request, FOLDERS });

  // ── Actions ──────────────────────────────────────────────────────────────

  // ── Lifecycle ────────────────────────────────────────────────────────────

  // Called when settings change. Turning the feature off must retire the host:
  // it holds an OS event subscription and would otherwise keep pushing call
  // state for a feature the user switched off.
  function applySettings() {
    if (stopped) return;
    // The status carries the user's own `hide` flag alongside the capabilities,
    // so a stale one would leave message text masked (or shown) for the length
    // of its TTL after the switch was flipped.
    cache.status.at = 0;
    if (!enabled()) {
      retire('disabled');
      // The D-Bus transport polls call state while it is alive, so switching
      // the feature off has to end it too, not only the helper child.
      if (native) { try { native.stop(); } catch { /* already down */ } native = null; }
      if (state.incoming || state.active) {
        state.incoming = false;
        state.active = false;
        broadcast('phone', publicState());
      }
      return;
    }
    ensure();
  }

  function stop() {
    stopped = true;
    retire('shutdown');
    if (native) { try { native.stop(); } catch { /* already down */ } native = null; }
  }

  return {
    status, contacts, calls, dial, answer, hangUp,
    resolve, deviceName, canAnswer, canHangUp, canDial,
    messages: messageList, message: messageBody, sendMessage,
    applySettings, stop, enabled,
    state: publicState,
    // test seam: drive the whole module without a helper or a phone
    _setRunnerForTest: (fn) => { testRunner = fn; },
    _cacheForTest: cache,
  };
}

module.exports = {
  createPhone,
  SUPPORTED_PLATFORMS,
  platformAllowed,
  CONTACTS_TTL_MS, CALLS_TTL_MS, MESSAGES_TTL_MS,
  MAX_CONTACTS, MAX_CALLS, MAX_MESSAGES, MAX_MESSAGE_CHARS,
};
