'use strict';
// Cleans one message the Xenon hub publishes before the app shows it: who it is for, its
// button, its picture or video, its poll, and the allowed hosts for each.

const MAX_MESSAGES = 50;

// Ids become DOM anchors and dedup keys in the shared seen-set, so they use the
// catalog's charset: no traversal, no interpolation surprises.
const MESSAGE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
const VERSION_RE = /^[0-9]+(\.[0-9]+)*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const OS_RE = /^[a-z0-9_]{1,16}$/;      // matches the version-ping os token charset
const LANG_RE = /^[a-z]{2}$/;

// How loudly a message may present itself. `toast` is the default on purpose:
// a channel whose default is a modal becomes a channel nobody wants installed.
const LEVELS = new Set(['toast', 'modal']);
const WHERE = new Set(['corner', 'stage']);

// What the call-to-action may do. `store` opens the Store on `entryId` through
// the normal import boundary; `url` opens an external link; `dismiss` just closes.
const ACTION_TYPES = new Set(['store', 'url', 'dismiss']);

// Hosts a message may link to. Deliberately short: this feed is the one place a
// remote document can put a link on the dashboard, and an open host list would
// make it a redirect service. Anything else degrades to a plain message with no
// button rather than being rendered as an unclickable link.
const LINK_HOSTS = new Set([
  'xenon-app.com', 'www.xenon-app.com',
  'github.com', 'www.github.com',
  'discord.gg', 'discord.com', 'www.discord.com',
]);

// Where a message may load a picture or a clip from. One host, the project's own
// R2 asset origin — the same one the gallery already pulls screenshots from. The
// reasoning is LINK_HOSTS', only stricter: a link asks the user to follow it, a
// media URL is fetched by the dashboard the moment the card opens, so an open
// host list would turn the feed into a beacon that reports when each install
// read its announcements. The console uploads the file here rather than taking a
// URL, so there is nothing for an author to get wrong.
const MEDIA_HOSTS = new Set(['assets.xenon-app.com']);
const MEDIA_IMAGE_EXT = /\.(webp|png|jpe?g|gif)$/i;
const MEDIA_VIDEO_EXT = /\.(mp4|webm)$/i;
const MEDIA_TYPES = new Set(['image', 'video']);
const MEDIA_ALT_MAX = 120;

const MAX_MATCH_ENTRIES = 20;
const MAX_MATCH_LIST = 8;

function cleanStr(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// A bounded list of tokens matching `re`, rebuilt element by element. Returns
// null (not []) when nothing survives, so an absent filter and an all-invalid
// filter are told apart by the caller: an all-invalid filter must NOT silently
// become "matches everyone".
function tokenList(raw, re, max, maxLen) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    // Trim, but never TRUNCATE. Cutting 'italiano' down to the 2-char cap would
    // hand the regex a valid 'it' and silently target a language nobody asked
    // for; over-length input is wrong input, not input to be shortened.
    const s = typeof item === 'string' ? item.trim() : '';
    if (!s || s.length > maxLen || !re.test(s)) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out.length ? out : null;
}

// The targeting block. Rebuilt key-by-key like every other persisted/remote
// shape in the codebase; unknown keys are dropped rather than carried through to
// the client, so a future field cannot arrive early and be acted on by an old
// dashboard that does not understand it.
//
// An empty result means "no conditions", i.e. everyone. A block that was present
// but entirely invalid returns `unsatisfiable: true` instead — the client must
// then show it to nobody. Treating a broken filter as "no filter" would send a
// message meant for a handful of installs to every user, which is the one
// mistake this feed cannot take back.
function normalizeMatch(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return { unsatisfiable: true };

  const out = {};
  const minVersion = cleanStr(raw.minVersion, 20);
  if (minVersion) {
    if (!VERSION_RE.test(minVersion)) return { unsatisfiable: true };
    out.minVersion = minVersion;
  }
  const maxVersion = cleanStr(raw.maxVersion, 20);
  if (maxVersion) {
    if (!VERSION_RE.test(maxVersion)) return { unsatisfiable: true };
    out.maxVersion = maxVersion;
  }
  if (raw.os !== undefined) {
    const os = tokenList(raw.os, OS_RE, MAX_MATCH_LIST, 16);
    if (!os) return { unsatisfiable: true };
    out.os = os;
  }
  if (raw.lang !== undefined) {
    const lang = tokenList(raw.lang, LANG_RE, MAX_MATCH_LIST, 2);
    if (!lang) return { unsatisfiable: true };
    out.lang = lang;
  }
  if (raw.hasEntry !== undefined) {
    const has = tokenList(raw.hasEntry, MESSAGE_ID_RE, MAX_MATCH_ENTRIES, 61);
    if (!has) return { unsatisfiable: true };
    out.hasEntry = has;
  }
  if (raw.supporter !== undefined) {
    if (typeof raw.supporter !== 'boolean') return { unsatisfiable: true };
    out.supporter = raw.supporter;
  }
  return Object.keys(out).length ? out : null;
}

// The call-to-action. A `url` action keeps its host allowlist here rather than
// client-side so a message can never present a button the client would refuse:
// the button either arrives valid or does not arrive.
function normalizeAction(raw, entryId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = cleanStr(raw.type, 16);
  if (!ACTION_TYPES.has(type)) return null;
  const label = cleanStr(raw.label, 40);
  if (!label) return null;

  if (type === 'dismiss') return { type, label };
  if (type === 'store') {
    // Nothing to open without an entry; the Store CTA is only meaningful when
    // the message names one.
    return entryId ? { type, label } : null;
  }
  const url = cleanStr(raw.url, 300);
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (!LINK_HOSTS.has(u.hostname.toLowerCase())) return null;
    return { type, label, url: u.toString() };
  } catch { return null; }
}

// The picture or clip shown above the text. Returns null on anything it does not
// like, and the caller keeps the message: an announcement that loses its artwork
// is still an announcement, unlike a poll that loses its options. The extension
// is checked against the declared type because that is what decides whether the
// client builds an <img> or a <video> — a .mp4 arriving as `image` would render
// as a broken picture rather than play.
function normalizeMedia(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = cleanStr(raw.type, 8);
  if (!MEDIA_TYPES.has(type)) return null;

  const url = cleanStr(raw.url, 300);
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || !MEDIA_HOSTS.has(u.hostname.toLowerCase())) return null;
  const ext = type === 'video' ? MEDIA_VIDEO_EXT : MEDIA_IMAGE_EXT;
  if (!ext.test(u.pathname)) return null;

  const media = { type, url: u.toString() };
  const alt = cleanStr(raw.alt, MEDIA_ALT_MAX);
  if (alt) media.alt = alt;
  // A poster is what fills the frame before a clip decodes, so it follows the
  // image rules whatever the media type is; on an `image` it means nothing.
  if (type === 'video') {
    const poster = cleanStr(raw.poster, 300);
    try {
      const p = new URL(poster);
      if (p.protocol === 'https:' && MEDIA_HOSTS.has(p.hostname.toLowerCase()) && MEDIA_IMAGE_EXT.test(p.pathname)) {
        media.poster = p.toString();
      }
    } catch { /* no poster is fine — the clip paints its own first frame */ }
  }
  return media;
}

// A poll: the message's title/body asks the question, these are the answers.
// Two to five options — one is not a question, and more than five is a survey
// that does not belong on a dashboard tile. An option's id is what gets counted,
// so it is charset-pinned like every other id here.
const MIN_POLL_OPTIONS = 2;
const MAX_POLL_OPTIONS = 5;

function normalizePoll(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Array.isArray(raw.options)) return null;
  const options = [];
  const seen = new Set();
  for (const item of raw.options) {
    if (!item || typeof item !== 'object') continue;
    const id = cleanStr(item.id, 61);
    const label = cleanStr(item.label, 60);
    // A duplicate id would make two buttons increment the same counter while
    // showing different words — the result would be unreadable.
    if (!MESSAGE_ID_RE.test(id) || !label || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, label });
    if (options.length >= MAX_POLL_OPTIONS) break;
  }
  return options.length >= MIN_POLL_OPTIONS ? { options } : null;
}

// Rebuild one message into the exact shape the client trusts, or null.
function normalizeMessage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const id = cleanStr(raw.id, 61);
  if (!MESSAGE_ID_RE.test(id)) return null;

  // Where it appears, as the console says it: `corner` or `stage`. `level` is what
  // 4.11 and older read from the same feed, so the hub keeps writing both.
  const where = WHERE.has(raw.where) ? raw.where : 'corner';
  const level = cleanStr(raw.level, 10) || (where === 'stage' ? 'modal' : 'toast');
  if (!LEVELS.has(level)) return null;

  // A message with no title has nothing to show; body is optional (a one-line
  // toast is a legitimate shape).
  const title = cleanStr(raw.title, 120);
  if (!title) return null;

  const match = normalizeMatch(raw.match);
  // A message nobody can ever match is dropped here rather than shipped with a
  // flag the client has to remember to honour.
  if (match && match.unsatisfiable) return null;

  const entryId = cleanStr(raw.entryId, 61);
  const msg = {
    id,
    level,
    where,
    title,
    body: cleanStr(raw.body, 600),
  };
  if (MESSAGE_ID_RE.test(entryId)) msg.entryId = entryId;
  if (match) msg.match = match;

  const action = normalizeAction(raw.action, msg.entryId);
  if (action) msg.action = action;

  const media = normalizeMedia(raw.media);
  if (media) msg.media = media;

  // A poll that failed validation (one option, all ids malformed) must not ship
  // as a plain message: the title is usually a question, and a question with no
  // way to answer it reads as broken rather than as an announcement.
  if (raw.poll !== undefined && raw.poll !== null) {
    const poll = normalizePoll(raw.poll);
    if (!poll) return null;
    msg.poll = poll;
  }

  const activeFrom = cleanStr(raw.activeFrom, 30);
  if (ISO_DATE_RE.test(activeFrom)) msg.activeFrom = activeFrom;
  const activeUntil = cleanStr(raw.activeUntil, 30);
  if (ISO_DATE_RE.test(activeUntil)) msg.activeUntil = activeUntil;

  return msg;
}

function normalizeMessages(parsed) {
  const list = Array.isArray(parsed) ? parsed
    : (parsed && Array.isArray(parsed.messages) ? parsed.messages : null);
  if (!list) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const msg = normalizeMessage(raw);
    // A duplicate id would make the client's seen-set dedup ambiguous: the first
    // one shown would suppress the second forever.
    if (!msg || seen.has(msg.id)) continue;
    seen.add(msg.id);
    out.push(msg);
    if (out.length >= MAX_MESSAGES) break;
  }
  return out;
}

module.exports = {
  MAX_MESSAGES, MESSAGE_ID_RE, VERSION_RE, ISO_DATE_RE, OS_RE, LANG_RE, LEVELS, WHERE, ACTION_TYPES,
  LINK_HOSTS, MEDIA_HOSTS, MEDIA_IMAGE_EXT, MEDIA_VIDEO_EXT, MEDIA_TYPES, MEDIA_ALT_MAX,
  MAX_MATCH_ENTRIES, MAX_MATCH_LIST, cleanStr, tokenList, normalizeMatch, normalizeAction,
  normalizeMedia, MIN_POLL_OPTIONS, MAX_POLL_OPTIONS, normalizePoll, normalizeMessage,
  normalizeMessages,
};
