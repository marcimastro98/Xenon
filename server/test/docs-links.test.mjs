import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// README.md and FEATURES.md are what GitHub shows first. A renamed heading or a moved
// picture breaks them without a word, so every picture and every in-page link is
// checked here, with the slug rule GitHub itself uses.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (name) => readFileSync(path.join(ROOT, name), 'utf8');
const README = read('README.md');
const FEATURES = read('FEATURES.md');

const withoutFences = (text) => text.replace(/^```[\s\S]*?^```$/gm, '');

// GitHub: lower case, punctuation out, each space a hyphen, a repeat gets -1, -2...
function anchorsOf(text) {
  const seen = new Map();
  const anchors = new Set();
  for (const [, heading] of withoutFences(text).matchAll(/^#{1,6} (.+)$/gm)) {
    const plain = heading.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '');
    const slug = plain.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = seen.get(slug) || 0;
    seen.set(slug, count + 1);
    anchors.add(count ? `${slug}-${count}` : slug);
  }
  return anchors;
}

function picturesOf(text) {
  const body = withoutFences(text);
  const markdown = [...body.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  const html = [...body.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  return [...markdown, ...html].filter((src) => !/^https?:/.test(src));
}

const linksOf = (text) => [...withoutFences(text).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);

test('the slug rule matches what GitHub makes of a heading', () => {
  const anchors = anchorsOf('# Share & import\n## Capture (screenshots, recordings)\n## Bit, the assistant\n## Bit, the assistant\n```\n## not a heading\n```\n');
  assert.deepEqual([...anchors], ['share--import', 'capture-screenshots-recordings', 'bit-the-assistant', 'bit-the-assistant-1']);
});

test('every picture the two pages show exists', () => {
  for (const [name, text] of [['README.md', README], ['FEATURES.md', FEATURES]]) {
    const pictures = picturesOf(text);
    assert.ok(pictures.length > 5, `${name} has pictures`);
    for (const src of pictures) assert.ok(existsSync(path.join(ROOT, src)), `${name}: ${src}`);
  }
});

test('FEATURES.md shows only pictures of the current look', () => {
  // The old PNGs stay in docs/images for posts that link them, never here.
  assert.deepEqual(picturesOf(FEATURES).filter((src) => /^docs\/images\/[^/]+$/.test(src)), []);
  assert.deepEqual(picturesOf(README).filter((src) => /^docs\/images\/[^/]+\.png$/.test(src)), []);
});

test('every in-page link lands on a heading', () => {
  const readmeAnchors = anchorsOf(README);
  const featureAnchors = anchorsOf(FEATURES);
  for (const link of linksOf(README)) {
    if (link.startsWith('#')) assert.ok(readmeAnchors.has(link.slice(1)), `README.md: ${link}`);
    if (link.startsWith('FEATURES.md#')) assert.ok(featureAnchors.has(link.split('#')[1]), `README.md: ${link}`);
  }
  for (const link of linksOf(FEATURES)) {
    if (link.startsWith('#')) assert.ok(featureAnchors.has(link.slice(1)), `FEATURES.md: ${link}`);
  }
});

test('every local file the two pages link to exists', () => {
  for (const [name, text] of [['README.md', README], ['FEATURES.md', FEATURES]]) {
    for (const link of linksOf(text)) {
      if (/^(https?:|mailto:|#)/.test(link)) continue;
      assert.ok(existsSync(path.join(ROOT, link.split('#')[0])), `${name}: ${link}`);
    }
  }
});

test('the README headings the site, the app and the changelog link to are still there', () => {
  const anchors = anchorsOf(README);
  for (const anchor of ['if-windows-blocks-the-download-or-flags-xenon-as-a-virus', 'platform-support', 'macos', 'linux',
    'give-xenon-full-disk-access-once', 'if-xenon-simply-will-not-start-smart-app-control']) {
    assert.ok(anchors.has(anchor), anchor);
  }
});

test('the two pages keep the plain voice and the facts of today', () => {
  for (const [name, text] of [['README.md', README], ['FEATURES.md', FEATURES]]) {
    const prose = withoutFences(text);
    assert.doesNotMatch(prose, /—/, `${name}: no em dash`);
    assert.doesNotMatch(prose, /18\.15/, `${name}: the old Node floor`);
    assert.doesNotMatch(prose, /no telemetry/i, `${name}: the app has three anonymous counters`);
    assert.doesNotMatch(prose, /Xenon AI\b/, `${name}: the assistant is Bit`);
    assert.doesNotMatch(prose, /Dynamic Island/, `${name}: the setting is Top bar`);
    assert.doesNotMatch(prose, /xenonedge\.app/, `${name}: the site is xenon-app.com`);
  }
});
