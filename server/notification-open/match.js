'use strict';
// Which open window belongs to the app a notification came from. Pure: the
// window list is the one /windows already returns ({ id, app, title, … }, `app`
// being the process name), the notification is the feed item winnotif.js
// projects ({ app: display name, aumid, desktopEntry }).
//
// Nothing here is exact, because Windows does not say which process posted a
// toast. What it does give is the AppUserModelID ("com.squirrel.Discord.Discord",
// "Chrome", "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App",
// "{6D809377-…}\Mozilla Firefox\firefox.exe") and a display name ("Discord",
// "Google Chrome"). A window counts when its process name is one of the AUMID's
// words, or the display name, or shares a long enough start with one of them.
// A miss is not an error: the caller then starts the app by its AUMID, which
// brings a single-instance app's window forward anyway.

// AUMID words that name a vendor, a packaging tool or a file type, never an app.
const GENERIC = new Set(['com', 'org', 'net', 'app', 'apps', 'exe', 'www', 'inc', 'corp', 'microsoft',
  'windows', 'squirrel', 'desktop', 'client', 'electron', 'program', 'files', 'x86', 'x64']);
// Processes that host other apps' windows, so their name says nothing.
const HOSTS = new Set(['applicationframehost', 'explorer', 'shellexperiencehost', 'searchhost', 'runtimebroker']);

const MIN_SCORE = 2;

function norm(value) {
  return String(value || '').toLowerCase().replace(/\.exe$/, '').replace(/[^a-z0-9]/g, '');
}

// The AUMID's words: the package family before "!", without its publisher
// hash, split on anything that is not a letter or a digit.
function aumidWords(aumid) {
  const head = String(aumid || '').toLowerCase().split('!')[0].replace(/_[a-z0-9]{13}$/, '');
  return head.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERIC.has(w));
}

function sharedStart(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function score(proc, words, name) {
  if (proc.length < 3 || HOSTS.has(proc)) return 0;
  if (words.includes(proc) || (name && name === proc)) return 3;
  const near = (w) => w.length >= 4 && sharedStart(w, proc) >= Math.min(6, w.length, proc.length);
  if (words.some(near)) return 2;
  if (name.length >= 4 && proc.length >= 4 && (name.includes(proc) || proc.includes(name))) return 2;
  return 0;
}

// The best window for `item`, or null. Ties keep the list's own order, which
// puts the window in front first.
function matchWindow(windows, item) {
  const list = Array.isArray(windows) ? windows : [];
  const it = item && typeof item === 'object' ? item : {};
  const words = [...aumidWords(it.aumid), ...aumidWords(it.desktopEntry)];
  const name = norm(it.app);
  if (!words.length && !name) return null;
  let best = null;
  let bestScore = 0;
  for (const w of list) {
    if (!w || typeof w.id !== 'string' || !/^\d{1,24}$/.test(w.id)) continue;
    const s = score(norm(w.app), words, name);
    if (s > bestScore) { best = w; bestScore = s; }
  }
  return bestScore >= MIN_SCORE ? best : null;
}

// An AUMID that may be handed to `explorer.exe shell:AppsFolder\<aumid>`: a
// packaged app (Family!App), an explicit id ("com.squirrel.Discord.Discord"),
// or a known-folder path ("{GUID}\Mozilla Firefox\firefox.exe"). No quotes,
// commas, slashes or "..", so explorer reads it as one Apps-folder item.
const AUMID_RE = /^(?:[\w.-]+(?:![\w.-]+)?|\{[0-9A-Fa-f-]{36}\}(?:\\[\w .()-]+)+)$/;
function isLaunchableAumid(value) {
  const s = String(value || '');
  return s.length > 0 && s.length <= 200 && AUMID_RE.test(s) && !s.includes('..');
}

// A freedesktop desktop-entry id ("org.telegram.desktop"), as the Notify hint gives it.
function isDesktopEntryId(value) {
  return /^[A-Za-z0-9][\w.-]{0,119}$/.test(String(value || '')) && !String(value).includes('..');
}

module.exports = { matchWindow, aumidWords, isLaunchableAumid, isDesktopEntryId, norm, MIN_SCORE };
