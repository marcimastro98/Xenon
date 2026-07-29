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

// Text that means "somebody is calling you", in the 11 languages the dashboard
// itself speaks — the user's OS and chat apps are overwhelmingly in one of
// them. Compared against a folded form of title+body (see foldText).
//
// Every phrase here has to be specific to a RING. "call" and "chiamata" alone
// are not: "missed call", "chiamata persa" and "call ended" would all match and
// each of those is the exact moment a card must NOT appear. So the misses are
// listed too and win over the hits (see NOT_RINGING).
const RING_PHRASES = [
  // en
  'incoming call', 'incoming video call', 'incoming audio call',
  'is calling you', 'is calling', 'calling you', 'wants to talk',
  // it
  'chiamata in arrivo', 'videochiamata in arrivo', 'ti sta chiamando',
  'sta chiamando', 'ti chiama',
  // es
  'llamada entrante', 'videollamada entrante', 'te esta llamando',
  'esta llamando', 'llamada de video entrante',
  // fr
  'appel entrant', 'appel video entrant', 'vous appelle', 't appelle',
  // de
  'eingehender anruf', 'eingehender videoanruf', 'ruft dich an', 'ruft an',
  // pt
  'chamada recebida', 'chamada a receber', 'esta a ligar', 'esta ligando',
  'videochamada recebida',
  // nl
  'inkomende oproep', 'inkomend videogesprek', 'belt je', 'belt u',
  // ru
  'входящий вызов', 'входящий звонок', 'звонит вам', 'вам звонит',
  // ja
  '着信', '通話の呼び出し', 'から電話',
  // ko
  '수신 전화', '전화가 왔습니다', '통화 요청', '전화 왔어요',
  // zh
  '来电', '呼叫你', '视频通话邀请', '正在呼叫',
];

// Phrases that mean the call is OVER or never connected. Checked first: a
// "missed call" toast contains "call" in every language and is the single most
// common way a naive matcher raises a card for a call nobody can answer.
const NOT_RINGING = [
  // en
  'missed call', 'missed a call', 'call ended', 'call declined', 'you missed',
  'no answer', 'call back', 'voicemail', 'left a message',
  // it
  'chiamata persa', 'chiamata terminata', 'chiamata rifiutata', 'hai perso',
  'richiama', 'segreteria',
  // es
  'llamada perdida', 'llamada finalizada', 'llamada rechazada', 'buzon de voz',
  // fr
  'appel manque', 'appel termine', 'appel refuse', 'messagerie vocale',
  // de
  'verpasster anruf', 'anruf beendet', 'anruf abgelehnt', 'mailbox',
  // pt
  'chamada perdida', 'chamada terminada', 'chamada recusada', 'correio de voz',
  // nl
  'gemiste oproep', 'oproep beeindigd', 'oproep geweigerd', 'voicemail',
  // ru
  'пропущенный вызов', 'пропущенный звонок', 'вызов завершен', 'звонок завершен',
  // ja
  '不在着信', '通話終了', '着信を逃しました',
  // ko
  '부재중 전화', '통화 종료', '전화를 놓쳤',
  // zh
  '未接来电', '通话已结束', '已拒接',
];

// A video ring, so the card can pick the right verb and (for Teams) the right
// accept shortcut — Teams has one key for audio and a different one for video.
const VIDEO_PHRASES = [
  'video call', 'video', 'videochiamata', 'videollamada', 'videoanruf',
  'videochamada', 'videogesprek', 'видеозвонок', 'ビデオ通話', '영상 통화', '视频通话',
];

// ── The apps we ship a default entry for ────────────────────────────────────
// `match` is checked against BOTH the AUMID and the display name of the toast,
// folded and substring-matched, because a Win32 app's AUMID is often its exe
// path while a packaged app's is a PFN — and the display name is localised.
//
// `answer`/`decline` name a KEY COMBO plus the fact that the app window has to
// be focused first. That last part is not a detail: Zoom's own documentation
// lists which shortcuts may be promoted to global ones and the call shortcuts
// are NOT among them, and Teams' are plain in-app shortcuts. So "answer" is
// always focus-then-send, never send-and-hope.
//
// `mac` overrides the combo on macOS where the app differs there: Teams moves
// to Command, Zoom stays on Control. Getting that backwards sends a working
// shortcut to the wrong app, so both are written out rather than derived.
const DEFAULT_APPS = Object.freeze([
  Object.freeze({
    id: 'teams',
    name: 'Microsoft Teams',
    match: Object.freeze(['msteams', 'ms-teams', 'microsoft teams', 'teams.exe', 'microsoftteams']),
    answer: Object.freeze({ keys: 'ctrl+shift+s', mac: 'cmd+shift+s' }),
    answerVideo: Object.freeze({ keys: 'ctrl+shift+a', mac: 'cmd+shift+a' }),
    decline: Object.freeze({ keys: 'ctrl+shift+d', mac: 'cmd+shift+d' }),
  }),
  Object.freeze({
    id: 'zoom',
    name: 'Zoom',
    match: Object.freeze(['zoom.us', 'zoom.exe', 'zoom meetings', 'zoom workplace']),
    answer: Object.freeze({ keys: 'ctrl+shift+a', mac: 'ctrl+shift+a' }),
    decline: Object.freeze({ keys: 'ctrl+shift+d', mac: 'ctrl+shift+d' }),
  }),
  Object.freeze({
    id: 'discord',
    name: 'Discord',
    match: Object.freeze(['discord']),
    // Answering is the RPC join, not a shortcut — see calls.js. Kept in the
    // table so a Discord toast on a machine with RPC unlinked still raises a
    // card the user can act on by opening the app.
  }),
  Object.freeze({
    id: 'phonelink',
    name: 'Phone Link',
    match: Object.freeze(['phonelink', 'phone link', 'collegamento al telefono', 'yourphone']),
    // No API and no shortcut. The card can only ring and open the app.
    //
    // `phoneMirror` says this app is a WINDOW onto the phone rather than a
    // place a call lives. It matters since the phone feature landed: the OS now
    // tells us structurally that the phone is ringing, and that fact arrives
    // without a caller's name while this toast arrives with one. So a toast
    // from a mirror app does not raise a second card for the same call — it
    // fills in the name on the one already ringing. See calls.onNotification.
    phoneMirror: true,
  }),
  Object.freeze({
    id: 'whatsapp',
    name: 'WhatsApp',
    match: Object.freeze(['whatsapp']),
  }),
  Object.freeze({
    id: 'slack',
    name: 'Slack',
    match: Object.freeze(['slack']),
  }),
  Object.freeze({
    id: 'meet',
    name: 'Google Meet',
    match: Object.freeze(['meet.google.com', 'google meet']),
  }),
]);

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
