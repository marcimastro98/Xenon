'use strict';

// ── News data source ──────────────────────────────────────────────────────────
// Pure data library: fetches headlines from the feeds a user follows (curated
// outlet RSS feeds, free-text topics, and/or user-added custom RSS/Atom URLs) and
// normalizes the Settings config.
// The server owns the cache, the refresh timer and the SSE push (mirrors stocks.js
// / football.js) — this module never touches disk and never keeps a timer.
//
// KEYLESS by default: outlet RSS feeds give clean titles, direct article links and
// thumbnails; free-text topics are resolved through Google News RSS in the user's
// language — no signup, no npm dependency (direct https + a hand-rolled RSS
// extractor, like ics-feeds.js parses ICS). An OPTIONAL NewsData.io key enriches
// topic search (categories + images); it is a SERVER-ONLY secret (news-creds.js).

const https = require('https');
const crypto = require('crypto');
// Outbound address guard: the URL check refuses private/loopback literals and
// local names, the lookup hook refuses a public name that RESOLVES there (DNS
// rebinding). Both are needed because Node skips `lookup` for IP literals.
const { assertPublicUrl, publicLookup, armDeadline } = require('./net-guard');

const MAX_FEEDS = 12;              // followed sources/topics cap
const MAX_ITEMS = 40;             // merged headline cap (bounds payload)
const FETCH_TIMEOUT_MS = 8000;     // idle socket timeout
const FETCH_DEADLINE_MS = 15000;   // whole request, so a trickling server can't pin a refresh
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const FETCH_CONCURRENCY = 5;
// Parser budgets. A feed is untrusted input parsed on the event loop: only the
// first PARSE_MAX_CHARS are read, at most PARSE_MAX_BLOCKS <item>/<entry>
// blocks are looked at, and each block is cut to PARSE_MAX_BLOCK_CHARS (a
// full-text item keeps its title, which comes first, and loses the tail).
const PARSE_MAX_CHARS = 512 * 1024;
const PARSE_MAX_BLOCKS = 200;
const PARSE_MAX_BLOCK_CHARS = 64 * 1024;
const TAG_MAX_CHARS = 8000;        // one tag's text before entity decoding

// ── small helpers ─────────────────────────────────────────────────────────────

function str(value, max) { return String(value == null ? '' : value).trim().slice(0, max || 200); }

// A slug id for a topic feed ("Serie A" → "serie-a"); sources carry their own id.
function topicId(text) {
  return String(text || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// A link/image URL rendered as href/src → http(s) only (scheme allowlist; see
// CLAUDE.md). Returns '' for anything else so the caller can drop it.
function safeUrl(value) {
  const s = String(value || '').trim().slice(0, 600);
  return /^https?:\/\//i.test(s) ? s : '';
}

// A stable, collision-free id for a user-added custom feed URL. The URL itself is
// too long/dirty to use as an id (it flows into dedup keys + item.feedId), so we
// hash it: same URL → same id across saves, so add/remove/dedup stay consistent.
function customId(url) {
  return 'u' + crypto.createHash('sha1').update(String(url || '')).digest('hex').slice(0, 10);
}

// Default display name for a custom feed → its host (e.g. "www.nu.nl" → "nu.nl").
function feedHostName(url) {
  try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return ''; }
}

// A custom feed URL is fetched SERVER-side, so keep it pointed at the public web:
// https only, no local names, no private/loopback/link-local/CGNAT IP literal
// (any spelling, including IPv4-mapped IPv6). Resolved addresses are checked
// again at connect time by publicLookup in fetchText.
function isPublicFeedUrl(url) {
  const u = safeUrl(url);
  if (!u) return false;
  try { assertPublicUrl(u); return true; } catch { return false; }
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&#x0*27;/gi, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } })
    .replace(/&amp;/g, '&');
}

// Strip HTML tags and collapse whitespace. Assumes its input is ALREADY
// entity-decoded (firstTag decodes; the NewsData JSON path decodes explicitly) —
// decoding here too would double-decode ("&amp;lt;" → a literal "<").
// `[^<>]*` rather than `[^>]*`: a run of '<' with no '>' would otherwise make
// every '<' rescan to the end of the string (quadratic on hostile input).
function stripTags(s) { return String(s || '').slice(0, TAG_MAX_CHARS).replace(/<[^<>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }

// The scanners below replace regexes like /<item\b[\s\S]*?<\/item>/ that
// rescan the rest of the document from every opening tag, which is quadratic
// when the closing tag never comes. Each one walks forward with indexOf and
// gives up as soon as a closing tag is missing, since no later opening tag
// could find one either. `lower` is the lowercased source, computed once by
// the caller, so matching is case-insensitive like the old /i regexes.

// After "<tag" the name must end: '>', '/', or whitespace.
function tagNameEnds(lower, at) {
  const c = lower.charCodeAt(at);
  return c === 62 || c === 47 || c === 32 || c === 9 || c === 10 || c === 13;
}

// Every "<tag ...>...</tag>" block, in order, up to `maxBlocks`.
function findBlocks(src, lower, tag, maxBlocks, maxLen) {
  const open = '<' + tag;
  const close = '</' + tag + '>';
  const out = [];
  let pos = 0;
  while (out.length < maxBlocks) {
    const start = lower.indexOf(open, pos);
    if (start === -1) break;
    if (!tagNameEnds(lower, start + open.length)) { pos = start + open.length; continue; }
    const end = lower.indexOf(close, start + open.length);
    if (end === -1) break;
    const stop = end + close.length;
    out.push(src.slice(start, Math.min(stop, start + maxLen)));
    pos = stop;
  }
  return out;
}

// Text of the first <tag ...>text</tag>, entity-decoded; '' if none.
function tagText(block, lower, tag) {
  const open = '<' + tag;
  const close = '</' + tag + '>';
  let pos = 0;
  for (;;) {
    const start = lower.indexOf(open, pos);
    if (start === -1) return '';
    if (!tagNameEnds(lower, start + open.length)) { pos = start + open.length; continue; }
    const gt = lower.indexOf('>', start + open.length);
    if (gt === -1) return '';
    const end = lower.indexOf(close, gt + 1);
    if (end === -1) return '';
    return decodeEntities(block.slice(gt + 1, Math.min(end, gt + 1 + TAG_MAX_CHARS))).trim();
  }
}

// Value of attribute `attr` on the first <tag ...> that carries it; '' if none.
function attrValue(block, lower, tag, attr) {
  const open = '<' + tag;
  const re = new RegExp('\\s' + attr + '=(["\'])(.*?)\\1', 'i');
  let pos = 0;
  for (;;) {
    const start = lower.indexOf(open, pos);
    if (start === -1) return '';
    if (!tagNameEnds(lower, start + open.length)) { pos = start + open.length; continue; }
    const gt = lower.indexOf('>', start + open.length);
    const head = block.slice(start + open.length, gt === -1 ? block.length : gt);
    const m = re.exec(head.slice(0, TAG_MAX_CHARS));
    if (m) return decodeEntities(m[2]).trim();
    if (gt === -1) return '';
    pos = gt + 1;   // anything before this '>' is inside the tag just checked
  }
}

function firstTag(block, tag) { return tagText(block, block.toLowerCase(), tag); }

// ── RSS / Atom item extraction (dependency-free) ──────────────────────────────

function parseFeed(xml, feed) {
  const items = [];
  const src = String(xml || '').slice(0, PARSE_MAX_CHARS);
  const lower = src.toLowerCase();
  const feedTitle = firstTag(src.slice(0, 4000), 'title'); // channel/feed title
  let blocks = findBlocks(src, lower, 'item', PARSE_MAX_BLOCKS, PARSE_MAX_BLOCK_CHARS);
  if (!blocks.length) blocks = findBlocks(src, lower, 'entry', PARSE_MAX_BLOCKS, PARSE_MAX_BLOCK_CHARS);
  for (const block of blocks) {
    const lb = block.toLowerCase();
    const rawTitle = tagText(block, lb, 'title');
    if (!rawTitle) continue;
    // Atom <link href="..."/> or RSS <link>...</link>
    let link = tagText(block, lb, 'link');
    if (!link) link = attrValue(block, lb, 'link', 'href');
    const url = safeUrl(link);
    const dateStr = tagText(block, lb, 'pubdate') || tagText(block, lb, 'updated') || tagText(block, lb, 'published') || tagText(block, lb, 'dc:date');
    let published = Date.parse(dateStr);
    if (!Number.isFinite(published)) published = 0;
    const image = safeUrl(attrValue(block, lb, 'media:thumbnail', 'url') || attrValue(block, lb, 'media:content', 'url') || attrValue(block, lb, 'enclosure', 'url'));
    // Google News packs "Title - Source"; split the source off if present.
    let title = stripTags(rawTitle);
    let source = tagText(block, lb, 'source') || feed.name || feedTitle;
    if (feed.type === 'topic') {
      const dash = title.lastIndexOf(' - ');
      if (dash > 10 && dash > title.length - 60) { source = title.slice(dash + 3).trim(); title = title.slice(0, dash).trim(); }
    }
    const snippet = stripTags(tagText(block, lb, 'description') || tagText(block, lb, 'summary')).slice(0, 200);
    if (!url || !title) continue;
    items.push({
      id: url,
      title: title.slice(0, 200),
      url,
      source: str(source, 60),
      published,
      image,
      snippet,
      feedId: feed.id,
    });
    if (items.length >= 30) break;
  }
  return items;
}

// ── curated sources (keyless discovery) ───────────────────────────────────────
// A hand-picked set of major outlets with stable RSS feeds (IT + EN), searchable
// by name in the add box. Topics (free text) go through Google News RSS instead.
function S(id, name, url, lang, category) { return { id, name, url, lang, category, type: 'source' }; }
const SOURCES = Object.freeze([
  S('ansa', 'ANSA', 'https://www.ansa.it/sito/ansait_rss.xml', 'it', 'general'),
  S('repubblica', 'la Repubblica', 'https://www.repubblica.it/rss/homepage/rss2.0.xml', 'it', 'general'),
  S('corriere', 'Corriere della Sera', 'https://xml2.corriereobjects.it/rss/homepage.xml', 'it', 'general'),
  S('ilpost', 'Il Post', 'https://www.ilpost.it/feed/', 'it', 'general'),
  S('skytg24', 'Sky TG24', 'https://tg24.sky.it/rss/tg24.xml', 'it', 'general'),
  S('gazzetta', 'Gazzetta dello Sport', 'https://www.gazzetta.it/rss/home.xml', 'it', 'sport'),
  S('sole24ore', 'Il Sole 24 Ore', 'https://www.ilsole24ore.com/rss/economia.xml', 'it', 'business'),
  S('wired-it', 'Wired Italia', 'https://www.wired.it/feed/rss', 'it', 'tech'),
  S('bbc', 'BBC News', 'https://feeds.bbci.co.uk/news/world/rss.xml', 'en', 'general'),
  S('guardian', 'The Guardian', 'https://www.theguardian.com/world/rss', 'en', 'general'),
  S('reuters-goog', 'Reuters', 'https://news.google.com/rss/search?q=when:1d%20site:reuters.com&hl=en-US&gl=US&ceid=US:en', 'en', 'general'),
  S('theverge', 'The Verge', 'https://www.theverge.com/rss/index.xml', 'en', 'tech'),
  S('techcrunch', 'TechCrunch', 'https://techcrunch.com/feed/', 'en', 'tech'),
  S('espn', 'ESPN', 'https://www.espn.com/espn/rss/news', 'en', 'sport'),
  S('hackernews', 'Hacker News', 'https://hnrss.org/frontpage', 'en', 'tech'),
]);
const SOURCE_BY_ID = new Map(SOURCES.map(s => [s.id, s]));

// Google News locale per UI language. It used to name five of the app's ELEVEN
// languages, and the other six fell through to en-US — so a German, French,
// Spanish, Portuguese, Russian or Dutch user asking for a topic got American
// news in English, silently, with the topic they typed in their own language.
// Google News serves all of these; there was no reason for the short list.
const NEWS_LOCALES = Object.freeze({
  it: 'IT', en: 'US', de: 'DE', fr: 'FR', es: 'ES', pt: 'PT',
  ru: 'RU', nl: 'NL', ko: 'KR', ja: 'JP', zh: 'CN',
});

/** The UI language reduced to one this module can actually serve. */
function newsLang(lang) {
  const l = String(lang || '').toLowerCase().slice(0, 2);
  return Object.prototype.hasOwnProperty.call(NEWS_LOCALES, l) ? l : 'en';
}

// Google News RSS search for a free-text topic, in the requested UI language.
function googleNewsUrl(query, lang) {
  const l = newsLang(lang);
  const region = NEWS_LOCALES[l];
  const hl = l === 'en' ? 'en-US' : l;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${region}&ceid=${region}:${l}`;
}

// ── config normalization ──────────────────────────────────────────────────────

// The word for "technology" in each UI language. The default feed set carried
// the Italian one for everybody, so an English install showed a chip reading
// "Tecnologia" among otherwise English settings and asked Google News for an
// Italian word (reported from a phone). It is the topic's NAME and its QUERY at
// once, which is what a topic is: free text sent to the search.
const DEFAULT_TOPIC = Object.freeze({
  it: 'Tecnologia', en: 'Technology', de: 'Technologie', fr: 'Technologie',
  es: 'Tecnología', pt: 'Tecnologia', ru: 'Технологии', nl: 'Technologie',
  ko: '기술', ja: 'テクノロジー', zh: '科技',
});

/**
 * The feed set a fresh install starts with, in the user's language.
 *
 * SOURCES stays a two-language list (Italian and English outlets are the ones
 * with feeds we have checked), so the rule is: an Italian install keeps ANSA,
 * and every other language gets the two international English outlets rather
 * than an Italian wire service it cannot read. The TOPIC is what carries the
 * language for everyone else, and Google News serves it in their locale.
 *
 * Only ever used when there is no saved list. A list the user has already
 * edited is theirs and is never rewritten.
 */
function defaultNewsFeeds(lang) {
  const l = newsLang(lang);
  const sources = l === 'it'
    ? [{ id: 'ansa', type: 'source', name: 'ANSA' }, { id: 'bbc', type: 'source', name: 'BBC News' }]
    : [{ id: 'bbc', type: 'source', name: 'BBC News' }, { id: 'guardian', type: 'source', name: 'The Guardian' }];
  const topic = DEFAULT_TOPIC[l] || DEFAULT_TOPIC.en;
  return [...sources, { id: 'tech', type: 'topic', name: topic, query: topic.toLowerCase() }];
}

const DEFAULT_NEWS = Object.freeze({
  feeds: Object.freeze(defaultNewsFeeds('en').map(Object.freeze)),
  refreshSec: 600,
  tile: Object.freeze({ images: true }),
});

function normalizeFeeds(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'topic') {
      const query = str(entry.query || entry.name, 60);
      const id = topicId(query);
      if (!id || seen.has('t:' + id)) continue;
      seen.add('t:' + id);
      out.push({ id, type: 'topic', name: str(entry.name || query, 40), query });
    } else if (entry.type === 'custom') {
      const url = safeUrl(entry.url);
      if (!isPublicFeedUrl(url)) continue;      // https + public host only
      const id = customId(url);
      if (seen.has('c:' + id)) continue;
      seen.add('c:' + id);
      out.push({ id, type: 'custom', name: str(entry.name, 40) || feedHostName(url) || 'RSS', url });
    } else {
      const id = str(entry.id, 40);
      if (!SOURCE_BY_ID.has(id) || seen.has('s:' + id)) continue; // sources must be curated
      seen.add('s:' + id);
      out.push({ id, type: 'source', name: SOURCE_BY_ID.get(id).name });
    }
    if (out.length >= MAX_FEEDS) break;
  }
  return out;
}

// `lang` is only ever read to build the FIRST feed set, when there is none
// saved. It is passed rather than read from a module global so this stays pure,
// and so the caller (normalizeHubSettings) hands over the same language it is
// normalising in the same pass.
function normalizeNews(value, lang) {
  const src = value && typeof value === 'object' ? value : {};
  const refreshSec = clampInt(src.refreshSec, 120, 3600, DEFAULT_NEWS.refreshSec);
  const feeds = src.feeds !== undefined ? normalizeFeeds(src.feeds) : defaultNewsFeeds(lang);
  const tile = src.tile && typeof src.tile === 'object' ? src.tile : {};
  return { feeds, refreshSec, tile: { images: tile.images !== false } };
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ── hardened fetch (text; mirrors ics-feeds.js) ───────────────────────────────

function fetchText(url, redirects) {
  const depth = redirects || 0;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };
    // Every URL fetched here (curated, Google News, NewsData, custom, and each
    // redirect hop) passes the same public-https check first.
    try { assertPublicUrl(url); } catch (e) { return finish(reject, e); }
    const req = https.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      // publicLookup drops loopback/private/link-local/CGNAT resolutions, so a
      // public hostname that DNS-rebinds to 127.0.0.1 / 192.168.x.x fails at
      // connect time (the URL check can't see what a name resolves to).
      lookup: publicLookup,
      headers: { 'User-Agent': 'Mozilla/5.0 (Xenon Dashboard)', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
    }, res => {
      // Follow up to 3 redirects (some feeds 301 to https/www) — every hop must
      // pass the same public-https filter as the original URL, not just be https:
      // a legit-looking feed must not be able to 302 into private address space.
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (depth >= 3) return finish(reject, new Error('too many redirects'));
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch { return finish(reject, new Error('bad redirect')); }
        if (!isPublicFeedUrl(next)) return finish(reject, new Error('blocked redirect'));
        return finish(resolve, fetchText(next, depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return finish(reject, new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { req.destroy(new Error('body too large')); return; }
        chunks.push(chunk);
      });
      // Decode once at the end so a multi-byte character split across two
      // chunks is not mangled.
      res.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
      res.on('error', e => finish(reject, e));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => finish(reject, e));
    armDeadline(req, FETCH_DEADLINE_MS);
  });
}

async function pool(items, worker, limit) {
  const out = new Array(items.length).fill(null);
  let i = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await worker(items[idx], idx); }
      catch { out[idx] = null; }
    }
  });
  await Promise.all(runners);
  return out;
}

// ── public fetch API ──────────────────────────────────────────────────────────

function feedUrl(feed, opts) {
  if (feed.type === 'source') { const s = SOURCE_BY_ID.get(feed.id); return s ? s.url : ''; }
  if (feed.type === 'custom') return isPublicFeedUrl(feed.url) ? feed.url : '';
  return googleNewsUrl(feed.query || feed.name, opts && opts.lang);
}

// Optional NewsData.io enrichment for a topic (richer results + images). JSON,
// not RSS. Falls back to null on any error so the caller uses Google News RSS.
async function fetchNewsData(query, key, lang) {
  // NewsData.io takes the same two-letter codes, so the widened list above
  // serves both paths rather than one being quietly narrower than the other.
  const l = newsLang(lang);
  const url = `https://newsdata.io/api/1/latest?apikey=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&language=${l}`;
  let raw;
  try { raw = await fetchText(url); } catch { return null; }
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || j.status !== 'success' || !Array.isArray(j.results)) return null;
  const out = [];
  for (const r of j.results) {
    const link = safeUrl(r && r.link);
    const title = stripTags(decodeEntities(r && r.title));
    if (!link || !title) continue;
    out.push({
      id: link, title: title.slice(0, 200), url: link,
      source: str((r.source_name || r.source_id), 60),
      published: Date.parse(r.pubDate) || 0,
      image: safeUrl(r.image_url), snippet: stripTags(decodeEntities(r.description)).slice(0, 200),
    });
    if (out.length >= 20) break;
  }
  return out;
}

// Fetch every followed feed, merge, dedup, sort newest-first, cap. Never throws.
async function fetchHeadlines(feeds, opts) {
  const list = normalizeFeeds(feeds);
  if (!list.length) return { items: [], feeds: [] };
  const key = (opts && opts.newsDataKey) || '';
  const results = await pool(list, async (feed) => {
    if (feed.type === 'topic' && key) {
      const nd = await fetchNewsData(feed.query || feed.name, key, opts && opts.lang);
      if (nd && nd.length) return nd.map(it => ({ ...it, feedId: feed.id }));
    }
    const url = feedUrl(feed, opts);
    if (!url) return [];
    const xml = await fetchText(url).catch(() => '');
    return parseFeed(xml, feed);
  }, FETCH_CONCURRENCY);
  const merged = [];
  const seen = new Set();
  for (const arr of results) {
    for (const it of (arr || [])) {
      const key = (it.url || '').replace(/[#?].*$/, '') || it.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(it);
    }
  }
  merged.sort((a, b) => (b.published || 0) - (a.published || 0));
  return { items: merged.slice(0, MAX_ITEMS), feeds: list };
}

// Search the curated sources by name for the add box; topics are added as-is by
// the caller (any free text becomes a Google News topic).
function searchSources(query) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const out = [];
  for (const s of SOURCES) {
    if (s.name.toLowerCase().includes(q) || s.id.includes(q) || s.category.includes(q)) {
      out.push({ id: s.id, name: s.name, category: s.category, lang: s.lang, type: 'source' });
    }
    if (out.length >= 8) break;
  }
  return out;
}

module.exports = {
  MAX_FEEDS,
  MAX_ITEMS,
  DEFAULT_NEWS,
  DEFAULT_TOPIC,
  defaultNewsFeeds,
  newsLang,
  SOURCES,
  normalizeNews,
  normalizeFeeds,
  topicId,
  customId,
  isPublicFeedUrl,
  parseFeed,
  fetchHeadlines,
  searchSources,
};
