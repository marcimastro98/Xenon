// Xenon's official channels: one list (SOCIAL in tools/site-chrome.mjs) drawn as
// an icon row in every site footer, the home's own copy of it, and the
// Organization sameAs the home gives search engines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOCIAL, footerHtml } from '../../tools/site-chrome.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const HREFS = SOCIAL.map((s) => s.href);
const rowHrefs = (html, cls) => {
  const at = html.indexOf(`<ul class="${cls}">`);
  assert.ok(at >= 0, `no ${cls} row`);
  return [...html.slice(at, html.indexOf('</ul>', at)).matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
};

test('the shared footer links every official channel, in a new tab, with its name', () => {
  const f = footerHtml();
  assert.deepEqual(rowHrefs(f, 'xf-social'), HREFS);
  for (const { href, label } of SOCIAL) {
    const a = f.match(new RegExp(`<a href="${href.replace(/[.?]/g, '\\$&')}"[^>]*>`))[0];
    assert.match(a, /target="_blank" rel="noopener"/, href);
    assert.match(a, new RegExp(`aria-label="${label}"`), href);
  }
});

test('the home carries the same row, drawn from the same marks', () => {
  const home = read('docs/index.html');
  assert.deepEqual(rowHrefs(home, 'ft-social'), HREFS);
  for (const s of SOCIAL.filter((x) => x.d)) {
    assert.ok(home.includes(`<symbol id="i-${s.k}" viewBox="0 0 24 24"><path fill="currentColor"${s.evenodd ? ' fill-rule="evenodd"' : ''} d="${s.d}"/>`), `sprite i-${s.k}`);
  }
});

test('the home Organization lists every channel in sameAs, with the Store kept', () => {
  const home = read('docs/index.html');
  const ld = JSON.parse(home.match(/<script type="application\/ld\+json">\s*(\{[\s\S]*?\})\s*<\/script>/)[1]);
  const org = ld['@graph'].find((n) => n['@id'] === 'https://xenon-app.com/#org');
  for (const href of [...HREFS, 'https://apps.microsoft.com/detail/XPFCJFFQ3DQSK0']) assert.ok(org.sameAs.includes(href), href);
});

test('the home head carries the Meta domain verification tag', () => {
  assert.match(read('docs/index.html'), /<meta name="facebook-domain-verification" content="[a-z0-9]+" \/>/);
});

test('every page on disk with the shared footer carries the current row', () => {
  let seen = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && e.name !== 'demo') walk(p);
      else if (e.name.endsWith('.html')) {
        const html = readFileSync(p, 'utf8');
        if (!html.includes('<!-- xenon:footer -->')) continue;
        seen++;
        assert.deepEqual(rowHrefs(html, 'xf-social'), HREFS, relative(root, p));
      }
    }
  };
  walk(join(root, 'docs'));
  assert.ok(seen > 40, `only ${seen} pages with the footer`);
});
