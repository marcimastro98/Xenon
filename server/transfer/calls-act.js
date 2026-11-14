'use strict';
// What a tap on a call card does: answer, decline or hang up, by bringing the calling app
// forward and sending it the key, or by asking the phone.

const callDetect = require('../call-detect.js');
const { comboFor, entryFor } = require('./call-capabilities.js');
const { callState } = require('./calls-state.js');
const { _settings, _broadcast, _rearm } = require('./calls-ring.js');

const FOCUS_SETTLE_MS = 220;     // let the window actually come forward before the key

function _find(id) { return callState.active.find(c => c.id === String(id || '')) || null; }

function _drop(id) {
  const before = callState.active.length;
  callState.active = callState.active.filter(c => c.id !== id);
  if (callState.active.length !== before) { _broadcast(); _rearm(); }
}

// Bring the app's window forward. Matching is by the same `match` list the
// classifier uses, checked against the window's process name AND its title,
// because an Electron app reports a generic process name on some platforms.
async function _focusApp(call) {
  if (!callState.deps || typeof callState.deps.listWindows !== 'function' || typeof callState.deps.focusWindow !== 'function') {
    return { ok: false, error: 'no_window_tool' };
  }
  const entry = entryFor(call.appId, _settings().apps);
  const needles = (entry && Array.isArray(entry.match) ? entry.match : [])
    .map(m => callDetect.foldText(m)).filter(Boolean);
  if (!needles.length) return { ok: false, error: 'no_match_rule' };

  let list = [];
  try {
    const r = await callState.deps.listWindows();
    list = Array.isArray(r && r.windows) ? r.windows : [];
  } catch { return { ok: false, error: 'window_list_failed' }; }

  const hit = list.find((w) => {
    const hay = callDetect.foldText(String((w && w.app) || '') + ' ' + String((w && w.title) || ''));
    return hay && needles.some(n => hay.includes(n));
  });
  if (!hit || !hit.id) return { ok: false, error: 'window_not_found' };

  try {
    const r = await callState.deps.focusWindow(String(hit.id));
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
    platform: (callState.deps && callState.deps.platform) || process.platform,
    video: !!call.video,
  });
  if (!keys) return { ok: false, error: 'no_shortcut' };
  const focused = await _focusApp(call);
  if (!focused.ok) return focused;
  await new Promise(r => setTimeout(r, FOCUS_SETTLE_MS));
  if (typeof callState.deps.sendHotkey !== 'function') return { ok: false, error: 'hotkey_unavailable' };
  try {
    const r = await callState.deps.sendHotkey(keys);
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
    // The paired phone. Nothing is focused and no key is sent: the platform
    // that allows this owns the call, so answering is one call into it. The
    // card is only dropped once that came back ok — a failed answer must leave
    // the ring on screen, because the phone is still ringing.
    if (call.source === 'phone') {
      if (typeof callState.deps.phoneAnswer !== 'function') return { ok: false, error: 'unavailable' };
      let r;
      try { r = await callState.deps.phoneAnswer(); }
      catch { return { ok: false, error: 'phone_failed' }; }
      if (!r || r.ok === false) return { ok: false, error: (r && r.error) || 'phone_failed' };
      _drop(call.id);
      return { ok: true };
    }
    if (call.source === 'discord') {
      if (typeof callState.deps.discordJoin !== 'function') return { ok: false, error: 'discord_unavailable' };
      let r;
      try { r = await callState.deps.discordJoin(call.channelId); }
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
    if (call.source === 'phone') {
      if (typeof callState.deps.phoneHangUp !== 'function') return { ok: false, error: 'unavailable' };
      let r;
      try { r = await callState.deps.phoneHangUp(); }
      catch { return { ok: false, error: 'phone_failed' }; }
      if (!r || r.ok === false) return { ok: false, error: (r && r.error) || 'phone_failed' };
      _drop(call.id);
      return { ok: true };
    }
    const r = await _sendToApp(call, 'decline');
    if (r.ok) _drop(call.id);
    return r;
  }

  return { ok: false, error: 'bad_action' };
}

module.exports = { FOCUS_SETTLE_MS, _find, _drop, _focusApp, _sendToApp, act };
