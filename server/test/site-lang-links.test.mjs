// The site's language copies (docs/<lang>/*.html, built by
// tools/build-page-langs.mjs) live one folder below the English page, so a
// relative link that works at the root lands on a page that does not exist.
// Search Console reported /zh/catalog/, /ja/catalog/, /ko/catalog/ and
// /zh/create/ as 404 (Oct 2026): the FAQ translations write href='catalog/'
// with single quotes and the builder only rewrote double-quoted links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs');
const LANGS = ['es', 'fr', 'it', 'ja', 'ko', 'zh'];
// Served on xenon-app.com but not from docs/: Xenon Maker is built in its own
// private repo. It must be live before the home that links it is published.
const NOT_IN_DOCS = new Set(['/maker/']);

// A site path is served by a file, a folder's index.html, or a published
// folder (catalog/creator pages are generated into folders of their own).
function exists(urlPath) {
  const p = path.join(DOCS, decodeURIComponent(urlPath));
  if (urlPath.endsWith('/')) return fs.existsSync(path.join(p, 'index.html'));
  return fs.existsSync(p) || fs.existsSync(path.join(p, 'index.html'));
}

function internalLinks(html) {
  const out = [];
  for (const m of html.matchAll(/\s(?:href|src)=(["'])(.*?)\1/g)) {
    const url = m[2];
    if (!url || /^(https?:|mailto:|tel:|data:|#|javascript:|\/\/)/i.test(url)) continue;
    out.push(url);
  }
  return out;
}

test('language copies carry no relative links (they would resolve one folder down)', () => {
  const bad = [];
  for (const lang of LANGS) {
    for (const file of fs.readdirSync(path.join(DOCS, lang)).filter((f) => f.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(DOCS, lang, file), 'utf8');
      for (const url of internalLinks(html)) if (!url.startsWith('/')) bad.push(`${lang}/${file}: ${url}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('every root-relative link in a language copy points at a page that exists', () => {
  const missing = new Set();
  for (const lang of LANGS) {
    for (const file of fs.readdirSync(path.join(DOCS, lang)).filter((f) => f.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(DOCS, lang, file), 'utf8');
      for (const url of internalLinks(html)) {
        const p = url.split(/[?#]/)[0];
        if (p.startsWith('/') && !NOT_IN_DOCS.has(p) && !exists(p)) missing.add(`${lang}/${file}: ${p}`);
      }
    }
  }
  assert.deepEqual([...missing], []);
});
