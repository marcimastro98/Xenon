// Store descriptions are a small Markdown subset, read by the in-app Store
// (packages/core/src/rich-text.js through server/shared) and by the website
// catalog, which is a self-contained page and carries a mirrored copy. This
// runs the page's copy against the canonical one, the way the storefront layout
// mirror is checked, so the two storefronts cannot format a description
// differently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const canon = require(join(ROOT, 'packages', 'core', 'src', 'rich-text.js'));

function loadMirror() {
  const html = readFileSync(join(ROOT, 'docs', 'catalog', 'index.html'), 'utf8');
  const start = html.indexOf('const richText = (function () {');
  const end = html.indexOf('/* ── end rich descriptions ── */');
  assert.ok(start >= 0 && end > start, 'the catalog page no longer carries the rich-text mirror');
  const sandbox = { globalThis: {} };
  vm.createContext(sandbox);
  vm.runInContext(html.slice(start, end) + '\n;globalThis.__rt = richText;', sandbox);
  return sandbox.globalThis.__rt;
}

const CASES = [
  '', 'A clean clock.', 'Line one\nline two',
  'Intro.\r\n\r\n* **Live Scores:** auto.\r\n* **Themes:** all of them.',
  '# Setup\n1. Open *Settings*\n2. Paste `key_id`\n   then save',
  '**bold with _italic_ inside**', 'use my_widget_id and 2 * 3 * 4', '**not closed',
  '\\*not italic\\* and \\# not a heading', 'See [the docs](https://example.com) now',
  '<img src=x onerror=alert(1)>', '- a\n- b\n\n1. c\n2) d', '• pasted bullet\n• another',
  'x'.repeat(2000),
];

test('the catalog page formats descriptions exactly like the app', () => {
  const mirror = loadMirror();
  assert.equal(mirror.DESCRIPTION_MAX, canon.DESCRIPTION_MAX);
  for (const c of CASES) {
    assert.deepEqual(JSON.parse(JSON.stringify(mirror.parse(c))), canon.parse(c), 'parse: ' + c.slice(0, 40));
    assert.equal(mirror.plain(c), canon.plain(c), 'plain: ' + c.slice(0, 40));
  }
});

test('the app loads the shared module and uses it for every description', () => {
  const page = readFileSync(join(ROOT, 'server', 'index.html'), 'utf8');
  assert.match(page, /<script src="shared\/src\/rich-text\.js"><\/script>/);
  const gallery = readFileSync(join(ROOT, 'server', 'js', 'community-gallery.js'), 'utf8');
  assert.doesNotMatch(gallery, /el\('[^']+', '[^']+', entry\.description\)/, 'a description rendered raw');
  assert.match(gallery, /descInto\(el\('div', 'cgal-detail-desc'\), entry\.description\)/);
  const site = readFileSync(join(ROOT, 'docs', 'catalog', 'index.html'), 'utf8');
  assert.doesNotMatch(site, /el\('p', '[^']+', entry\.description/, 'a description rendered raw on the site');
});
