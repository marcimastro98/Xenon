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
  vm.runInContext(main.slice(start, end)
    + '\n;globalThis.__sf = { sfNormalize, sfAutoplay, sfBlock, sfSplitLimited, SF_DEFAULT, SF_TYPES };', sandbox);
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

// ── The limited/Archive split ────────────────────────────────────────────────
// This is the one rule where a mistake is not cosmetic: it decides whether a
// drop appears once, twice, or not at all. It got all three wrong before being
// shared — 'auto-all' with the Archive on rendered the same entry in BOTH
// sections, duplicating its DOM anchor and double-counting it.
const LIM = [
  { id: 'live1', out: false }, { id: 'live2', out: false },
  { id: 'gone1', out: true }, { id: 'gone2', out: true },
];
const OUT = (e) => e.out;
const ids = (list) => list.map((e) => e.id);

const SPLIT_CASES = [
  ['archive on, shelf auto-live', [{ type: 'limited', source: 'auto-live' }, { type: 'archive', on: true }]],
  ['archive off', [{ type: 'limited', source: 'auto-live' }, { type: 'archive', on: false }]],
  ['shelf auto-all, archive on', [{ type: 'limited', source: 'auto-all' }, { type: 'archive', on: true }]],
  ['shelf auto-all, archive off', [{ type: 'limited', source: 'auto-all' }, { type: 'archive', on: false }]],
  ['defaults', null],
];

test('an entry is never in both the Limited shelf and the Archive', () => {
  for (const [label, blocks] of SPLIT_CASES) {
    const { shelf, archive } = canon.splitLimited(LIM, blocks, OUT);
    const both = ids(shelf).filter((id) => ids(archive).includes(id));
    assert.deepEqual(both, [], `${label}: ${both.join(',')} would render twice`);
    // A drop somebody can still claim must be on the shelf in every arrangement.
    // (A finished one may be dropped from it — with the Archive off that is the
    // deliberate old rule, and it stays reachable through search and the Limited
    // tab.)
    for (const e of LIM.filter((x) => !OUT(x))) {
      assert.ok(ids(shelf).includes(e.id), `${label}: ${e.id} is claimable and nowhere on the shelf`);
    }
    const layout = canon.normalizeLayout({ blocks });
    const lim = layout.find((b) => b.type === 'limited');
    const arch = layout.find((b) => b.type === 'archive');
    if (lim.source === 'auto-all') {
      assert.deepEqual(ids(shelf), ids(LIM), `${label}: auto-all asked for every drop`);
      assert.deepEqual(archive, [], `${label}: the shelf took them, so the Archive holds nothing`);
    } else if (arch.on) {
      assert.deepEqual([...ids(shelf), ...ids(archive)].sort(), ids(LIM).sort(),
        `${label}: every drop has to land somewhere`);
    }
  }
});

test('a tier with nothing claimable keeps its shelf rather than vanishing', () => {
  const allGone = [{ id: 'a', out: true }, { id: 'b', out: true }];
  const off = [{ type: 'archive', on: false }];
  assert.deepEqual(ids(canon.splitLimited(allGone, off, OUT).shelf), ['a', 'b'],
    'the section explains the tier, so it must not disappear when every drop is finished');
});

test('the website mirror splits the limited tier exactly like packages/core', () => {
  const mirror = loadMirror();
  assert.equal(typeof mirror.sfSplitLimited, 'function',
    'the catalog page lost its sfSplitLimited mirror');
  for (const [label, blocks] of SPLIT_CASES) {
    const a = mirror.sfSplitLimited(LIM, blocks, OUT);
    const b = canon.splitLimited(LIM, blocks, OUT);
    // The mirror runs in a vm context, so its arrays carry that realm's
    // Array.prototype and deepStrictEqual fails on identical contents. Compare the
    // shapes as plain data, like the other mirror tests above.
    assert.equal(
      JSON.stringify([ids(a.shelf), ids(a.archive)]),
      JSON.stringify([ids(b.shelf), ids(b.archive)]),
      'mirror drifted for ' + label,
    );
  }
});

test('both storefronts route the limited tier through the shared split', () => {
  // A renderer that computes it inline is the drift this replaced, so the call
  // itself is what gets pinned.
  const site = readFileSync(PAGE, 'utf8');
  assert.match(site, /sfSplitLimited\(limited,\s*LAYOUT/,
    'the website catalog no longer uses the shared split');
  const app = readFileSync(join(ROOT, 'server', 'js', 'community-gallery.js'), 'utf8');
  assert.match(app, /storefront\.splitLimited\(limited,\s*LAYOUT/,
    'the in-app Store no longer uses the shared split');
});
