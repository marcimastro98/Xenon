import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const news = require('../news.js');

// A feed is parsed on the server's event loop. The old regex scanners rescanned
// the rest of the document from every opening tag, so unclosed tags made
// parsing quadratic (a 4 MB body took 15-20 minutes).

const FEED = { id: 'c', type: 'custom', name: 'Feed' };

function timed(fn) {
  const t0 = process.hrtime.bigint();
  const out = fn();
  return { out, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

for (const [label, xml] of [
  ['40k unclosed <item>', '<item>'.repeat(40000)],
  ['40k unclosed <entry>', '<entry>'.repeat(40000)],
  ['one item with 40k "<pubDate "', '<rss><item><title>t</title><link>https://a.example/x</link>' + '<pubDate '.repeat(40000) + '</item></rss>'],
  ['40k "<media:thumbnail " with no ">"', '<item><title>t</title><link>https://a.example/x</link>' + '<media:thumbnail '.repeat(40000) + '</item>'],
  ['40k "<" inside a title', '<item><title>' + '<'.repeat(40000) + '</title><link>https://a.example/x</link></item>'],
  ['40k CDATA openers in a description', '<item><title>t</title><link>https://a.example/x</link><description>' + '<![CDATA['.repeat(40000) + '</description></item>'],
]) {
  test(`parseFeed: ${label} parses in < 200 ms`, () => {
    const { ms } = timed(() => news.parseFeed(xml, FEED));
    assert.ok(ms < 200, `took ${ms} ms`);
  });
}

test('parseFeed: thousands of real items are capped, not all parsed', () => {
  const item = (i) => `<item><title>T${i}</title><link>https://a.example/${i}</link></item>`;
  const xml = '<rss><channel><title>F</title>' + Array.from({ length: 20000 }, (_, i) => item(i)).join('') + '</channel></rss>';
  const { out, ms } = timed(() => news.parseFeed(xml, FEED));
  assert.ok(ms < 200, `took ${ms} ms`);
  assert.equal(out.length, 30);
});

test('parseFeed still reads RSS and Atom the way it did', () => {
  const rss = '<rss><channel><title>Chan</title><item><title><![CDATA[A &amp; B]]></title>'
    + '<link>https://a.example/1</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>'
    + '<media:thumbnail url="https://a.example/i.jpg"/><description>&lt;b&gt;hi&lt;/b&gt;</description></item></channel></rss>';
  const [r] = news.parseFeed(rss, FEED);
  assert.equal(r.title, 'A & B');
  assert.equal(r.url, 'https://a.example/1');
  assert.equal(r.image, 'https://a.example/i.jpg');
  assert.equal(r.snippet, 'hi');
  assert.equal(r.published, Date.UTC(2024, 0, 1));
  const atom = '<feed><title>F</title><entry><title>Atom</title><link rel="alternate" href="https://b.example/y"/>'
    + '<UPDATED>2024-01-01T00:00:00Z</UPDATED></entry></feed>';
  const [a] = news.parseFeed(atom, FEED);
  assert.equal(a.url, 'https://b.example/y');
  assert.equal(a.published, Date.UTC(2024, 0, 1), 'tag names stay case-insensitive');
});

test('isPublicFeedUrl refuses every private spelling', () => {
  for (const url of [
    'https://127.0.0.1/f', 'https://0.0.0.0/f', 'https://100.64.1.1/f', 'https://172.20.0.1/f',
    'https://[::1]/f', 'https://[::ffff:127.0.0.1]/f', 'https://[::ffff:c0a8:101]/f', 'https://[fd00::1]/f',
    'https://[64:ff9b::a00:1]/f', 'https://[2002:c0a8:101::1]/f', 'https://localhost./f', 'https://224.0.0.1/f',
    'https://2130706433/f', 'https://0x7f.1/f',
  ]) {
    assert.equal(news.isPublicFeedUrl(url), false, url);
  }
  assert.equal(news.isPublicFeedUrl('https://[2606:4700::1111]/f'), true);
  assert.equal(news.isPublicFeedUrl('https://8.8.8.8/f'), true);
});
