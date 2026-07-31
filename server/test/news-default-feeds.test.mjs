import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const news = require('../news.js');
const HERE = dirname(fileURLToPath(import.meta.url));

// The default news feeds were Italian for everybody: an English install opened
// its settings to a chip reading "Tecnologia" and asked Google News for an
// Italian word, which is both the wrong label and the wrong search. Reported
// from a paired phone, where the settings panel is the only place it shows.
//
// Two halves have to stay true for the fix to mean anything, and each has its
// own way of going quietly wrong:
//
//  1. The CLIENT keeps its own copy of the table (normalizeNewsClient mirrors
//     normalizeNews by design, so a settings save from a browser cannot be
//     rebuilt into something the server would reject). Two copies drift, and
//     the drift here would be a chip in one language and a query in another.
//  2. The Google News locale map named FIVE of the app's eleven languages and
//     fell through to en-US for the rest, so a German or Dutch topic search
//     returned American news in English. Nothing failed; it just answered the
//     wrong question.

const { DEFAULT_TOPIC, defaultNewsFeeds, newsLang, SOURCES, normalizeNews } = news;
const LANGS = ['it', 'en', 'de', 'fr', 'es', 'pt', 'ru', 'nl', 'ko', 'ja', 'zh'];

// ── The two tables are one table ─────────────────────────────────────────────

/**
 * The client mirror, evaluated out of settings.js without loading a browser.
 *
 * The table and its builder are deliberately FAR APART in that file — the table
 * has to be initialized before the load-time normalize runs, the function does
 * not because a declaration is hoisted (see settings-load-order.test.mjs). So
 * they are lifted separately rather than as one slice.
 */
function region(src, startNeedle, what) {
  const start = src.indexOf(startNeedle);
  assert.notEqual(start, -1, what + ' is gone from settings.js — did the mirror move?');
  // Up to the end of the first top-level block: `});` for the table, `\n}` for
  // the function.
  const close = src.indexOf(startNeedle.startsWith('const') ? '});' : '\n}', start);
  assert.notEqual(close, -1, 'could not find the end of ' + what);
  return src.slice(start, close + 3);
}

function clientTable() {
  const src = readFileSync(join(HERE, '..', 'js', 'settings.js'), 'utf8');
  const code = region(src, 'const NEWS_DEFAULT_TOPIC', 'NEWS_DEFAULT_TOPIC')
    + '\n' + region(src, 'function defaultNewsFeedsClient', 'defaultNewsFeedsClient');
  const sandbox = { Object };
  vm.createContext(sandbox);
  // A top-level `const` is NOT a property of the global object, so the table
  // has to be handed out explicitly or it reads back as undefined — which looks
  // exactly like the mirror having been deleted.
  vm.runInContext(code + '\n;this.out = { NEWS_DEFAULT_TOPIC, defaultNewsFeedsClient };',
    sandbox, { filename: 'settings.js#news-defaults' });
  assert.ok(sandbox.out && sandbox.out.NEWS_DEFAULT_TOPIC, 'the client mirror did not evaluate');
  assert.equal(typeof sandbox.out.defaultNewsFeedsClient, 'function', 'the builder did not evaluate');
  return sandbox.out;
}

// Objects built inside a vm carry that realm's prototypes, so deepStrictEqual
// refuses two structurally identical values. The comparison here is about the
// DATA, so both sides come back through JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));

test('the client and the server agree on the word for every language', () => {
  const { NEWS_DEFAULT_TOPIC } = clientTable();
  assert.deepEqual(plain(NEWS_DEFAULT_TOPIC), plain(DEFAULT_TOPIC),
    'settings.js and news.js must carry the same topic table');
  for (const l of LANGS) {
    assert.ok(DEFAULT_TOPIC[l], 'no default topic for ' + l);
  }
  assert.equal(Object.keys(DEFAULT_TOPIC).length, LANGS.length,
    'the table must cover exactly the app\'s languages');
});

test('the client and the server build the same first feed set', () => {
  const { defaultNewsFeedsClient } = clientTable();
  for (const l of [...LANGS, '', 'xx', 'en-GB', undefined]) {
    assert.deepEqual(plain(defaultNewsFeedsClient(l)), plain(defaultNewsFeeds(l)),
      'the seeded feeds differ between client and server for ' + JSON.stringify(l));
  }
});

// ── What the default actually is ─────────────────────────────────────────────

test('a fresh install is seeded in its own language, not in Italian', () => {
  for (const l of LANGS) {
    const feeds = defaultNewsFeeds(l);
    const topic = feeds.find((f) => f.type === 'topic');
    assert.ok(topic, 'every language must get a topic feed');
    assert.equal(topic.name, DEFAULT_TOPIC[l]);
    assert.equal(topic.query, DEFAULT_TOPIC[l].toLowerCase(),
      'the query is what reaches Google News — a localised label over an Italian query fixes nothing');
  }
  // The one that was reported.
  assert.equal(defaultNewsFeeds('en').find((f) => f.type === 'topic').name, 'Technology');
});

test('only an Italian install is seeded with an Italian wire service', () => {
  const ids = (l) => defaultNewsFeeds(l).filter((f) => f.type === 'source').map((f) => f.id);
  assert.deepEqual(ids('it'), ['ansa', 'bbc']);
  for (const l of LANGS.filter((x) => x !== 'it')) {
    assert.equal(ids(l).includes('ansa'), false, l + ' must not be given an Italian outlet by default');
  }
});

test('every seeded source is one the server will actually accept', () => {
  // normalizeFeeds drops any source id that is not curated, so a typo here
  // would silently seed a shorter list than the one written above.
  const curated = new Set(SOURCES.map((s) => s.id));
  for (const l of LANGS) {
    for (const f of defaultNewsFeeds(l)) {
      if (f.type === 'source') assert.ok(curated.has(f.id), f.id + ' is not a curated source (' + l + ')');
    }
    assert.equal(normalizeNews({}, l).feeds.length, 3,
      'a seeded feed was dropped by the normalizer for ' + l);
  }
});

// ── Seeding never touches a list the user already has ────────────────────────

test('a saved feed list survives a language change untouched', () => {
  const mine = { feeds: [{ id: 'ilpost', type: 'source', name: 'Il Post' }], refreshSec: 600 };
  for (const l of LANGS) {
    assert.deepEqual(normalizeNews(mine, l).feeds, [{ id: 'ilpost', type: 'source', name: 'Il Post' }],
      'switching language must not rewrite feeds the user chose');
  }
  // Deliberately empty is a choice too, and an empty array is not "missing".
  assert.deepEqual(normalizeNews({ feeds: [] }, 'de').feeds, [],
    'an empty list must stay empty, not be re-seeded');
});

// ── The locale map ───────────────────────────────────────────────────────────

test('every UI language reaches Google News as itself', () => {
  for (const l of LANGS) {
    assert.equal(newsLang(l), l, l + ' falls through to English');
  }
  // A region tag and anything unknown resolve rather than throw.
  assert.equal(newsLang('pt-BR'), 'pt');
  assert.equal(newsLang('EN'), 'en');
  assert.equal(newsLang(''), 'en');
  assert.equal(newsLang(null), 'en');
  assert.equal(newsLang('klingon'), 'en');
  // The six that used to fall through silently.
  for (const l of ['de', 'fr', 'es', 'pt', 'ru', 'nl']) {
    assert.notEqual(newsLang(l), 'en', l + ' was one of the six that got American news');
  }
});
