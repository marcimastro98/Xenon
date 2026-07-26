// The storefront layout is read by two independent renderers (the website
// catalog and the in-app Store) off a document a human edits in the hub admin.
// Every test here is about the same promise: a bad or old layout degrades to
// the previous fixed order instead of rendering a blank public storefront.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sf = require(join(ROOT, 'src', 'storefront-layout.js'));

const types = (blocks) => blocks.map((b) => b.type);

test('an absent layout reproduces the previous fixed order exactly', () => {
  const expected = types(sf.DEFAULT_BLOCKS);
  assert.deepEqual(types(sf.layoutOf(null)), expected);
  assert.deepEqual(types(sf.layoutOf({})), expected);
  assert.deepEqual(types(sf.layoutOf({ entries: [] })), expected);
  assert.deepEqual(types(sf.normalizeLayout({ blocks: [] })), expected);
});

test('hostile input degrades to the default rather than throwing or emptying', () => {
  for (const bad of [undefined, 0, '', 'layout', [], { blocks: 'nope' }, { blocks: {} }]) {
    const out = sf.normalizeLayout(bad);
    assert.ok(out.length >= sf.DEFAULT_BLOCKS.length, 'never empty for ' + JSON.stringify(bad));
  }
  // Junk entries inside a valid list are dropped, the good ones survive.
  const mixed = sf.normalizeLayout({ blocks: [null, 5, { type: 'nope' }, { type: 'limited' }] });
  assert.equal(mixed[0].type, 'limited');
});

test('the admin order is honoured', () => {
  const out = sf.normalizeLayout({
    blocks: [{ type: 'supporters' }, { type: 'limited' }, { type: 'spotlight' }],
  });
  assert.deepEqual(types(out).slice(0, 3), ['supporters', 'limited', 'spotlight']);
});

test('a duplicated block type collapses — an entry may never render twice', () => {
  // Two spotlights would draw the same entry twice and duplicate its DOM id,
  // which breaks deep links and double-counts it.
  const out = sf.normalizeLayout({
    blocks: [{ type: 'spotlight', max: 3 }, { type: 'spotlight', max: 9 }],
  });
  assert.equal(out.filter((b) => b.type === 'spotlight').length, 1);
  assert.equal(out[0].max, 3, 'the first one wins');
});

test('a block type the layout never heard of is appended, and stays off', () => {
  // A layout written before `archive` existed must keep working and must not
  // silently start showing a section its author never approved.
  const out = sf.normalizeLayout({ blocks: [{ type: 'kinds' }] });
  const archive = out.find((b) => b.type === 'archive');
  assert.ok(archive, 'missing types are appended');
  assert.equal(archive.on, false, 'and are not turned on behind the admin');
  assert.equal(out[0].type, 'kinds', 'the declared one keeps its place');
});

test('form and source fall back to the first valid value for the type', () => {
  const b = sf.normalizeBlock({ type: 'supporters', form: 'hero-column', source: 'manual' });
  assert.equal(b.form, 'rail', 'a form that block cannot draw is refused');
  assert.equal(b.source, 'auto', 'so is a source it cannot fill from');
  const ok = sf.normalizeBlock({ type: 'limited', form: 'carousel', source: 'auto-all' });
  assert.equal(ok.form, 'carousel');
  assert.equal(ok.source, 'auto-all');
});

test('a block offers a choice only where the choice changes what is drawn', () => {
  // The panel shipped with three-way form pickers whose alternatives rendered
  // identically, because `form` is read in exactly one place. A control that
  // changes nothing makes every other control suspect, so a form/source list may
  // only hold a second value once BOTH storefronts can act on it.
  for (const type of sf.BLOCK_TYPES) {
    for (const [what, list] of [['form', sf.FORMS[type]], ['source', sf.SOURCES[type]]]) {
      assert.ok(Array.isArray(list) && list.length >= 1, `${type} has no ${what}`);
      assert.deepEqual([...new Set(list)], list, `${type} lists a ${what} twice`);
    }
  }
  // The one real choice today, and the only one the renderers branch on.
  assert.deepEqual(sf.SOURCES.limited, ['auto-live', 'auto-all']);
  // The three tier sections can be drawn as tall hero cards or as the compact
  // card grid — a real, visible difference, and the reason the control exists at
  // all. Every other block has one form: a second value may only be listed once
  // BOTH storefronts actually draw it, or the panel starts lying again.
  assert.deepEqual(sf.FORMS.limited, ['carousel', 'grid']);
  assert.deepEqual(sf.FORMS.supporters, ['rail', 'grid']);
  assert.deepEqual(sf.FORMS.archive, ['rail-quiet', 'grid']);
  for (const type of ['spotlight', 'new', 'kinds']) {
    assert.equal(sf.FORMS[type].length, 1, type + ' offers a choice nothing draws');
  }
});

test('`on` defaults to shown, and only an explicit false hides a block', () => {
  assert.equal(sf.normalizeBlock({ type: 'limited' }).on, true);
  assert.equal(sf.normalizeBlock({ type: 'limited', on: false }).on, false);
  assert.equal(sf.normalizeBlock({ type: 'limited', on: 0 }).on, true, 'falsy is not false');
});

test('numeric options are clamped, never trusted', () => {
  assert.equal(sf.normalizeBlock({ type: 'supporters', autoplayOver: -5 }).autoplayOver, 0);
  assert.equal(sf.normalizeBlock({ type: 'supporters', autoplayOver: 9999 }).autoplayOver, 50);
  assert.equal(sf.normalizeBlock({ type: 'supporters', autoplayOver: 'x' }).autoplayOver, 2, 'default');
  assert.equal(sf.normalizeBlock({ type: 'supporters', max: 999 }).max, 60);
  assert.equal(sf.normalizeBlock({ type: 'supporters', max: null }).max, 0, '0 means no cap');
});

test('autoplay is opt-in by size and only for rails', () => {
  const sup = sf.normalizeBlock({ type: 'supporters', autoplayOver: 2 });
  assert.equal(sf.shouldAutoplay(sup, 2), false, 'at the threshold it stays still');
  assert.equal(sf.shouldAutoplay(sup, 3), true, 'above it, it moves');
  // A block whose form is not a scrolling one never animates, whatever the
  // threshold says — 'new', 'kinds' and the Archive are drawn as still sections.
  for (const type of ['new', 'kinds', 'archive']) {
    const still = sf.normalizeBlock({ type, autoplayOver: 2 });
    assert.equal(sf.shouldAutoplay(still, 50), false, type + ' is not a scrolling section');
  }
  const off = sf.normalizeBlock({ type: 'supporters', autoplayOver: 0 });
  assert.equal(sf.shouldAutoplay(off, 999), false, '0 disables it outright');
  assert.equal(sf.shouldAutoplay({ ...sup, on: false }, 99), false, 'a hidden block never animates');
});

test('normalizing is idempotent — a stored layout survives a round trip', () => {
  const once = sf.normalizeLayout({ blocks: [{ type: 'supporters', form: 'carousel', autoplayOver: 6 }] });
  const twice = sf.normalizeLayout({ blocks: once });
  assert.deepEqual(twice, once);
});
