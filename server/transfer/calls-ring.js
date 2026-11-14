'use strict';
// Starts and ends a ringing call for the phone-call relay: tells the dashboards, notifies the
// phone that is away, and drops a call nobody answered.

const { capabilitiesFor, projectCall } = require('./call-capabilities.js');
const { callState } = require('./calls-state.js');

const RING_TIMEOUT_MS = 45000;   // a little past a real ring, then the card goes
const DEDUPE_MS = 20000;         // the same ring re-announced is not a new call
const MAX_ACTIVE = 3;            // two phones ringing at once is rare, not impossible

function _settings() {
  try { return (callState.deps && callState.deps.getSettings && callState.deps.getSettings()) || {}; }
  catch { return {}; }
}

function enabled() { return _settings().enabled === true; }

function _broadcast() {
  if (!callState.deps || typeof callState.deps.broadcast !== 'function') return;
  try { callState.deps.broadcast('calls', { calls: callState.active.map(projectCall) }); }
  catch { /* a listener error never breaks the ring */ }
}

// One timer for the whole list rather than one per call: the list is at most
// three long and the tick only has to be accurate to about a second.
function _rearm() {
  if (callState.timer) { clearTimeout(callState.timer); callState.timer = null; }
  if (callState.stopped || !callState.active.length) return;
  const soonest = Math.min(...callState.active.map(c => c.endsAt));
  const delay = Math.max(250, soonest - Date.now());
  callState.timer = setTimeout(_expire, delay);
  if (typeof callState.timer.unref === 'function') callState.timer.unref();
}

function _expire() {
  callState.timer = null;
  const now = Date.now();
  const before = callState.active.length;
  callState.active = callState.active.filter(c => c.endsAt > now);
  if (callState.active.length !== before) _broadcast();
  _rearm();
}

// Drop dedupe entries that can no longer suppress anything, so the map cannot
// grow across a long uptime.
function _pruneRecent(now) {
  for (const [k, t] of callState.recent) if (now - t > DEDUPE_MS) callState.recent.delete(k);
}

// A classified call becomes a ringing card — or is dropped as a repeat.
function _ring(call) {
  if (callState.stopped || !enabled() || !call) return null;
  const now = Date.now();
  _pruneRecent(now);
  if (call.key && callState.recent.has(call.key) && now - callState.recent.get(call.key) < DEDUPE_MS) return null;
  if (call.key) callState.recent.set(call.key, now);

  const s = _settings();
  const ctx = {
    platform: (callState.deps && callState.deps.platform) || process.platform,
    apps: Array.isArray(s.apps) ? s.apps : [],
    hotkey: !!(callState.deps && typeof callState.deps.hotkeyAvailable === 'function' && callState.deps.hotkeyAvailable()),
    windowTool: !!(callState.deps && typeof callState.deps.listWindows === 'function'),
    discordLinked: !!(callState.deps && typeof callState.deps.discordLinked === 'function' && callState.deps.discordLinked()),
    phoneCanAnswer: !!(callState.deps && typeof callState.deps.phoneCanAnswer === 'function' && callState.deps.phoneCanAnswer()),
    phoneCanHangUp: !!(callState.deps && typeof callState.deps.phoneCanHangUp === 'function' && callState.deps.phoneCanHangUp()),
  };

  const rec = {
    ...call,
    id: 'c' + (++callState.seq) + '-' + now.toString(36),
    at: now,
    endsAt: now + RING_TIMEOUT_MS,
    silenced: false,
    caps: capabilitiesFor(call, ctx),
  };
  callState.active.unshift(rec);
  if (callState.active.length > MAX_ACTIVE) callState.active.length = MAX_ACTIVE;
  _broadcast();
  _rearm();
  _notifyAway(rec);
  try { if (callState.deps && callState.deps.onEvent) callState.deps.onEvent('notification'); } catch { /* lighting optional */ }
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
  if (!callState.deps || typeof callState.deps.push !== 'function') return;
  if (_settings().push === false) return;
  let lang = 'en';
  try { lang = String((callState.deps.getLanguage && callState.deps.getLanguage()) || 'en').slice(0, 2).toLowerCase(); }
  catch { lang = 'en'; }
  const titles = PUSH_TITLE[lang] || PUSH_TITLE.en;
  const who = rec.caller || '';
  try {
    callState.deps.push({
      title: titles[rec.video ? 1 : 0],
      body: who ? who + ' · ' + rec.appName : rec.appName,
      tag: 'xenon-call',
    });
  } catch { /* push is best-effort; the card is the real surface */ }
}

// Stop ringing a call whose end was just announced. Also clears its dedupe
// entry: the same person calling straight back is a NEW call, and leaving the
// key behind would swallow it for the rest of the window.
function _endByKey(key) {
  if (!key) return false;
  const before = callState.active.length;
  callState.active = callState.active.filter(c => c.key !== key);
  callState.recent.delete(key);
  if (callState.active.length === before) return false;
  _broadcast();
  _rearm();
  return true;
}

module.exports = {
  RING_TIMEOUT_MS, DEDUPE_MS, MAX_ACTIVE, _settings, enabled, _broadcast, _rearm, _expire,
  _pruneRecent, _ring, PUSH_TITLE, _notifyAway, _endByKey,
};
