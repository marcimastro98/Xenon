// tools/site-review: the colour maths behind the contrast check, the request
// policy (nothing leaves for analytics, no writes anywhere) and the options.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseColor, over, contrastRatio, contrastNeeded, problems, PAGE_LIB, auditPage } from '../../tools/site-review/checks.mjs';
import { parseArgs, pageUrl, allowRequest, DEFAULTS } from '../../tools/site-review/review.mjs';

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
