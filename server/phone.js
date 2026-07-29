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

const vcard = require('./phone-vcard');
const numbers = require('./phone-numbers');
const messages = require('./phone-messages');

const RETRY_MS = 20 * 1000;          // after a host death, before trying again
const REQ_TIMEOUT_MS = 30 * 1000;    // a Bluetooth pull is slow, but not this slow
const CONTACTS_TTL_MS = 30 * 60 * 1000;
const CALLS_TTL_MS = 2 * 60 * 1000;
// The floor under a FORCED refresh. Two jobs, and the second is the important
// one: it keeps the read endpoints from being a way to pump the Bluetooth
// channel. A cross-site request cannot read the JSON that comes back, but it
// could still ask for `?refresh=1` in a loop and keep the phone's phonebook
// server busy — which is a channel other software on the machine also wants.
// With a floor, that attack degrades to "serves the cache", so these stay
// ordinary reads instead of needing a mutation guard.
const REFRESH_MIN_MS = 10 * 1000;
const STATUS_TTL_MS = 15 * 1000;
const MAX_CONTACTS = 2000;
const MAX_CALLS = 100;
const MESSAGES_TTL_MS = 60 * 1000;
const MAX_MESSAGES = 40;
// Longer than any SMS and short enough to travel in one OBEX packet, which is
// what the helper's single-packet PUT requires. Checked here as well as there.
const MAX_MESSAGE_CHARS = 1000;

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

  // The structural signal. `incoming` here is the OS saying a call is ringing
  // right now, which is a fact rather than the notification-text guess the card
  // used to depend on — so this is what starts the ring, and the mirrored toast
  // is left to supply the one thing this cannot: who is calling.
  function applyCallState(env) {
    const incoming = env.incoming === true;
    const active = env.active === true;
    if (incoming === state.incoming && active === state.active) return;
    state.incoming = incoming;
    state.active = active;
    broadcast('phone', publicState());
    try { onCallState({ incoming, active, resolve }); } catch { /* a listener must never break the feed */ }
  }

  function publicState() {
    return {
      incoming: state.incoming,
      active: state.active,
      contacts: cache.contacts.list.length,
      calls: cache.calls.list.length,
      stale: staleness(),
    };
  }

  function staleness() {
    const now = Date.now();
    return {
      contacts: cache.contacts.at ? now - cache.contacts.at : -1,
      calls: cache.calls.at ? now - cache.calls.at : -1,
    };
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async function status(force) {
    if (!enabled()) return { ok: false, enabled: false, reason: 'disabled', supported };
    if (!supported) return { ok: false, enabled: true, reason: 'platform_unsupported', supported: false };
    if (!helperPresent()) return { ok: false, enabled: true, reason: 'helper_missing', supported: true };
    const now = Date.now();
    if (!force && cache.status.value && now - cache.status.at < STATUS_TTL_MS) {
      return { ok: true, enabled: true, ...cache.status.value, state: publicState() };
    }
    try {
      const value = await request('status', {}, 15000);
      // `hide` is the user's own setting, not a capability, but the widget
      // needs both in one read and asking twice would just be a second request.
      value.hide = (getSettings() || {}).hide === true;
      cache.status = { at: now, value, error: '' };
      // The host answers with the live booleans too; adopting them keeps a
      // dashboard that opened mid-call correct without waiting for the next
      // change event, which may be a minute away.
      applyCallState(value);
      return { ok: true, enabled: true, ...value, state: publicState() };
    } catch (e) {
      cache.status.error = String((e && e.message) || 'phone_error');
      return { ok: false, enabled: true, reason: cache.status.error, state: publicState() };
    }
  }

  async function contacts(force) {
    if (!enabled()) return { ok: false, reason: 'disabled', list: [] };
    const now = Date.now();
    if (force && cache.contacts.at && now - cache.contacts.at < REFRESH_MIN_MS) force = false;
    if (!force && cache.contacts.at && now - cache.contacts.at < CONTACTS_TTL_MS) {
      return { ok: true, list: cache.contacts.list, total: cache.contacts.total, at: cache.contacts.at, cached: true };
    }
    try {
      const out = await request('contacts', { max: MAX_CONTACTS });
      const list = vcard.parseContacts(out && out.vcf).sort(byName);
      cache.contacts = {
        at: Date.now(),
        list,
        index: numbers.buildIndex(list),
        total: Number.isFinite(out && out.total) ? out.total : list.length,
        error: '',
      };
      // The call log is pulled first and the phonebook is lazy, so rows the
      // phone sent without a name were resolved against an index that did not
      // exist yet. Re-resolve the cached log now rather than leaving bare
      // numbers on screen until its own TTL runs out.
      if (cache.calls.list.length) cache.calls.list = cache.calls.list.map(withName);
      return { ok: true, list, total: cache.contacts.total, at: cache.contacts.at, cached: false };
    } catch (e) {
      const reason = String((e && e.message) || 'phone_error');
      cache.contacts.error = reason;
      // Last good copy, plainly labelled. An empty list would read as "you have
      // no contacts", which is a different and much worse statement.
      return { ok: false, reason, list: cache.contacts.list, total: cache.contacts.total, at: cache.contacts.at, cached: true };
    }
  }

  async function calls(force) {
    if (!enabled()) return { ok: false, reason: 'disabled', list: [] };
    const now = Date.now();
    if (force && cache.calls.at && now - cache.calls.at < REFRESH_MIN_MS) force = false;
    if (!force && cache.calls.at && now - cache.calls.at < CALLS_TTL_MS) {
      return { ok: true, list: cache.calls.list, at: cache.calls.at, cached: true };
    }
    try {
      // The COMBINED book, once. Direction rides on each entry's timestamp
      // parameter, so pulling ich/och/mch separately would be three extra
      // Bluetooth round trips for information already in this one.
      const out = await request('calls', { book: 'cch', max: MAX_CALLS });
      const list = vcard.parseCallLog(out && out.vcf, 'cch').map(withName);
      cache.calls = { at: Date.now(), list, error: '' };
      return { ok: true, list, at: cache.calls.at, cached: false };
    } catch (e) {
      const reason = String((e && e.message) || 'phone_error');
      cache.calls.error = reason;
      return { ok: false, reason, list: cache.calls.list, at: cache.calls.at, cached: true };
    }
  }

  // ── Messages ─────────────────────────────────────────────────────────────

  const FOLDERS = ['inbox', 'sent'];

  function msgCache(folder) {
    if (!cache.messages.has(folder)) cache.messages.set(folder, { at: 0, list: [], error: '' });
    return cache.messages.get(folder);
  }

  async function messageList(folder, force) {
    if (!enabled()) return { ok: false, reason: 'disabled', list: [] };
    const key = FOLDERS.includes(String(folder)) ? String(folder) : 'inbox';
    const slot = msgCache(key);
    const now = Date.now();
    if (force && slot.at && now - slot.at < REFRESH_MIN_MS) force = false;
    if (!force && slot.at && now - slot.at < MESSAGES_TTL_MS) {
      return { ok: true, folder: key, list: slot.list, at: slot.at, cached: true };
    }
    try {
      const out = await request('messages', { folder: key, max: MAX_MESSAGES });
      // Two containers, one shape. Windows returns the MAP listing XML; on
      // Linux obexd has already parsed it and returns D-Bus rows. Which one
      // arrived is the transport's business, so it says so rather than being
      // guessed at from the payload.
      const parsed = (out && out.obex)
        ? messages.parseObexMessages(out.rows)
        : messages.parseListing(out && out.xml);
      // The phone often knows the sender's name already; when it does not, the
      // phonebook fills it in exactly as it does for the call log.
      const list = parsed.map(withName);
      slot.at = Date.now();
      slot.list = list;
      slot.error = '';
      return { ok: true, folder: key, list, at: slot.at, cached: false };
    } catch (e) {
      const reason = String((e && e.message) || 'phone_error');
      slot.error = reason;
      // The last good list, plainly labelled. On Windows this path is REACHED
      // ROUTINELY and is not a fault: Phone Link holds the same channel while
      // it runs, so "busy" is a state to report, never something to fight over.
      return { ok: false, reason, folder: key, list: slot.list, at: slot.at, cached: true };
    }
  }

  // One message, fetched on open. Deliberately not cached: a body is the part
  // of this feature most worth not keeping around, and it is one round trip.
  async function messageBody(folder, handle) {
    if (!enabled()) return { ok: false, reason: 'disabled' };
    const key = FOLDERS.includes(String(folder)) ? String(folder) : 'inbox';
    // A bounded, generic check here; the SHAPE is the transport's business.
    // Windows handles are MAP hex ids and the helper re-asserts that; on Linux
    // they are obexd object paths, which that transport re-resolves against a
    // fresh listing before using. Hard-coding one shape at this level would
    // refuse the other, and loosening the transport's own check to compensate
    // is exactly the wrong direction.
    const id = String(handle == null ? '' : handle).trim();
    if (!id || id.length > 256 || /[\s"'`\\]|\.\./.test(id)) return { ok: false, reason: 'bad_handle' };
    try {
      const out = await request('message', { folder: key, handle: id });
      const parsed = messages.parseMessage(out && out.bmsg);
      if (!parsed) return { ok: false, reason: 'phone_error' };
      if (!parsed.name) {
        const hit = numbers.lookup(cache.contacts.index, parsed.number);
        if (hit) parsed.name = hit.name;
      }
      return { ok: true, folder: key, handle: id, message: parsed };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || 'phone_error') };
    }
  }

  async function sendMessage(rawNumber, rawText) {
    if (!enabled()) return { ok: false, error: 'disabled' };
    const number = numbers.dialable(rawNumber);
    if (!number) return { ok: false, error: 'bad_number' };
    const text = String(rawText == null ? '' : rawText).trim();
    if (!text) return { ok: false, error: 'empty_message' };
    if (text.length > MAX_MESSAGE_CHARS) return { ok: false, error: 'message_too_long' };
    try {
      await request('send', { number, text }, 20000);
      // The phone writes the message into its own sent folder a moment later,
      // so the cached copy is dropped rather than left looking stale.
      msgCache('sent').at = 0;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || 'phone_error') };
    }
  }

  // The call log names most callers itself, but not all of them: an entry whose
  // contact was added after the call carries only a number. Resolving against
  // the phonebook fills those in without inventing anything — an unmatched
  // number stays a number.
  function withName(row) {
    if (row.name) return row;
    const hit = numbers.lookup(cache.contacts.index, row.number);
    return hit ? { ...row, name: hit.name } : row;
  }

  function byName(a, b) {
    const an = (a.name || '').toLowerCase();
    const bn = (b.name || '').toLowerCase();
    if (an && bn) return an.localeCompare(bn);
    if (an) return -1;
    if (bn) return 1;
    return 0;
  }

  // Public name resolution, for the incoming-call card and anything else that
  // holds a number and wants a person.
  function resolve(number) {
    return numbers.lookup(cache.contacts.index, number);
  }

  // The phone's own name, as the user sees it on the device. Read from the last
  // status rather than fetched, because the caller is a ringing call: a round
  // trip here would delay the card by exactly the seconds it exists for.
  function deviceName() {
    const v = cache.status.value;
    return (v && typeof v.device === 'string' && v.device) || '';
  }

  // What the platform actually allows, as the helper reported it. Both are
  // false everywhere today and the card renders from them anyway, so the day
  // one platform can answer a call, nothing above this line has to change.
  function canAnswer() {
    const v = cache.status.value;
    return !!(v && v.canAnswer === true);
  }

  function canHangUp() {
    const v = cache.status.value;
    return !!(v && v.canHangUp === true);
  }

  // Whether a Deck key or an AI tool that dials would work right now. Cached,
  // never probed: the action catalog is fetched while the Deck editor is open,
  // and a Bluetooth round trip there would stall the whole key list.
  function canDial() {
    const v = cache.status.value;
    return !!(supported && v && v.canDial === true);
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  // Answering and hanging up. Both exist for exactly one platform today, which
  // is why they are ops rather than assumptions: `canAnswer` comes back from
  // the transport, the card renders from it, and here the capability is checked
  // again before anything is attempted — a button the client should not have
  // drawn must still be refused by the server.
  async function answer() {
    if (!enabled()) return { ok: false, error: 'disabled' };
    if (!canAnswer()) return { ok: false, error: 'unavailable' };
    try { await request('answer', {}, 15000); return { ok: true }; }
    catch (e) { return { ok: false, error: String((e && e.message) || 'phone_error') }; }
  }

  async function hangUp() {
    if (!enabled()) return { ok: false, error: 'disabled' };
    if (!canHangUp()) return { ok: false, error: 'unavailable' };
    try { await request('hangup', {}, 15000); return { ok: true }; }
    catch (e) { return { ok: false, error: String((e && e.message) || 'phone_error') }; }
  }

  async function dial(rawNumber) {
    if (!enabled()) return { ok: false, error: 'disabled' };
    // Validated here as well as at the boundary: this is the one call in the
    // feature that reaches the outside world and costs the user money, so what
    // reaches the phone is a number and nothing else.
    const number = numbers.dialable(rawNumber);
    if (!number) return { ok: false, error: 'bad_number' };
    try {
      await request('dial', { number }, 15000);
      return { ok: true, number };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || 'phone_error') };
    }
  }

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
