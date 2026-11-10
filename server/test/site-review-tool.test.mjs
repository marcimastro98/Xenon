// tools/site-review: the colour maths behind the contrast check, the request
// policy (nothing leaves for analytics, no writes anywhere) and the options.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseColor, over, contrastRatio, contrastNeeded, problems, PAGE_LIB, auditPage } from '../../tools/site-review/checks.mjs';
import { parseArgs, pageUrl, allowRequest, DEFAULTS } from '../../tools/site-review/review.mjs';
import { isMainKey, screenProblems, pagesFor } from '../../tools/site-review/actions.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DOCS_DIR } from '../../tools/site-shots/serve.mjs';

test('colours parse in the forms getComputedStyle returns', () => {
  assert.deepEqual(parseColor('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 });
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.equal(parseColor('transparent'), null);
  assert.equal(parseColor('color(srgb 1 0 0)'), null);
});

test('contrast matches the WCAG reference values', () => {
  const black = { r: 0, g: 0, b: 0, a: 1 };
  const white = { r: 255, g: 255, b: 255, a: 1 };
  assert.equal(contrastRatio(black, white).toFixed(1), '21.0');
  assert.equal(contrastRatio(white, white), 1);
  // #767676 on white is the classic 4.54:1 grey.
  assert.equal(contrastRatio({ r: 118, g: 118, b: 118, a: 1 }, white).toFixed(2), '4.54');
  // Half-transparent black over white is mid grey.
  assert.deepEqual(over({ r: 0, g: 0, b: 0, a: 0.5 }, white), { r: 127.5, g: 127.5, b: 127.5, a: 1 });
});

test('large text needs 3:1, body text 4.5:1', () => {
  assert.equal(contrastNeeded(16, 400), 4.5);
  assert.equal(contrastNeeded(24, 400), 3);
  assert.equal(contrastNeeded(19, 700), 3);
  assert.equal(contrastNeeded(19, 600), 4.5);
});

test('the page audit only calls helpers that are shipped with it', () => {
  for (const fn of ['parseColor', 'over', 'contrastRatio', 'contrastNeeded']) {
    assert.match(PAGE_LIB, new RegExp(`function ${fn}\\(`));
  }
  assert.doesNotMatch(auditPage.toString(), /\bimport\b|require\(/);
});

test('problems lists every budget a page breaks and nothing for a clean one', () => {
  const clean = { pageWidth: 390, viewport: 390, overflow: [], targets: [], clipped: [], contrast: [], lcp: 1200, cls: 0.01, errors: [] };
  assert.deepEqual(problems(clean), []);
  const bad = { ...clean, pageWidth: 420, targets: ['a'], lcp: 3100, cls: 0.2, errors: ['x'] };
  assert.deepEqual(problems(bad), ['page scrolls sideways (420 > 390)', 'targets: 1', 'LCP 3100 ms > 2500', 'CLS 0.200 > 0.1', 'errors: 1']);
});

test('nothing is posted and analytics never loads', () => {
  const base = 'http://127.0.0.1:5000';
  assert.ok(allowRequest(`${base}/images/a.webp`, 'GET', base, false));
  assert.ok(allowRequest(`${base}/x`, 'POST', base, false));
  assert.ok(allowRequest('https://api.github.com/repos/x', 'GET', base, false));
  assert.equal(allowRequest('https://xenon-supporter-hub.xenonedge.workers.dev/usage', 'POST', base, false), false);
  assert.equal(allowRequest('https://www.googletagmanager.com/gtag/js', 'GET', base, false), false);
  assert.equal(allowRequest('https://static.cloudflareinsights.com/beacon.min.js', 'GET', base, false), false);
  assert.equal(allowRequest('https://api.github.com/repos/x', 'GET', base, true), false);
});

test('options and page addresses', () => {
  const d = parseArgs([]);
  assert.deepEqual([d.widths, d.themes, d.langs], [DEFAULTS.widths, DEFAULTS.themes, DEFAULTS.langs]);
  const o = parseArgs(['--widths', '390,9999,1440', '--themes', 'dark,blue', '--langs', 'it', '--offline', '--no-shots']);
  assert.deepEqual([o.widths, o.themes, o.langs, o.offline, o.shots], [[390, 1440], ['dark'], ['it'], true, false]);
  assert.throws(() => parseArgs(['--langs', 'english']), /empty/);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
  assert.equal(pageUrl('http://h:1', '/', 'en'), 'http://h:1/');
  assert.equal(pageUrl('http://h:1/', 'single-screen.html', 'ja'), 'http://h:1/ja/single-screen.html');
});

test('test-bench noise is not a page error, real failures are', async () => {
  const { pageError, viewportFor, MIN_TARGET } = await import('../../tools/site-review/review.mjs');
  assert.equal(pageError("Access to fetch at 'https://hub/catalog' from origin 'http://127.0.0.1:5' has been blocked by CORS policy"), null);
  assert.equal(pageError('Failed to load resource: the server responded with a status of 403 ()'), null);
  assert.equal(pageError('TypeError: x is undefined'), 'TypeError: x is undefined');
  assert.deepEqual(viewportFor(390), { width: 390, height: 844 });
  assert.deepEqual(viewportFor(768), { width: 768, height: 1024 });
  assert.deepEqual(MIN_TARGET, { touch: 44, pointer: 24 });
});

test('the page tour takes its options, and lists pages that exist', async () => {
  const { parseArgs, PAGES } = await import('../../tools/site-review/tour.mjs');
  assert.deepEqual(parseArgs(['--theme', 'dark', '--width', '390', '/faq.html']).pages, ['/faq.html']);
  assert.equal(parseArgs(['--theme', 'dark']).theme, 'dark');
  assert.equal(parseArgs([]).pages, PAGES);
  assert.throws(() => parseArgs(['--width', '9']), /--width/);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
  for (const url of PAGES) {
    const file = url.endsWith('/') ? url + 'index.html' : url;
    assert.ok(existsSync(join(DOCS_DIR, file)), url);
  }
});

test('the forms walk answers only the stubbed hub routes, and refuses the rest', async () => {
  const { parseArgs, hubReply, AUDIT, STATES } = await import('../../tools/site-review/forms.mjs');
  assert.equal(parseArgs(['--lang', 'ja']).lang, 'ja');
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
  assert.equal(hubReply('https://hub/submit', null).json.id, 'sub_abc123');
  assert.equal(hubReply('https://hub/audit', null).json, AUDIT);
  assert.equal(hubReply('https://hub/submission/status', STATES.fix).json.submission, STATES.fix);
  assert.equal(hubReply('https://hub/submission/status', 429).status, 429);
  assert.equal(hubReply('https://hub/submission/status', 'offline').abort, true);
  assert.equal(hubReply('https://challenges.cloudflare.com/turnstile/v0/api.js', null).abort, true);
});

const control = (over = {}) => ({ text: 'Download', filled: true, pressed: false, size: 19, weight: 700, ...over });

test('a main key is a filled action in the key type, not a tab, a card or a cookie button', () => {
  assert.equal(isMainKey(control()), true);
  assert.equal(isMainKey(control({ filled: false })), false, 'an outlined key is the second action');
  assert.equal(isMainKey(control({ pressed: true })), false, 'a pressed theme chip is a choice');
  assert.equal(isMainKey(control({ size: 13.5, weight: 600 })), false, 'the cookie buttons');
  assert.equal(isMainKey(control({ size: 16, weight: 400 })), false, 'a filled card');
});

test('two main keys on one screen are a problem, and the report names them', () => {
  assert.deepEqual(screenProblems('/x.html', [control(), control({ filled: false })]), []);
  const [line] = screenProblems('/x.html', [control({ text: 'Download' }), control({ text: 'Join' })]);
  assert.match(line, /^\/x\.html: 2 filled keys/);
  assert.match(line, /"Download", "Join"/);
});

test('the walk covers the top pages, the folders and a language', () => {
  const en = pagesFor('en', ['index.html', 'deck.html', 'google1e9.html', 'site.css']);
  assert.ok(en.includes('/deck.html') && en.includes('/get/') && en.includes('/catalog/'));
  assert.ok(!en.some((url) => url.includes('google')), 'a verification file is not a page');
  const it = pagesFor('it');
  assert.equal(it[0], '/it/');
  assert.ok(it.includes('/it/download.html'));
});
