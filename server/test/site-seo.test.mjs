// The site read the way a crawler reads it. The unit tests pin the audit tool itself;
// the rest hold the real pages to it, so a title that grows past what a results page
// shows, or a language left out of the sitemap, fails here before it is pushed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { audit, fileToUrl, ORIGIN, pageFacts, pageIssues, siteIssues } from '../../tools/site-review/seo.mjs';
import { HOME_LANGS } from '../../tools/lang-pages.mjs';

const page = ({ head = '', body = '<h1>Name</h1>', lang = 'en', url = '/a.html' } = {}) => `<!doctype html><html lang="${lang}"><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>A title long enough to count as one</title>
<meta name="description" content="${'A description long enough to say something about the page it stands for. '.repeat(1).trim()}">
<link rel="canonical" href="${ORIGIN}${url}">
<meta property="og:title" content="t"><meta property="og:description" content="d"><meta property="og:type" content="article">
<meta property="og:url" content="${ORIGIN}${url}"><meta property="og:image" content="${ORIGIN}/images/home/og-card.png">
<meta name="twitter:card" content="summary_large_image">
${head}</head><body>${body}</body></html>`;

const codes = (issues) => issues.map((i) => i.code);
const site = (entries) => entries.map(([url, html]) => ({ url, facts: pageFacts(html) }));

test('pageFacts reads what a crawler reads and skips scripts, styles and comments', () => {
  const f = pageFacts(page({
    head: '<link rel="alternate" hreflang="it" href="https://xenon-app.com/it/a.html">',
    body: '<!-- <h1>old</h1> --><h1>Name &amp; more</h1><script>document.write("<h2>x</h2>")</script><a href="/b.html">b</a><img src="/i.webp" alt="" width="1" height="1">',
  }));
  assert.equal(f.lang, 'en');
  assert.equal(f.title, 'A title long enough to count as one');
  assert.equal(f.canonical, `${ORIGIN}/a.html`);
  assert.deepEqual(f.hreflang, [{ lang: 'it', href: 'https://xenon-app.com/it/a.html' }]);
  assert.deepEqual(f.headings, [{ level: 1, text: 'Name & more' }]);
  assert.deepEqual(f.hrefs, ['/b.html']);
  assert.equal(f.images.length, 1);
});

test('pageIssues stops at the basics for a noindex page, nothing there competes in search', () => {
  const html = page({ head: '<meta name="robots" content="noindex, follow">', body: '<h2>no h1 here</h2>' });
  assert.deepEqual(pageIssues(pageFacts(html), '/a.html'), []);
});

test('pageIssues holds CJK titles to the shorter limit', () => {
  const long = 'タ'.repeat(40);
  const ja = pageFacts(page({ lang: 'ja' }).replace(/<title>[^<]*/, `<title>${long}`));
  const en = pageFacts(page().replace(/<title>[^<]*/, `<title>${'t'.repeat(40)}`));
  assert.ok(codes(pageIssues(ja, '/a.html')).includes('title-long'));
  assert.ok(!codes(pageIssues(en, '/a.html')).includes('title-long'));
});

test('pageIssues finds a second h1, a skipped level, a canonical elsewhere and a missing card', () => {
  const two = pageIssues(pageFacts(page({ body: '<h1>a</h1><h1>b</h1>' })), '/a.html');
  assert.ok(codes(two).includes('h1-count'));
  const skip = pageIssues(pageFacts(page({ body: '<h1>a</h1><h3>b</h3>' })), '/a.html');
  assert.ok(codes(skip).includes('heading-skip'));
  const other = pageIssues(pageFacts(page()), '/b.html');
  assert.ok(codes(other).includes('canonical-other'));
  const bare = pageFacts(page().replace(/<meta name="twitter:card"[^>]*>/, '').replace(/<meta property="og:image"[^>]*>/, ''));
  const missing = codes(pageIssues(bare, '/a.html'));
  assert.ok(missing.includes('twitter-missing') && missing.includes('og-missing'));
});

test('siteIssues accepts the routes built at deploy and the catalog deep links, nothing else', () => {
  const pages = site([
    ['/', page({ url: '/', body: '<h1>x</h1><a href="/maker/">m</a><a href="/demo/">d</a><a href="/catalog/#forest">f</a><a href="/nope.html">n</a><a href="/privacy.html#gone">p</a>' })],
    ['/catalog/', page({ url: '/catalog/' })],
    ['/privacy.html', page({ url: '/privacy.html' })],
  ]);
  const found = siteIssues(pages, new Set([`${ORIGIN}/`, `${ORIGIN}/catalog/`, `${ORIGIN}/privacy.html`, `${ORIGIN}/demo/`]));
  const broken = found.filter((i) => i.code === 'link-broken').map((i) => i.text);
  const anchors = found.filter((i) => i.code === 'anchor-missing').map((i) => i.text);
  assert.deepEqual(broken, ['/nope.html goes nowhere']);
  assert.deepEqual(anchors, ['/privacy.html#gone: no #gone there']);
  assert.ok(!codes(found).includes('sitemap-dead'));
});

test('siteIssues finds a sitemap that disagrees with the pages', () => {
  const pages = site([
    ['/', page({ url: '/', body: '<h1>x</h1><a href="/a.html">a</a><a href="/b.html">b</a>' })],
    ['/a.html', page({ url: '/a.html' })],
    ['/b.html', page({ url: '/b.html', head: '<meta name="robots" content="noindex">' })],
  ]);
  const found = codes(siteIssues(pages, new Set([`${ORIGIN}/`, `${ORIGIN}/b.html`, `${ORIGIN}/gone.html`])));
  assert.ok(found.includes('sitemap-missing'), '/a.html is left out');
  assert.ok(found.includes('sitemap-noindex'), '/b.html is listed but noindex');
  assert.ok(found.includes('sitemap-dead'), '/gone.html is not a page');
});

test('siteIssues finds an hreflang pair that does not point back: Google ignores those', () => {
  const alt = (href, lang) => `<link rel="alternate" hreflang="${lang}" href="${ORIGIN}${href}">`;
  const pages = site([
    ['/a.html', page({ url: '/a.html', head: alt('/a.html', 'en') + alt('/it/a.html', 'it') + alt('/a.html', 'x-default') })],
    ['/it/a.html', page({ url: '/it/a.html', lang: 'it' })],
  ]);
  assert.ok(codes(siteIssues(pages, new Set())).includes('hreflang-oneway'));
});

test('fileToUrl gives a page the address it uses for itself', () => {
  assert.equal(fileToUrl('index.html'), '/');
  assert.equal(fileToUrl(path.join('it', 'index.html')), '/it/');
  assert.equal(fileToUrl(path.join('catalog', 'forest', 'index.html')), '/catalog/forest/');
  assert.equal(fileToUrl('deck.html'), '/deck.html');
});

const { pages, sitemap, issues } = audit();
const found = (...list) => issues.filter((i) => list.includes(i.code)).map((i) => `${i.url}: ${i.text}`);

test('no page of the site has an error a crawler would stop on', () => {
  assert.deepEqual(issues.filter((i) => i.level === 'error').map((i) => `${i.code} ${i.url}: ${i.text}`), []);
});

test('every language of the home is in the sitemap, and so is every indexable page', () => {
  for (const lang of HOME_LANGS) assert.ok(sitemap.has(`${ORIGIN}/${lang}/`), `/${lang}/`);
  assert.deepEqual(found('sitemap-missing'), []);
});

test('a link to any page shows a card: picture, address and title on every indexable page', () => {
  assert.deepEqual(found('og-missing', 'og-url-differs', 'twitter-missing'), []);
});

test('titles and descriptions fit a results page in every language', () => {
  assert.deepEqual(found('title-long', 'title-short', 'desc-long', 'desc-short'), []);
});

test('one h1 per page and no skipped heading level', () => {
  assert.deepEqual(found('h1-count', 'heading-skip', 'heading-empty'), []);
});

test('no two indexable pages share a title or a description', () => {
  assert.deepEqual(found('title-duplicate', 'desc-duplicate'), []);
});

test('the app answers to the old name people still search', () => {
  const html = fs.readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8');
  const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
  const app = graph.find((n) => n['@type'] === 'SoftwareApplication');
  assert.ok(app.alternateName.includes('Xenon Edge'));
});

test('the audit really walked the site', () => {
  assert.ok(pages.length > 150, `${pages.length} pages`);
  assert.ok(sitemap.size > 150, `${sitemap.size} sitemap lines`);
});
