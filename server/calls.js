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

const RING_TIMEOUT_MS = 45000;   // a little past a real ring, then the card goes
const DEDUPE_MS = 20000;         // the same ring re-announced is not a new call
const MAX_ACTIVE = 3;            // two phones ringing at once is rare, not impossible
const FOCUS_SETTLE_MS = 220;     // let the window actually come forward before the key

// ── Pure: which combo answers/declines this call on this platform ───────────

// Teams moves its shortcuts to Command on macOS, Zoom keeps Control there. That
// is why each entry carries an explicit `mac` rather than a rule — deriving it
// would send a working shortcut to the wrong app on one of the two.
function comboFor(entry, kind, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const spec = kind === 'decline'
    ? (entry && entry.decline)
    : (o.video && entry && entry.answerVideo) ? entry.answerVideo : (entry && entry.answer);
  if (!spec) return '';
  const mac = o.platform === 'darwin';
  const keys = mac && spec.mac ? spec.mac : spec.keys;
  return typeof keys === 'string' ? keys : '';
}

// Find the app table entry a live call belongs to (defaults + the user's own).
function entryFor(appId, extraApps) {
  const list = Array.isArray(extraApps) ? extraApps : [];
  for (const a of list) if (a && a.id === appId) return a;
  for (const a of callDetect.DEFAULT_APPS) if (a.id === appId) return a;
  return null;
}

// What the user may do about this ring, on this machine, right now.
//
// `hotkey` is the capability of SENDING a key combo at all, which is not the
// same question on every platform: Windows has had it since the Deck shipped,
// macOS gained it with the helper's key-send mode, and Linux only has it when
// ydotool is installed. The caller measures it; this function only combines.
function capabilitiesFor(call, ctx) {
  const c = call && typeof call === 'object' ? call : {};
  const x = ctx && typeof ctx === 'object' ? ctx : {};
  const entry = entryFor(c.appId, x.apps);
  const caps = { answer: false, decline: false, open: false, silence: true, via: '' };

  // Opening the app is the floor: it works wherever the window tool does, and
  // it is the honest fallback for every app we cannot control. It is never the
  // whole answer though — the user still has to click Accept themselves.
  caps.open = x.windowTool !== false;

  // A call on the paired phone. The ring is a fact the OS reported, and every
  // action on it belongs to hardware we cannot reach: answering needs the HFP
  // channel, which the system driver owns, and there is no public API for it
  // either. So the card silences and dismisses, and says nothing it cannot do.
  // `canAnswer` is threaded through from the helper rather than hardcoded here,
  // so the day a platform does allow it, one flag turns the button on.
  if (c.source === 'phone') {
    caps.open = false;                 // there is no application to bring forward
    caps.answer = x.phoneCanAnswer === true;
    caps.decline = x.phoneCanHangUp === true;
    if (caps.answer || caps.decline) caps.via = 'phone';
    return caps;
  }

  if (c.source === 'discord') {
    // The only real answer in the product: SELECT_VOICE_CHANNEL joins a DM or
    // group call, on all three platforms, with no window focus and no shortcut.
    caps.answer = !!x.discordLinked && typeof c.channelId === 'string' && /^\d{5,25}$/.test(c.channelId);
    // Discord's RPC has no decline command. Saying so is better than offering a
    // button that silences the ring and leaves the caller ringing.
    caps.decline = false;
    if (caps.answer) caps.via = 'rpc';
    return caps;
  }

  if (!x.hotkey || !entry) return caps;
  const answerKeys = comboFor(entry, 'answer', { platform: x.platform, video: !!c.video });
  const declineKeys = comboFor(entry, 'decline', { platform: x.platform });
  // A combo is useless without a window to send it to: these are in-app
  // shortcuts, so if the window tool is gone the answer cannot be delivered.
  caps.answer = !!answerKeys && caps.open;
  caps.decline = !!declineKeys && caps.open;
  if (caps.answer || caps.decline) caps.via = 'hotkey';
  return caps;
}

// The client-safe projection of a ringing call. Never carries anything the card
// does not render: no window ids, no raw notification, no combos.
function projectCall(call) {
  return {
    id: call.id,
    at: call.at,
    endsAt: call.endsAt,
    appId: call.appId,
    appName: call.appName,
    caller: call.caller,
    detail: call.detail,
    video: !!call.video,
    icon: call.icon || '',
    source: call.source,
    silenced: !!call.silenced,
    caps: call.caps,
  };
}

// ── The live state ─────────────────────────────────────────────────────────

let _deps = null;
let _active = [];          // newest first, capped at MAX_ACTIVE
let _recent = new Map();   // dedupe key → last ring time
let _seq = 0;
let _timer = null;
let _stopped = false;

function init(deps) { _deps = deps && typeof deps === 'object' ? deps : null; }

function _settings() {
  try { return (_deps && _deps.getSettings && _deps.getSettings()) || {}; }
  catch { return {}; }
}

function enabled() { return _settings().enabled === true; }

function _broadcast() {
  if (!_deps || typeof _deps.broadcast !== 'function') return;
  try { _deps.broadcast('calls', { calls: _active.map(projectCall) }); }
  catch { /* a listener error never breaks the ring */ }
}

// One timer for the whole list rather than one per call: the list is at most
// three long and the tick only has to be accurate to about a second.
function _rearm() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_stopped || !_active.length) return;
  const soonest = Math.min(..._active.map(c => c.endsAt));
  const delay = Math.max(250, soonest - Date.now());
  _timer = setTimeout(_expire, delay);
  if (typeof _timer.unref === 'function') _timer.unref();
}

function _expire() {
  _timer = null;
  const now = Date.now();
  const before = _active.length;
  _active = _active.filter(c => c.endsAt > now);
  if (_active.length !== before) _broadcast();
  _rearm();
}

// Drop dedupe entries that can no longer suppress anything, so the map cannot
// grow across a long uptime.
function _pruneRecent(now) {
  for (const [k, t] of _recent) if (now - t > DEDUPE_MS) _recent.delete(k);
}

// A classified call becomes a ringing card — or is dropped as a repeat.
function _ring(call) {
  if (_stopped || !enabled() || !call) return null;
  const now = Date.now();
  _pruneRecent(now);
  if (call.key && _recent.has(call.key) && now - _recent.get(call.key) < DEDUPE_MS) return null;
  if (call.key) _recent.set(call.key, now);

  const s = _settings();
  const ctx = {
    platform: (_deps && _deps.platform) || process.platform,
    apps: Array.isArray(s.apps) ? s.apps : [],
    hotkey: !!(_deps && typeof _deps.hotkeyAvailable === 'function' && _deps.hotkeyAvailable()),
    windowTool: !!(_deps && typeof _deps.listWindows === 'function'),
    discordLinked: !!(_deps && typeof _deps.discordLinked === 'function' && _deps.discordLinked()),
    phoneCanAnswer: !!(_deps && typeof _deps.phoneCanAnswer === 'function' && _deps.phoneCanAnswer()),
    phoneCanHangUp: !!(_deps && typeof _deps.phoneCanHangUp === 'function' && _deps.phoneCanHangUp()),
  };

  const rec = {
    ...call,
    id: 'c' + (++_seq) + '-' + now.toString(36),
    at: now,
    endsAt: now + RING_TIMEOUT_MS,
    silenced: false,
    caps: capabilitiesFor(call, ctx),
  };
  _active.unshift(rec);
  if (_active.length > MAX_ACTIVE) _active.length = MAX_ACTIVE;
  _broadcast();
  _rearm();
  _notifyAway(rec);
  try { if (_deps && _deps.onEvent) _deps.onEvent('notification'); } catch { /* lighting optional */ }
  return rec;
}

// The push title, in the 11 languages the dashboard speaks. A lock-screen line
// is the one piece of text here that the client cannot translate for us — it is
// written while nobody is looking at a dashboard — so the server picks it from
// the language already stored in settings, exactly like the daily briefing does.
const PUSH_TITLE = Object.freeze({
  en: ['Incoming call', 'Incoming video call'],
  it: ['Chiamata in arrivo', 'Videochiamata in arrivo'],
  es: ['Llamada entrante', 'Videollamada entrante'],
  fr: ['Appel entrant', 'Appel vidéo entrant'],
  de: ['Eingehender Anruf', 'Eingehender Videoanruf'],
  pt: ['Chamada recebida', 'Videochamada recebida'],
  nl: ['Inkomende oproep', 'Inkomend videogesprek'],
  ru: ['Входящий вызов', 'Входящий видеозвонок'],
  ja: ['着信', 'ビデオ通話の着信'],
  ko: ['수신 전화', '영상 통화 수신'],
  zh: ['来电', '视频通话来电'],
});

// Wake a phone that is not looking at the dashboard. An incoming call is the
// archetype of what Web Push exists for here: something the user set up and is
// actively waiting for, not a digest. The caller's name is the whole payload —
// a lock screen is a public surface, so nothing else goes in it.
function _notifyAway(rec) {
  if (!_deps || typeof _deps.push !== 'function') return;
  if (_settings().push === false) return;
  let lang = 'en';
  try { lang = String((_deps.getLanguage && _deps.getLanguage()) || 'en').slice(0, 2).toLowerCase(); }
  catch { lang = 'en'; }
  const titles = PUSH_TITLE[lang] || PUSH_TITLE.en;
  const who = rec.caller || '';
  try {
    _deps.push({
      title: titles[rec.video ? 1 : 0],
      body: who ? who + ' · ' + rec.appName : rec.appName,
      tag: 'xenon-call',
    });
  } catch { /* push is best-effort; the card is the real surface */ }
}

// ── Inputs ─────────────────────────────────────────────────────────────────

// Stop ringing a call whose end was just announced. Also clears its dedupe
// entry: the same person calling straight back is a NEW call, and leaving the
// key behind would swallow it for the rest of the window.
function _endByKey(key) {
  if (!key) return false;
  const before = _active.length;
  _active = _active.filter(c => c.key !== key);
  _recent.delete(key);
  if (_active.length === before) return false;
  _broadcast();
  _rearm();
  return true;
}

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
  if (!_active.length) return;
  const present = new Set(Array.isArray(ids) ? ids : []);
  let changed = false;
  for (const call of _active.slice()) {
    if (!Number.isFinite(call.srcId)) continue;      // Discord, or an older reader
    if (present.has(call.srcId)) { call.srcSeen = true; continue; }
    if (!call.srcSeen) continue;
    _active = _active.filter(c => c !== call);
    _recent.delete(call.key);                        // an immediate call back must ring
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
  const call = _active.find(c => c.key === PHONE_KEY);
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
  const existing = _active.find(c => c.key === PHONE_KEY);
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

function _find(id) { return _active.find(c => c.id === String(id || '')) || null; }

function _drop(id) {
  const before = _active.length;
  _active = _active.filter(c => c.id !== id);
  if (_active.length !== before) { _broadcast(); _rearm(); }
}

// Bring the app's window forward. Matching is by the same `match` list the
// classifier uses, checked against the window's process name AND its title,
// because an Electron app reports a generic process name on some platforms.
async function _focusApp(call) {
  if (!_deps || typeof _deps.listWindows !== 'function' || typeof _deps.focusWindow !== 'function') {
    return { ok: false, error: 'no_window_tool' };
  }
  const entry = entryFor(call.appId, _settings().apps);
  const needles = (entry && Array.isArray(entry.match) ? entry.match : [])
    .map(m => callDetect.foldText(m)).filter(Boolean);
  if (!needles.length) return { ok: false, error: 'no_match_rule' };

  let list = [];
  try {
    const r = await _deps.listWindows();
    list = Array.isArray(r && r.windows) ? r.windows : [];
  } catch { return { ok: false, error: 'window_list_failed' }; }

  const hit = list.find((w) => {
    const hay = callDetect.foldText(String((w && w.app) || '') + ' ' + String((w && w.title) || ''));
    return hay && needles.some(n => hay.includes(n));
  });
  if (!hit || !hit.id) return { ok: false, error: 'window_not_found' };

  try {
    const r = await _deps.focusWindow(String(hit.id));
    if (r && r.ok === false) return { ok: false, error: r.error || 'focus_failed' };
  } catch { return { ok: false, error: 'focus_failed' }; }
  return { ok: true };
}

// Focus the app, wait for it to actually come forward, then send the combo.
// The wait is not superstition: a shortcut delivered while the window is still
// animating goes to whatever had focus before, which on a touchscreen is the
// dashboard itself.
async function _sendToApp(call, kind) {
  const entry = entryFor(call.appId, _settings().apps);
  const keys = comboFor(entry, kind, {
    platform: (_deps && _deps.platform) || process.platform,
    video: !!call.video,
  });
  if (!keys) return { ok: false, error: 'no_shortcut' };
  const focused = await _focusApp(call);
  if (!focused.ok) return focused;
  await new Promise(r => setTimeout(r, FOCUS_SETTLE_MS));
  if (typeof _deps.sendHotkey !== 'function') return { ok: false, error: 'hotkey_unavailable' };
  try {
    const r = await _deps.sendHotkey(keys);
    if (r && r.ok === false) return { ok: false, error: r.error || 'hotkey_failed' };
  } catch { return { ok: false, error: 'hotkey_failed' }; }
  return { ok: true };
}

// The single entry point for every button on the card. Never throws: a failure
// is reported to the card so it can say what went wrong instead of appearing to
// have worked.
async function act(id, action) {
  const call = _find(id);
  if (!call) return { ok: false, error: 'not_ringing' };
  const what = String(action || '');

  if (what === 'silence') {
    call.silenced = true;
    _broadcast();
    return { ok: true };
  }
  if (what === 'dismiss') { _drop(call.id); return { ok: true }; }

  if (what === 'open') {
    if (!call.caps.open) return { ok: false, error: 'unavailable' };
    const r = await _focusApp(call);
    if (r.ok) _drop(call.id);
    return r;
  }

  if (what === 'answer') {
    if (!call.caps.answer) return { ok: false, error: 'unavailable' };
    if (call.source === 'discord') {
      if (typeof _deps.discordJoin !== 'function') return { ok: false, error: 'discord_unavailable' };
      let r;
      try { r = await _deps.discordJoin(call.channelId); }
      catch { return { ok: false, error: 'discord_failed' }; }
      if (r && r.ok === false) return { ok: false, error: r.error || 'discord_failed' };
      _drop(call.id);
      return { ok: true };
    }
    const r = await _sendToApp(call, 'answer');
    if (r.ok) _drop(call.id);
    return r;
  }

  if (what === 'decline') {
    if (!call.caps.decline) return { ok: false, error: 'unavailable' };
    const r = await _sendToApp(call, 'decline');
    if (r.ok) _drop(call.id);
    return r;
  }

  return { ok: false, error: 'bad_action' };
}

// ── Read + lifecycle ───────────────────────────────────────────────────────

function current() { return _active.map(projectCall); }

// Turning the feature off must clear what is on screen: a card left ringing
// after the switch flipped would have no way to be answered.
function applySettings() {
  if (enabled()) return;
  if (!_active.length) return;
  _active = [];
  _broadcast();
  _rearm();
}

function stop() {
  _stopped = true;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _active = [];
  _recent.clear();
}

module.exports = {
  init, onNotification, onDiscordNotification, onPhoneState, onNotificationsPresent, act, current, applySettings, stop, enabled,
  // pure, exported for the tests
  capabilitiesFor, comboFor, entryFor, projectCall,
  RING_TIMEOUT_MS, DEDUPE_MS, MAX_ACTIVE,
  // test hooks: drive the lifecycle without a server
  _ringForTest: _ring,
  _resetForTest: () => { _active = []; _recent.clear(); _seq = 0; _stopped = false; if (_timer) { clearTimeout(_timer); _timer = null; } },
};
