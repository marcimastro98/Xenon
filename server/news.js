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

const crypto = require('crypto');
// Outbound address guard: the URL check refuses private/loopback literals and
// local names, the lookup hook refuses a public name that RESOLVES there (DNS
// rebinding). Both are needed because Node skips `lookup` for IP literals.
require('./net-guard');

const MAX_FEEDS = 12;              // followed sources/topics cap
const MAX_ITEMS = 40;             // merged headline cap (bounds payload)
const FETCH_CONCURRENCY = 5;
const {
  str, safeUrl, decodeEntities, stripTags, parseFeed,
} = require('./ticker/news-feed-parse.js');

// ── small helpers ─────────────────────────────────────────────────────────────

const { isPublicFeedUrl, fetchText, pool } = require('./ticker/news-fetch.js');

// A slug id for a topic feed ("Serie A" → "serie-a"); sources carry their own id.
function topicId(text) {
  return String(text || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
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

// The scanners below replace regexes like /<item\b[\s\S]*?<\/item>/ that
// rescan the rest of the document from every opening tag, which is quadratic
// when the closing tag never comes. Each one walks forward with indexOf and
// gives up as soon as a closing tag is missing, since no later opening tag
// could find one either. `lower` is the lowercased source, computed once by
// the caller, so matching is case-insensitive like the old /i regexes.

// ── RSS / Atom item extraction (dependency-free) ──────────────────────────────

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

const { newsLang, googleNewsUrl } = require('./ticker/news-locales.js');

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
