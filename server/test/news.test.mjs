import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Pure-logic tests for the News data module — no network. Covers the config
// normalizer (source allowlist + topic slug/dedup + bounds) and source search.
const require = createRequire(import.meta.url);
const news = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'news.js'));

test('topicId slugs free text safely', () => {
  assert.equal(news.topicId('Serie A'), 'serie-a');
  assert.equal(news.topicId('  AI & Robotics!! '), 'ai-robotics');
  assert.equal(news.topicId(''), '');
});

test('normalizeFeeds allowlists sources, dedups, and slugs topics', () => {
  const feeds = news.normalizeFeeds([
    { type: 'source', id: 'bbc' },
    { type: 'source', id: 'bbc' },          // dup source → dropped
    { type: 'source', id: 'not-a-real-source' }, // unknown → dropped
    { type: 'topic', name: 'Tech News', query: 'tech news' },
    { type: 'topic', query: 'tech news' },  // same slug → dropped
    { type: 'topic', name: 'Calcio' },      // name-only topic (query defaults to name)
  ]);
  const ids = feeds.map(f => f.type + ':' + f.id);
  assert.deepEqual(ids, ['source:bbc', 'topic:tech-news', 'topic:calcio']);
  assert.equal(feeds[0].name, 'BBC News');   // curated name filled in
  assert.equal(feeds[2].query, 'Calcio');
});

test('normalizeNews clamps refresh, defaults feeds, keeps images flag', () => {
  const n = news.normalizeNews({ refreshSec: 5, tile: { images: false } });
  assert.equal(n.refreshSec, 120);           // clamped up to the floor
  assert.equal(n.tile.images, false);
  const d = news.normalizeNews({});
  assert.ok(d.feeds.length >= 1);
  assert.equal(d.tile.images, true);
});

test('normalizeFeeds accepts custom https feeds, dedups by URL, defaults name to host', () => {
  const feeds = news.normalizeFeeds([
    { type: 'custom', url: 'https://www.nu.nl/nu-rss.html' },
    { type: 'custom', url: 'https://www.nu.nl/nu-rss.html' },     // same URL → dropped
    { type: 'custom', url: 'https://blog.example.com/feed', name: 'My Blog' },
  ]);
  assert.equal(feeds.length, 2);
  assert.equal(feeds[0].type, 'custom');
  assert.equal(feeds[0].url, 'https://www.nu.nl/nu-rss.html');
  assert.equal(feeds[0].name, 'nu.nl');            // host default (www. stripped)
  assert.equal(feeds[0].id, news.customId('https://www.nu.nl/nu-rss.html')); // stable id from URL
  assert.equal(feeds[1].name, 'My Blog');          // explicit name kept
});

test('normalizeFeeds rejects non-https / loopback / private custom feeds', () => {
  const feeds = news.normalizeFeeds([
    { type: 'custom', url: 'http://insecure.example.com/feed' },  // http → dropped
    { type: 'custom', url: 'https://localhost/feed' },            // loopback host → dropped
    { type: 'custom', url: 'https://127.0.0.1/feed' },            // loopback IP → dropped
    { type: 'custom', url: 'https://192.168.1.10/feed' },         // private IP → dropped
    { type: 'custom', url: 'javascript:alert(1)' },               // bad scheme → dropped
  ]);
  assert.equal(feeds.length, 0);
});

test('isPublicFeedUrl guards the feed host', () => {
  assert.equal(news.isPublicFeedUrl('https://feeds.bbci.co.uk/news/rss.xml'), true);
  assert.equal(news.isPublicFeedUrl('http://feeds.bbci.co.uk/news/rss.xml'), false);
  assert.equal(news.isPublicFeedUrl('https://10.0.0.5/feed'), false);
  assert.equal(news.isPublicFeedUrl('https://169.254.1.1/feed'), false);
  assert.equal(news.isPublicFeedUrl('https://router.local/feed'), false);
});

test('normalizeFeeds caps the followed list', () => {
  const many = Array.from({ length: news.MAX_FEEDS + 6 }, (_, i) => ({ type: 'topic', query: 'topic ' + i }));
  assert.equal(news.normalizeFeeds(many).length, news.MAX_FEEDS);
});

test('searchSources matches curated outlets by name/category, needs 2+ chars', () => {
  assert.ok(news.searchSources('bbc').some(s => s.id === 'bbc'));
  assert.ok(news.searchSources('tech').length >= 1);  // by category
  assert.equal(news.searchSources('x').length, 0);
});
