'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Incoming-call classifier — PURE, no I/O, unit-tested.
//
// Two things can tell us a call is ringing, and they are not equally good.
//
//  1. Discord's RPC NOTIFICATION_CREATE. It carries the `channel_id` and the
//     message object, so a message of type 3 (CALL) IS a ringing call, in any
//     language, and the channel id it hands over is exactly what answering
//     needs. This is the only structural signal we have anywhere.
//
//  2. A mirrored OS notification. This one is a HEURISTIC and is written down
//     as such, because the alternative was measured and does not exist:
//     Windows' UserNotificationListener exposes only AppInfo / CreationTime /
//     Id / Visual.Bindings, and a binding gives Template ('ToastGeneric'),
//     an empty Hints map and GetTextElements(). `Notification.Content` is null,
//     so the toast XML — and with it `scenario="incomingCall"`, the one
//     language-independent marker Windows has — never reaches us. Neither do
//     the toast's own buttons, which is why nothing here can "press Accept".
//     So identifying a call from a notification means: the app is one the user
//     put on the list, AND the text reads like a ring in one of the languages
//     below.
//
// The consequence for the product is stated in the UI rather than hidden: for
// everything but Discord this is pattern matching, it can miss a call and it
// can occasionally fire on a message that merely mentions a call. That is why
// the card it raises is always dismissible and never does anything by itself.
//
// Capabilities (can we answer? can we decline?) are deliberately NOT decided
// here — they depend on the platform and on what is installed, so they belong
// to calls.js. This module only answers "is this a call, and from whom".
// ─────────────────────────────────────────────────────────────────────────

// Discord message type 3 = CALL. A DM call writes one of these into the
// channel, so it is what a ringing call looks like on the RPC feed.
const DISCORD_MESSAGE_TYPE_CALL = 3;

const { RING_PHRASES, NOT_RINGING, VIDEO_PHRASES } = require('./transfer/call-phrases.js');

const { DEFAULT_APPS } = require('./transfer/call-apps.js');

// ── Text folding ────────────────────────────────────────────────────────────

// Lowercase, strip diacritics, collapse whitespace and punctuation to single
// spaces. Diacritics go because a toast may or may not carry them ("está" vs
// "esta") and matching must not depend on which; CJK and Cyrillic are left
// alone by NFD/combining-mark removal, so their phrases above still work.
function foldText(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function containsAny(folded, phrases) {
  for (const p of phrases) {
    // The phrase list is authored folded already for latin scripts; folding it
    // again is cheap and keeps a stray accent in the source from silently
    // disabling one entry.
    if (folded.includes(foldText(p))) return true;
  }
  return false;
}

// Does this text read like a call that is ringing RIGHT NOW?
function looksLikeRing(text) {
  const folded = foldText(text);
  if (!folded) return false;
  if (containsAny(folded, NOT_RINGING)) return false;   // over/missed wins
  return containsAny(folded, RING_PHRASES);
}

function looksLikeVideo(text) {
  return containsAny(foldText(text), VIDEO_PHRASES);
}

// ── App matching ────────────────────────────────────────────────────────────

// Find the configured app a notification belongs to. `extraApps` are the
// user's own entries (already validated by the settings normalizer) and are
// checked FIRST so a user can override a default for an app we guessed wrong.
function matchApp(item, extraApps) {
  const hay = foldText(String((item && item.aumid) || '') + ' ' + String((item && item.app) || ''));
  if (!hay) return null;
  const lists = [Array.isArray(extraApps) ? extraApps : [], DEFAULT_APPS];
  for (const list of lists) {
    for (const app of list) {
      const match = Array.isArray(app && app.match) ? app.match : [];
      for (const m of match) {
        const needle = foldText(m);
        if (needle && hay.includes(needle)) return app;
      }
    }
  }
  return null;
}

// ── Caller extraction ───────────────────────────────────────────────────────

// Which of the two text fields is the person, and which is the "Incoming call"
// line? The apps disagree: Teams puts the caller in the title and the phrase in
// the body, Zoom puts "Zoom" in the title and the whole sentence in the body.
// So: whichever field does NOT read like a ring is the caller, and when the
// phrase is inside the caller's own line it is trimmed off the ends.
function callerFrom(item, app) {
  const title = String((item && item.title) || '').trim();
  const body = String((item && item.body) || '').trim();
  const appName = String((app && app.name) || '').trim();
  const sameAsApp = (s) => !!s && !!appName && foldText(s) === foldText(appName);

  let caller = '';
  let detail = '';
  if (title && !looksLikeRing(title) && !sameAsApp(title)) {
    caller = title;
    detail = body;
  } else if (body && !looksLikeRing(body)) {
    caller = body;
    detail = title;
  } else {
    // Both lines read like a ring (or the only one that does not is the app's
    // own name): the caller is inside the ringing sentence. Strip the phrase
    // and keep what is left, which is the name in every layout seen.
    const src = body || title;
    caller = stripRingPhrase(src);
    detail = src === body ? title : body;
  }
  caller = caller.replace(/\s+/g, ' ').trim().slice(0, 120);
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (sameAsApp(caller)) caller = '';
  return { caller, detail };
}

// Remove a ring phrase from a sentence so "Marco is calling you" leaves "Marco".
// Works on the ORIGINAL text (not the folded one) so the name keeps its accents
// and case; the phrase is located by folding a sliding window of the same
// length, which avoids having to write a regex per language.
function stripRingPhrase(text) {
  const src = String(text == null ? '' : text).trim();
  if (!src) return '';
  const folded = foldText(src);
  for (const p of RING_PHRASES) {
    const needle = foldText(p);
    if (!needle || !folded.includes(needle)) continue;
    // Map back approximately: cut the same number of words the phrase has from
    // whichever end of the sentence it sits on. Word counts survive folding,
    // character offsets do not.
    const words = src.split(/\s+/);
    const phraseWords = needle.split(' ').length;
    const head = foldText(words.slice(0, phraseWords).join(' '));
    if (head === needle) return words.slice(phraseWords).join(' ').trim();
    const tail = foldText(words.slice(-phraseWords).join(' '));
    if (tail === needle) return words.slice(0, -phraseWords).join(' ').trim();
    // The phrase is in the middle: keep the longer side, which is the name in
    // layouts like "Ora: Marco ti sta chiamando".
    const idx = words.findIndex((_, i) => foldText(words.slice(i, i + phraseWords).join(' ')) === needle);
    if (idx > 0) {
      const before = words.slice(0, idx).join(' ').trim();
      const after = words.slice(idx + phraseWords).join(' ').trim();
      return before.length >= after.length ? before : after;
    }
  }
  return src;
}

// ── Classification ──────────────────────────────────────────────────────────

// A mirrored OS notification → a call descriptor, or null.
// `apps` is the user's extra app list; `allowed` is the set of app ids the user
// left enabled (absent = all defaults enabled).
function classifyNotification(item, opts) {
  if (!item || typeof item !== 'object') return null;
  const o = opts && typeof opts === 'object' ? opts : {};
  const app = matchApp(item, o.apps);
  if (!app) return null;
  if (Array.isArray(o.allowed) && !o.allowed.includes(app.id)) return null;

  const title = String(item.title || '');
  const body = String(item.body || '');
  if (!looksLikeRing(title + ' \n ' + body)) return null;

  const { caller, detail } = callerFrom(item, app);
  return {
    source: 'notification',
    appId: app.id,
    appName: app.name || String(item.app || ''),
    caller,
    detail,
    video: looksLikeVideo(title + ' ' + body),
    channelId: '',
    icon: typeof item.icon === 'string' ? item.icon : '',
    // Dedupe key: the same ring re-announced (a second toast, a re-seed after a
    // dashboard reopen) must not raise a second card. The caller is part of it
    // so a genuinely different person calling during the same minute does.
    key: 'n:' + app.id + ':' + foldText(caller),
  };
}

// A Discord RPC NOTIFICATION_CREATE → a call descriptor, or null.
//
// `messageType === 3` is the structural path and needs no text at all. It is
// also the part that has never been observed on a live ring here (Discord was
// not linked on the machine this was written on), so the text path is kept as
// the fallback rather than the primary: if Discord does fire the event with a
// CALL message we take the good route, and if it only ever fires a worded one
// we still raise the card.
function classifyDiscord(notif, opts) {
  if (!notif || typeof notif !== 'object') return null;
  const o = opts && typeof opts === 'object' ? opts : {};
  if (Array.isArray(o.allowed) && !o.allowed.includes('discord')) return null;

  const structural = Number(notif.messageType) === DISCORD_MESSAGE_TYPE_CALL;
  const title = String(notif.title || '');
  const body = String(notif.body || '');
  if (!structural && !looksLikeRing(title + ' \n ' + body)) return null;
  // Even on the structural path, a CALL message is also written when a call
  // ENDS. The wording is the only thing that separates the two, so it still has
  // a veto.
  if (containsAny(foldText(title + ' ' + body), NOT_RINGING)) return null;

  const { caller, detail } = callerFrom({ title, body }, { name: 'Discord' });
  const channelId = typeof notif.channelId === 'string' ? notif.channelId : '';
  return {
    source: 'discord',
    appId: 'discord',
    appName: 'Discord',
    caller,
    detail,
    video: looksLikeVideo(title + ' ' + body),
    channelId,
    icon: typeof notif.icon === 'string' ? notif.icon : '',
    structural,
    // The channel is the identity of a Discord ring: two calls from the same
    // channel are the same call, and it is also what answering needs.
    key: 'd:' + (channelId || foldText(caller)),
  };
}

// ── The END of a ring ───────────────────────────────────────────────────────
// The classifiers above REFUSE an "ended" or "missed" notification, which stops
// a card appearing for a call nobody can take. That is necessary and it is not
// enough: an end notification is also the only thing that ever tells us a ring
// we already raised is over. Without reading it, a card sits there until its
// timeout even though the caller hung up ten seconds in — which is exactly what
// a real Discord call looked like.
//
// So the same text gets read twice, for two different purposes: as a veto when
// deciding whether to ring, and as a signal when deciding whether to stop. Both
// return the dedupe KEY of the call they refer to, so calls.js can drop it
// without knowing anything about wording.

// A Discord notification that says a call in this channel is over → its key.
function discordCallEnded(notif) {
  if (!notif || typeof notif !== 'object') return '';
  const channelId = typeof notif.channelId === 'string' ? notif.channelId : '';
  if (!channelId) return '';
  const text = String(notif.title || '') + ' ' + String(notif.body || '');
  if (!containsAny(foldText(text), NOT_RINGING)) return '';
  return 'd:' + channelId;
}

// The same for a mirrored OS notification: a "missed call" or "call ended"
// toast from an app we are currently ringing for.
function notificationCallEnded(item, opts) {
  if (!item || typeof item !== 'object') return '';
  const o = opts && typeof opts === 'object' ? opts : {};
  const app = matchApp(item, o.apps);
  if (!app) return '';
  const text = String(item.title || '') + ' ' + String(item.body || '');
  if (!containsAny(foldText(text), NOT_RINGING)) return '';
  // The caller's name is in the same place it was for the ring, so the key
  // matches the one the ring produced.
  const { caller } = callerFrom(item, app);
  return 'n:' + app.id + ':' + foldText(caller);
}

module.exports = {
  DEFAULT_APPS,
  discordCallEnded,
  notificationCallEnded,
  DISCORD_MESSAGE_TYPE_CALL,
  RING_PHRASES,
  NOT_RINGING,
  foldText,
  looksLikeRing,
  looksLikeVideo,
  matchApp,
  callerFrom,
  stripRingPhrase,
  classifyNotification,
  classifyDiscord,
};
