// Which start-up cards were already seen (What is New, invites, support asks), and waiting until
// they may show.
'use strict';

// ── "Don't show again" for the two startup cards ────────────────────────────
// The What's New modal (js/update.js) and the Discord invite card
// (js/discord-invite.js) each carry a permanent dismissal. Until v4.11.6 both
// flags lived ONLY in localStorage, which had two consequences the user never
// agreed to:
//
//   1. The choice was exactly as durable as the browser's site data. Chrome and
//      Edge's "clear cookies and site data when you close all windows", the
//      Firefox equivalent, a private window, or any cleanup tool wiped it — so
//      both cards came back at EVERY boot with "don't show again" already
//      pressed, which is what was reported on Discord.
//   2. It never crossed surfaces. The native WebView and a real browser are
//      separate stores even on the identical `127.0.0.1:3030` URL, so somebody
//      running both had to dismiss each card twice without being told why.
//
// So the flags now live in hub settings, which is a file on the PC. This is the
// same move hubMessages/catalogDrops made in v4.9.0 and it keeps that module's
// two rules, which are what make the migration safe:
//
//   * READ either source. A dismissal already on this device keeps holding even
//     before it has been promoted, and a server save that never lands still
//     silences the card here.
//   * WRITE both. If the save never reaches the server — offline, a restart
//     mid-queue — the dismissal must still hold on the device the user pressed
//     it on, which is the failure this whole change is about.
//
// Whether the flags belong to the user or to the screen is the question that
// decides where they live, and here it is not close: "I have read the 4.11
// announcement" is a fact about the person. Contrast the tile layout
// (PhoneView's PREF_KEY), which stays per-device on purpose — that one really
// does have a different right answer on the Edge, on a phone and on a monitor.
const LEGACY_CARD_KEYS = {
  whatsNewSeen: 'xenon.whatsnew.dismissed',        // held the release id
  discordInviteSeen: 'xenonedge.discordInvite.v1', // held the string 'dismissed'
};

function legacyCardFlag(key) {
  try { return localStorage.getItem(LEGACY_CARD_KEYS[key]) || ''; } catch { return ''; }
}

// A predicate rather than a getter, deliberately: with two sources there would
// otherwise be a "which one wins" question to answer on every read, and the
// wrong answer re-opens a modal the user closed. Dismissed on EITHER is
// dismissed — no ordering to get wrong.
function whatsNewDismissed(id) {
  const want = String(id || '').trim();
  if (!want) return false;
  if (hubSettings && hubSettings.whatsNewSeen === want) return true;
  return legacyCardFlag('whatsNewSeen') === want;
}

function rememberWhatsNewSeen(id) {
  const want = String(id || '').trim().slice(0, 64);
  if (!want) return;
  try { localStorage.setItem(LEGACY_CARD_KEYS.whatsNewSeen, want); } catch { /* ignore */ }
  if (hubSettings && hubSettings.whatsNewSeen === want) return;   // nothing to save
  hubSettings = normalizeSettings({ ...hubSettings, whatsNewSeen: want });
  saveHubSettings();
}

// The server owns these two (POST /update/notice-seen): the alerts window of
// "widgets only" cannot save settings, and every surface must agree on them.
// The local copy moves at once so the same page does not ask twice.
function rememberUpdateNotice(seen) {
  const local = {};
  if (seen.notes) local.releaseNotesSeen = seen.notes;
  if (seen.failedAt) local.updateFailSeen = String(seen.failedAt);
  hubSettings = normalizeSettings({ ...hubSettings, ...local });
  return fetch(SERVER + '/update/notice-seen', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seen),
  }).catch(() => { /* the server is restarting: the notice simply comes back */ });
}

function discordInviteDismissed() {
  if (hubSettings && hubSettings.discordInviteSeen === true) return true;
  return legacyCardFlag('discordInviteSeen') === 'dismissed';
}

// The one-time supporter ask. Unlike the two cards above there is no legacy
// localStorage key to promote: it ships straight into hub settings, because the
// whole point is that it happens ONCE in the life of an install and a cleared
// browser store must not bring it back.
function supportAskDismissed() {
  return !!(hubSettings && hubSettings.supportAskSeen === true);
}

// The day rides along so the December appeal can keep a month between the two.
function rememberSupportAskSeen() {
  if (hubSettings && hubSettings.supportAskSeen === true) return;
  hubSettings = normalizeSettings({ ...hubSettings, supportAskSeen: true, supportAskSeenDay: toDateInputValue(new Date()) });
  saveHubSettings();
}

// The December appeal (js/support-appeal.js): the last year it was shown, and
// the day the one-time ask went away ('' when that predates the field).
// "I already support Xenon", on either card, is an answer for good: the year the
// appeal stays away through becomes the last one the field can hold.
const SUPPORT_APPEAL_NEVER = 9999;

function supportAppealYear() {
  return Math.max(0, Math.floor(Number(hubSettings && hubSettings.supportAppealYear) || 0));
}

function supportAskSeenDay() {
  return (hubSettings && hubSettings.supportAskSeenDay) || '';
}

function rememberSupportAppeal(year) {
  const y = Math.min(SUPPORT_APPEAL_NEVER, Math.floor(Number(year) || 0));
  if (y <= supportAppealYear()) return;
  hubSettings = normalizeSettings({ ...hubSettings, supportAppealYear: y });
  saveHubSettings();
}

function silenceSupportAppeal() {
  rememberSupportAppeal(SUPPORT_APPEAL_NEVER);
}

// The share invitation (js/share-nudge.js): same shape, same home on disk.
function shareNudgeDismissed() {
  return !!(hubSettings && hubSettings.shareNudgeSeen === true);
}

function rememberShareNudgeSeen() {
  if (hubSettings && hubSettings.shareNudgeSeen === true) return;
  hubSettings = normalizeSettings({ ...hubSettings, shareNudgeSeen: true });
  saveHubSettings();
}

// How long this install has been used, for the ask's own gate. Answers null
// until the server copy has landed: before that the numbers are a blind local
// mirror, and on a device whose site data is cleared every exit that mirror
// reads as a brand-new install — which is exactly when the card must NOT go up.
function usageHistory() {
  if (!_hubHydratedFromServer) return null;
  return {
    firstRunDay: (hubSettings && hubSettings.firstRunDay) || '',
    usageDays: Math.max(0, Math.floor(Number(hubSettings && hubSettings.usageDays) || 0)),
  };
}

function rememberDiscordInviteSeen() {
  try { localStorage.setItem(LEGACY_CARD_KEYS.discordInviteSeen, 'dismissed'); } catch { /* ignore */ }
  if (hubSettings && hubSettings.discordInviteSeen === true) return;
  hubSettings = normalizeSettings({ ...hubSettings, discordInviteSeen: true });
  saveHubSettings();
}

// One-time promotion of the pre-v4.11.6 per-device flags, in the same shape as
// the Gemini-key migration in the hydrate path: read the legacy value, and push
// it up only when the SERVER has nothing. Once the server holds a value this can
// never fire again, so a dismissal made on another surface is never overwritten
// by a stale local one.
//
// Must run AFTER hydration — before it, hubSettings is still the blind local
// copy and "the server has nothing" cannot be told apart from "we have not
// asked yet", which would push a stale value over a good one.
function promoteLegacySeenFlags() {
  const wn = legacyCardFlag('whatsNewSeen').trim().slice(0, 64);
  if (wn && !(hubSettings && hubSettings.whatsNewSeen)) rememberWhatsNewSeen(wn);
  if (legacyCardFlag('discordInviteSeen') === 'dismissed' && !(hubSettings && hubSettings.discordInviteSeen === true)) {
    rememberDiscordInviteSeen();
  }
}

// Both cards must decide whether to appear only once the stored answer is known,
// and that is NOT true at DOMContentLoaded: hydration is a fetch. Before it
// lands, hubSettings is the blind local mirror — which on the very machines this
// change is for (site data cleared on exit) is empty, so a card whose dismissal
// is safely on disk would flash up anyway, which is the bug wearing a hat.
//
// The wait is bounded. If the server never answers — it is still starting, the
// dashboard is open against a backend that died — the cards go up with whatever
// is known locally, because a dashboard that silently drops its announcements
// because a fetch hung is a worse failure than one shown a second time.
const STARTUP_CARD_WAIT_MS = 5000;
let _startupCardWaiters = [];
let _startupCardTimer = null;

function flushStartupCardWaiters() {
  if (_startupCardTimer) { clearTimeout(_startupCardTimer); _startupCardTimer = null; }
  const waiters = _startupCardWaiters;
  _startupCardWaiters = [];
  for (const fn of waiters) { try { fn(); } catch { /* one card must not break the other */ } }
}

function whenStartupCardsReady(fn) {
  if (typeof fn !== 'function') return;
  // A startup card belongs to the dashboard: in a layer or the menu's window it
  // sat over whatever the person had just opened.
  if (typeof isLayerPage === 'function' && isLayerPage()) return;
  if (_hubHydratedFromServer) { fn(); return; }
  _startupCardWaiters.push(fn);
  if (!_startupCardTimer) _startupCardTimer = setTimeout(flushStartupCardWaiters, STARTUP_CARD_WAIT_MS);
}
