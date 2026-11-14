'use strict';
// What can be done with a ringing call from the dashboard, per app and system, and the call as
// the page sees it.

const callDetect = require('../call-detect.js');

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

module.exports = { comboFor, entryFor, capabilitiesFor, projectCall };
