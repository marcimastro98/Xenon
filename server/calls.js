'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Incoming calls — the ring lifecycle and the one place an answer is executed.
//
// call-detect.js decides "is this a call". This module decides what the user is
// allowed to DO about it on THIS machine, holds the ringing state so every
// surface (Xeneon Edge, kiosk app, browser, paired phone) shows the same card,
// and performs the action.
//
// Three things here are deliberate and worth reading before changing them.
//
// 1. A capability is computed, never assumed. `capabilitiesFor()` is pure and
//    unit-tested, and the card renders only the buttons it returns true for. A
//    Rispondi button that cannot answer is the exact "looks alive, does
//    nothing" failure this codebase avoids everywhere else, and it would be
//    worse here than anywhere: the user taps it, nothing happens, and the call
//    is gone by the time they reach for the mouse.
//
// 2. A ring ENDS on a timer, not on a signal, and that is a known limit rather
//    than an oversight. Windows' notification listener has no "toast removed"
//    event (measured: the API exposes AppInfo/CreationTime/Id/Visual only), and
//    teaching the mirror to diff removals would change the behaviour of the
//    shipped Notifications tile and the helper's stdio protocol at the same
//    time. So the card auto-closes after RING_TIMEOUT_MS, which is a little
//    longer than a real ring, and any user action closes it immediately.
//
// 3. Answering by shortcut is focus-then-send, never send-and-hope. Zoom's own
//    docs list which shortcuts may be promoted to global ones and the call
//    shortcuts are not among them; Teams' are plain in-app shortcuts. So the
//    app's window is brought to the front first, through the same cross-platform
//    /windows tool the App Switcher uses, and only then does the combo go out.
// ─────────────────────────────────────────────────────────────────────────

const callDetect = require('./call-detect');

// ── Pure: which combo answers/declines this call on this platform ───────────

const {
  comboFor, entryFor, capabilitiesFor, projectCall,
} = require('./transfer/call-capabilities.js');

// ── The live state ─────────────────────────────────────────────────────────

const { callState } = require('./transfer/calls-state.js');

const {
  RING_TIMEOUT_MS, DEDUPE_MS, MAX_ACTIVE, _settings, enabled, _broadcast, _rearm, _ring, _endByKey,
} = require('./transfer/calls-ring.js');

const { act } = require('./transfer/calls-act.js');

function init(deps) { callState.deps = deps && typeof deps === 'object' ? deps : null; }

// ── Inputs ─────────────────────────────────────────────────────────────────

function onNotification(item) {
  if (!enabled()) return null;
  const s = _settings();
  // "Missed call" / "call ended" first: it is a veto for ringing AND a signal
  // that a ring already on screen is over. Reading it only as a veto is what
  // left a card up after the caller had given up.
  const endedKey = callDetect.notificationCallEnded(item, { apps: s.apps });
  if (endedKey) {
    // A mirror app's "missed call" ends the STRUCTURAL card too. Its key is not
    // the one the notification produces, so without this the phone card would
    // sit there until its timeout while the toast under it already said the
    // call was over.
    if (_isPhoneMirror(item, s)) _endByKey(PHONE_KEY);
    _endByKey(endedKey);
    return null;
  }
  // A mirror app's toast while the phone is already ringing is the caller's
  // NAME arriving for a card that has none, not a second call.
  const named = _nameRingingPhoneCall(item, s);
  if (named) return named;
  const call = callDetect.classifyNotification(item, { apps: s.apps, allowed: s.allowed });
  if (!call) return null;
  const rec = _ring(call);
  // Remember which toast raised this card, so its removal can close it. See
  // onNotificationsPresent — for a mirrored phone call this is the ONLY end
  // signal there is, because the ringing toast simply vanishes on hang-up and
  // nothing is posted in its place (measured on a real call).
  if (rec && item && Number.isFinite(item.srcId)) rec.srcId = item.srcId;
  return rec;
}

// The set of toasts still in Action Center, from the notification reader. A
// card whose toast has gone stops ringing.
//
// `srcSeen` is what makes this safe. The reader's ids reset whenever its child
// process restarts, so a fresh set that happens not to contain our id must not
// be read as "removed". A card only becomes eligible once its id has actually
// been observed present at least once; until then absence means nothing.
function onNotificationsPresent(ids) {
  if (!callState.active.length) return;
  const present = new Set(Array.isArray(ids) ? ids : []);
  let changed = false;
  for (const call of callState.active.slice()) {
    if (!Number.isFinite(call.srcId)) continue;      // Discord, or an older reader
    if (present.has(call.srcId)) { call.srcSeen = true; continue; }
    if (!call.srcSeen) continue;
    callState.active = callState.active.filter(c => c !== call);
    callState.recent.delete(call.key);                        // an immediate call back must ring
    changed = true;
  }
  if (changed) { _broadcast(); _rearm(); }
}

// ── The paired phone ───────────────────────────────────────────────────────
// The one STRUCTURAL source outside Discord. The OS says a call is ringing, so
// unlike every notification-driven path this cannot miss a call because the
// wording was unfamiliar, and cannot invent one because a message mentioned the
// word. What it cannot say is WHO — that arrives, if at all, from the mirrored
// toast, which is why the two cooperate instead of racing.

const PHONE_KEY = 'p:phone';

// How long after the ring starts a mirror toast is still read as "this is the
// caller". A phone that is ringing will produce its toast within a second or
// two; a toast arriving much later is a different notification and must not be
// allowed to rename the person on screen.
const ENRICH_WINDOW_MS = 15000;

function _isPhoneMirror(item, s) {
  const app = callDetect.matchApp(item, s && s.apps);
  return !!(app && app.phoneMirror);
}

// Fill the caller in on the card the OS already raised. Returns the card when
// it took the notification, so the caller knows not to classify it again.
function _nameRingingPhoneCall(item, s) {
  const call = callState.active.find(c => c.key === PHONE_KEY);
  if (!call) return null;
  if (!_isPhoneMirror(item, s)) return null;
  if (Date.now() - call.at > ENRICH_WINDOW_MS) return null;
  // Once only. A second toast for the same ring (a re-announce, an SSE
  // re-seed) must not be able to overwrite a name that is already right.
  if (call.named) return call;

  const app = callDetect.matchApp(item, s.apps);
  const { caller, detail } = callDetect.callerFrom(item, app);
  if (!caller && !detail) return null;
  if (caller) call.caller = caller;
  if (detail && !call.detail) call.detail = detail;
  if (!call.icon && item && typeof item.icon === 'string') call.icon = item.icon;
  call.named = true;
  _broadcast();
  return call;
}

// The OS's call state changed. `incoming` false is a real end signal — the
// caller gave up, or the call was answered on the phone itself — and both mean
// the card has nothing left to offer, so it goes rather than waiting out the
// timeout that exists for sources with no end signal at all.
function onPhoneState(state) {
  if (!enabled()) return null;
  const s = state && typeof state === 'object' ? state : {};
  if (!s.incoming) { _endByKey(PHONE_KEY); return null; }

  // Already ringing: the OS re-reporting the same call is not a new one.
  const existing = callState.active.find(c => c.key === PHONE_KEY);
  if (existing) return existing;

  return _ring({
    source: 'phone',
    appId: 'phone',
    appName: String(s.device || '').slice(0, 60),
    caller: String(s.caller || '').slice(0, 120),
    detail: '',
    video: false,
    channelId: '',
    icon: '',
    key: PHONE_KEY,
  });
}

function onDiscordNotification(n) {
  if (!enabled()) return null;
  const s = _settings();
  if (_endByKey(callDetect.discordCallEnded(n))) return null;
  const call = callDetect.classifyDiscord(n, { allowed: s.allowed });
  return call ? _ring(call) : null;
}

// ── Acting on a ring ───────────────────────────────────────────────────────

// ── Read + lifecycle ───────────────────────────────────────────────────────

function current() { return callState.active.map(projectCall); }

// Turning the feature off must clear what is on screen: a card left ringing
// after the switch flipped would have no way to be answered.
function applySettings() {
  if (enabled()) return;
  if (!callState.active.length) return;
  callState.active = [];
  _broadcast();
  _rearm();
}

function stop() {
  callState.stopped = true;
  if (callState.timer) { clearTimeout(callState.timer); callState.timer = null; }
  callState.active = [];
  callState.recent.clear();
}

module.exports = {
  init, onNotification, onDiscordNotification, onPhoneState, onNotificationsPresent, act, current, applySettings, stop, enabled,
  // pure, exported for the tests
  capabilitiesFor, comboFor, entryFor, projectCall,
  RING_TIMEOUT_MS, DEDUPE_MS, MAX_ACTIVE,
  // test hooks: drive the lifecycle without a server
  _ringForTest: _ring,
  _resetForTest: () => { callState.active = []; callState.recent.clear(); callState.seq = 0; callState.stopped = false; if (callState.timer) { clearTimeout(callState.timer); callState.timer = null; } },
};
