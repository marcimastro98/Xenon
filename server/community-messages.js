'use strict';
// Hub messages — server-side fetch + validation for the announcement channel.
//
// A static JSON published with the project site (docs/community/messages.json),
// written by the hub's admin console through the same GitHub commit path as
// catalog.json. It carries release notes, "new in the Store" nudges, polls and
// the occasional note to supporters.
//
// The privacy shape is the point, so it is worth stating plainly: every message
// is delivered to EVERY install, and the `match` block is evaluated CLIENT-side
// (js/hub-messages.js) against what that dashboard already knows about itself.
// Nothing about the user is sent to get a targeted message, and the server
// cannot tell who saw what. That is why targeting exists at all — the correlation
// firewall around install-id.json (see version-ping.js) stays intact, and this
// module never touches an identifier. Do not "optimise" this into a per-install
// query; the feed being public is the feature.
//
// This module only VALIDATES shape and drops messages outside their date window.
// It deliberately does not interpret `match`.
//
// Fetch shape mirrors community-catalog.js / ics-feeds.js (https-only conditional
// GET, bounded body, redirect cap, timeout, TTL cache + in-flight dedup) — the
// codebase convention for these fetchers is a documented mirror. If you harden
// one, harden all.
//
// Pure parts are exported for unit tests (server/test/community-messages.test.mjs).

const https = require('https');

// Same origin as the catalog, and fixed for the same reason: a user-configurable
// message source would be a stranger's text rendered on the dashboard.
const MESSAGES_URL = 'https://xenon-app.com/community/messages.json';

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 512 * 1024;      // a text feed; anything larger is a mistake
const MESSAGES_TTL_MS = 30 * 60 * 1000;
const REFRESH_MIN_INTERVAL_MS = 60 * 1000;
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
const LEVELS = new Set(['toast', 'modal', 'banner']);

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

  const level = cleanStr(raw.level, 10);
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
    title,
    body: cleanStr(raw.body, 600),
    kicker: cleanStr(raw.kicker, 24),
  };
  if (MESSAGE_ID_RE.test(entryId)) msg.entryId = entryId;
  if (match) msg.match = match;

  const action = normalizeAction(raw.action, msg.entryId);
  if (action) msg.action = action;

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

// A bare YYYY-MM-DD parses to midnight UTC. That is what "starts on" means, but
// it is the opposite of what "until" means: a date picker set to 1 August is read
// by everyone as "through 1 August", not "ends the moment 1 August begins", and
// taking it literally silently drops the campaign's whole last day. So an
// end-date with no time is stretched to the end of that day; one WITH a time is
// left exactly as written, because then the author said when they meant.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function endOfWindow(value) {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return NaN;
  return DATE_ONLY_RE.test(value) ? t + (24 * 3600 * 1000) - 1 : t;
}

// Date-window filter, applied at SERVE time off the cached list (same as the
// catalog) so a message starts and retires on schedule without a re-fetch.
function filterVisibleMessages(messages, now) {
  if (!Array.isArray(messages)) return [];
  return messages.filter((m) => {
    if (m.activeFrom) {
      const from = Date.parse(m.activeFrom);
      if (Number.isFinite(from) && now < from) return false;
    }
    if (m.activeUntil) {
      const until = endOfWindow(m.activeUntil);
      if (Number.isFinite(until) && now > until) return false;
    }
    return true;
  });
}

function cacheIsFresh(cache, now, ttl = MESSAGES_TTL_MS) {
  return !!(cache && Array.isArray(cache.messages) && (now - cache.fetchedAt) < ttl);
}

// ── HTTPS conditional GET ────────────────────────────────────────────────────
// Mirrors fetchText in community-catalog.js (same redirect cap, timeout, body
// cap, ETag/304 handling). If you harden one, harden all.
function fetchText(url, validators, _hops = 0) {
  return new Promise((resolve, reject) => {
    if (_hops > 5) return reject(new Error('too many redirects'));
    if (!/^https:\/\//i.test(url)) return reject(new Error('https only'));
    const headers = {};
    if (validators && validators.etag) headers['If-None-Match'] = validators.etag;
    let req;
    try { req = https.get(url, { timeout: FETCH_TIMEOUT_MS, headers }, onResponse); }
    catch (e) { return reject(e); }
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);

    function onResponse(res) {
      if (res.statusCode === 304) { res.resume(); return resolve({ notModified: true }); }
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).toString(), validators, _hops + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const etag = res.headers.etag || '';
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { req.destroy(new Error('body too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ notModified: false, text: Buffer.concat(chunks).toString('utf8'), etag }));
      res.on('error', reject);
    }
  });
}

// ── Cache (module-level, request-driven) ─────────────────────────────────────
// No periodic work: the feed is fetched only when a dashboard asks for it.
let _cache = null;      // { messages, fetchedAt, etag }
let _pending = null;    // in-flight dedup
let _lastForcedAt = 0;

async function fetchMessages(force) {
  const now = Date.now();
  if (_pending) return _pending;
  const doForce = force && (now - _lastForcedAt) >= REFRESH_MIN_INTERVAL_MS;
  if (doForce) _lastForcedAt = now;
  if (!doForce && cacheIsFresh(_cache, now)) {
    return { ok: true, messages: _cache.messages, cached: true };
  }
  _pending = (async () => {
    try {
      const resp = await fetchText(MESSAGES_URL, _cache && !doForce ? { etag: _cache.etag } : null);
      if (resp.notModified && _cache) {
        _cache.fetchedAt = Date.now();
        return { ok: true, messages: _cache.messages, cached: true };
      }
      let parsed;
      try { parsed = JSON.parse(resp.text || ''); } catch { throw new Error('bad messages JSON'); }
      const messages = normalizeMessages(parsed);
      _cache = { messages, fetchedAt: Date.now(), etag: resp.etag || '' };
      return { ok: true, messages, cached: false };
    } catch (e) {
      // Degrade to the last good copy when the network is down. An announcement
      // feed is never worth surfacing an error for.
      if (_cache) return { ok: true, messages: _cache.messages, cached: true, stale: true };
      return { ok: false, error: String((e && e.message) || e).slice(0, 200), messages: [] };
    } finally {
      _pending = null;
    }
  })();
  return _pending;
}

// What the client should see: valid messages inside their date window.
async function fetchVisibleMessages(force) {
  const out = await fetchMessages(force);
  if (out && out.ok && Array.isArray(out.messages)) {
    return { ...out, messages: filterVisibleMessages(out.messages, Date.now()) };
  }
  return out;
}

module.exports = {
  fetchMessages,
  fetchVisibleMessages,
  // pure parts, for tests
  normalizeMessage,
  normalizeMessages,
  normalizeMatch,
  normalizeAction,
  filterVisibleMessages,
  cacheIsFresh,
  MESSAGES_URL,
  MAX_MESSAGES,
  LEVELS,
  LINK_HOSTS,
};
