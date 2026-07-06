'use strict';

// ── News data source ──────────────────────────────────────────────────────────
// Pure data library: fetches headlines from the feeds a user follows (curated
// outlet RSS feeds and/or free-text topics) and normalizes the Settings config.
// The server owns the cache, the refresh timer and the SSE push (mirrors stocks.js
// / football.js) — this module never touches disk and never keeps a timer.
//
// KEYLESS by default: outlet RSS feeds give clean titles, direct article links and
// thumbnails; free-text topics are resolved through Google News RSS in the user's
// language — no signup, no npm dependency (direct https + a hand-rolled RSS
// extractor, like ics-feeds.js parses ICS). An OPTIONAL NewsData.io key enriches
// topic search (categories + images); it is a SERVER-ONLY secret (news-creds.js).

const https = require('https');

const MAX_FEEDS = 12;              // followed sources/topics cap
const MAX_ITEMS = 40;             // merged headline cap (bounds payload)
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const FETCH_CONCURRENCY = 5;

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
function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }

function firstTag(block, tag) {
  const m = block.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}
function attrUrl(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*\\surl=(["\'])(.*?)\\1', 'i'));
  return m ? decodeEntities(m[2]).trim() : '';
}

// ── RSS / Atom item extraction (dependency-free) ──────────────────────────────

function parseFeed(xml, feed) {
  const items = [];
  const src = String(xml || '');
  const feedTitle = firstTag(src.slice(0, 4000), 'title'); // channel/feed title
  const blocks = src.match(/<item\b[\s\S]*?<\/item>/gi) || src.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks) {
    const rawTitle = firstTag(block, 'title');
    if (!rawTitle) continue;
    // Atom <link href="..."/> or RSS <link>...</link>
    let link = firstTag(block, 'link');
    if (!link) { const m = block.match(/<link[^>]*\shref=(["'])(.*?)\1/i); if (m) link = decodeEntities(m[2]); }
    const url = safeUrl(link);
    const dateStr = firstTag(block, 'pubDate') || firstTag(block, 'updated') || firstTag(block, 'published') || firstTag(block, 'dc:date');
    let published = Date.parse(dateStr);
    if (!Number.isFinite(published)) published = 0;
    const image = safeUrl(attrUrl(block, 'media:thumbnail') || attrUrl(block, 'media:content') || attrUrl(block, 'enclosure'));
    // Google News packs "Title - Source"; split the source off if present.
    let title = stripTags(rawTitle);
    let source = firstTag(block, 'source') || feed.name || feedTitle;
    if (feed.type === 'topic') {
      const dash = title.lastIndexOf(' - ');
      if (dash > 10 && dash > title.length - 60) { source = title.slice(dash + 3).trim(); title = title.slice(0, dash).trim(); }
    }
    const snippet = stripTags(firstTag(block, 'description') || firstTag(block, 'summary')).slice(0, 200);
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

// Google News RSS search for a free-text topic, in the requested UI language.
function googleNewsUrl(query, lang) {
  const l = /^(it|en|ko|ja|zh)$/.test(String(lang)) ? String(lang) : 'en';
  const region = { it: 'IT', en: 'US', ko: 'KR', ja: 'JP', zh: 'CN' }[l] || 'US';
  const hl = l === 'en' ? 'en-US' : l;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${region}&ceid=${region}:${l}`;
}

// ── config normalization ──────────────────────────────────────────────────────

const DEFAULT_NEWS = Object.freeze({
  feeds: Object.freeze([
    Object.freeze({ id: 'ansa', type: 'source', name: 'ANSA' }),
    Object.freeze({ id: 'bbc', type: 'source', name: 'BBC News' }),
    Object.freeze({ id: 'tech', type: 'topic', name: 'Tecnologia', query: 'tecnologia' }),
  ]),
  refreshSec: 600,
  tile: Object.freeze({ images: true }),
});

function normalizeFeeds(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const isTopic = entry.type === 'topic';
    if (isTopic) {
      const query = str(entry.query || entry.name, 60);
      const id = topicId(query);
      if (!id || seen.has('t:' + id)) continue;
      seen.add('t:' + id);
      out.push({ id, type: 'topic', name: str(entry.name || query, 40), query });
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

function normalizeNews(value) {
  const src = value && typeof value === 'object' ? value : {};
  const refreshSec = clampInt(src.refreshSec, 120, 3600, DEFAULT_NEWS.refreshSec);
  const feeds = src.feeds !== undefined ? normalizeFeeds(src.feeds) : DEFAULT_NEWS.feeds.map(f => ({ ...f }));
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
    const req = https.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0 (Xenon Dashboard)', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
    }, res => {
      // Follow up to 3 redirects (some feeds 301 to https/www), https only.
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (depth >= 3) return finish(reject, new Error('too many redirects'));
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch { return finish(reject, new Error('bad redirect')); }
        if (!/^https:\/\//i.test(next)) return finish(reject, new Error('non-https redirect'));
        return finish(resolve, fetchText(next, depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return finish(reject, new Error('HTTP ' + res.statusCode)); }
      let body = '';
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { req.destroy(new Error('body too large')); return; }
        body += chunk;
      });
      res.on('end', () => finish(resolve, body));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => finish(reject, e));
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
  return googleNewsUrl(feed.query || feed.name, opts && opts.lang);
}

// Optional NewsData.io enrichment for a topic (richer results + images). JSON,
// not RSS. Falls back to null on any error so the caller uses Google News RSS.
async function fetchNewsData(query, key, lang) {
  const l = /^(it|en|ko|ja|zh)$/.test(String(lang)) ? String(lang) : 'en';
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
  SOURCES,
  normalizeNews,
  normalizeFeeds,
  topicId,
  fetchHeadlines,
  searchSources,
};
