// The storefront layout decides what the Store shows, in what order and in what
// shape, and it is read by TWO independent renderers: the website catalog
// (docs/catalog/index.html, a deliberately self-contained single file) and the
// in-app Store. The canonical contract lives in packages/core; the website
// carries a mirrored copy because it cannot import anything.
//
// That mirror is exactly the kind of duplication that already bit this project
// once — `spotlightPick` was copied into both storefronts and they drifted. So
// this test runs the website's own copy against the canonical one and fails on
// any disagreement, rather than trusting a comment to keep them in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const canon = require(join(ROOT, 'packages', 'core', 'src', 'storefront-layout.js'));
const PAGE = join(ROOT, 'docs', 'catalog', 'index.html');

// Lift the mirrored normalizer out of the page and run it in isolation.
function loadMirror() {
  const html = readFileSync(PAGE, 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length, 'no inline script found in the catalog page');
  const main = scripts.reduce((a, b) => (a.length > b.length ? a : b));
  const start = main.indexOf('const SF_TYPES');
  const end = main.indexOf('const sfFind');
  assert.ok(start >= 0 && end > start,
    'the catalog page no longer carries the SF_* layout mirror — if it was replaced by a real import, delete this test');
  const sandbox = { globalThis: {} };
  vm.createContext(sandbox);
  vm.runInContext(main.slice(start, end) + '\n;globalThis.__sf = { sfNormalize, sfAutoplay, sfBlock, SF_DEFAULT, SF_TYPES };', sandbox);
  return sandbox.globalThis.__sf;
}

const CASES = [
  null, undefined, {}, { blocks: [] }, { blocks: 'nope' }, { blocks: {} },
  { blocks: [{ type: 'supporters' }, { type: 'limited' }, { type: 'spotlight' }] },
  { blocks: [{ type: 'spotlight', form: 'hero' }, { type: 'spotlight', form: 'grid' }] },
  { blocks: [{ type: 'supporters', form: 'hero-column', source: 'manual', autoplayOver: 999 }] },
  { blocks: [{ type: 'kinds' }] },
  { blocks: [null, 5, { type: 'nope' }, { type: 'archive', on: false }] },
  { blocks: [{ type: 'limited', source: 'auto-all', max: 3 }] },
];

test('the catalog page parses as JavaScript', () => {
  const html = readFileSync(PAGE, 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const src of scripts) {
    assert.doesNotThrow(() => new vm.Script(src), 'an inline script in the live catalog page does not parse');
  }
});

test('the website mirror normalizes every layout exactly like packages/core', () => {
  const mirror = loadMirror();
  for (const c of CASES) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(mirror.sfNormalize(c))),
      JSON.parse(JSON.stringify(canon.normalizeLayout(c))),
      'mirror drifted for ' + JSON.stringify(c),
    );
  }
});

test('the website mirror agrees on the autoplay threshold', () => {
  const mirror = loadMirror();
  for (const over of [0, 4, 8]) {
    const block = canon.normalizeBlock({ type: 'supporters', autoplayOver: over });
    for (const count of [0, 1, 4, 5, 9, 50]) {
      assert.equal(mirror.sfAutoplay(block, count), canon.shouldAutoplay(block, count),
        `autoplay disagreed at over=${over} count=${count}`);
    }
  }
});

test('both copies know the same block types', () => {
  const mirror = loadMirror();
  assert.deepEqual([...mirror.SF_TYPES].sort(), [...canon.BLOCK_TYPES].sort());
  assert.deepEqual(
    JSON.parse(JSON.stringify(mirror.SF_DEFAULT)),
    JSON.parse(JSON.stringify(canon.DEFAULT_BLOCKS)),
    'the fallback order differs, so an absent layout would render two different pages',
  );
});

// A block type nothing draws is worse than one that does not exist: the admin
// enables it, saves, and the section simply never appears — with no error
// anywhere to explain why. Both renderers walk the layout as a chain of
// `b.type === '<type>'` branches, so the coverage is checkable from the source.
// The app reads the shared module directly (no mirror to drift), which is why
// this checks the BRANCHES here and the normalizer only for the website.
test('both storefronts draw every block type the contract defines', () => {
  const RENDERERS = [
    ['docs/catalog/index.html', join(ROOT, 'docs', 'catalog', 'index.html')],
    ['server/js/community-gallery.js', join(ROOT, 'server', 'js', 'community-gallery.js')],
  ];
  for (const [label, file] of RENDERERS) {
    const src = readFileSync(file, 'utf8');
    const handled = new Set(
      [...src.matchAll(/b\.type === '([a-z]+)'/g)].map((m) => m[1]),
    );
    for (const type of canon.BLOCK_TYPES) {
      assert.ok(handled.has(type),
        `${label} has no branch for the '${type}' block — enabling it in the admin would render nothing`);
    }
    for (const type of handled) {
      assert.ok(canon.BLOCK_TYPES.includes(type),
        `${label} draws a '${type}' block the contract does not define, so normalizeLayout drops it before it is ever reached`);
    }
  }
});

test('the page ships a translation for every section heading it renders', () => {
  const html = readFileSync(PAGE, 'utf8');
  // One entry per UI language block; each must carry the new headings or a
  // section renders as an empty string on that language.
  const langBlocks = html.match(/'sec\.freehead':/g) || [];
  for (const key of ['sec.newhead', 'sec.archive', 'sec.archive_sub']) {
    const found = (html.match(new RegExp("'" + key.replace('.', '\\.') + "':", 'g')) || []).length;
    assert.equal(found, langBlocks.length,
      `${key} is missing from ${langBlocks.length - found} of ${langBlocks.length} language blocks`);
  }
});
