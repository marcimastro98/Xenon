// The catalog page (docs/catalog/index.html) on the home's system: tags are
// small outline tags, not buttons; one filled action per card; pictures keep
// their own shape instead of sitting in a letterboxed box; no glass effects
// over the pictures; filters tall enough for a finger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const page = readFileSync(join(root, 'docs', 'catalog', 'index.html'), 'utf8');
const css = page.slice(page.indexOf('<style>'), page.indexOf('</style>'));
const rules = (selector) => {
  const out = [];
  const re = new RegExp('(?:^|[\\n}])\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
  let m;
  while ((m = re.exec(css))) out.push(m[1]);
  assert.ok(out.length, `no rule ${selector}`);
  return out.join(';');
};

test('a tag is a small outline tag, never a tinted button', () => {
  for (const sel of ['.drop-badge', '.dt-tier']) {
    const r = rules(sel);
    assert.match(r, /padding: 2px 6px/, sel);
    assert.doesNotMatch(r, /background: color-mix/, sel);
  }
  for (const sel of ['.drop-badge.lim', '.drop-badge.gold', '.drop-badge.sold']) {
    assert.doesNotMatch(rules(sel), /background/, sel);
  }
  assert.doesNotMatch(rules('.sup-head .kcnt'), /border/);
});

test('unlock is an outline: the supporter button is the card\'s one fill', () => {
  const r = rules('.cat-unlock');
  assert.match(r, /background: transparent/);
  assert.doesNotMatch(r, /color-mix\(in srgb, var\(--gold\)/);
  assert.match(rules('.sup-strip .drop-foot .sjoin'), /background: transparent/);
});

test('a featured picture keeps its own shape', () => {
  assert.match(rules('.drop-media .cat-shots'), /position: static; height: auto; aspect-ratio: var\(--shot-ratio, 16 \/ 9\)/);
  assert.match(page, /strip\.style\.setProperty\('--shot-ratio', String\(img\.naturalWidth \/ img\.naturalHeight\)\)/);
  assert.doesNotMatch(css, /\.drops\.cat-rail \.drop-media \{ min-height: 200px/);
});

test('no glass over the pictures', () => {
  for (const sel of ['.cat-kind', '.cat-badge', '.cat-dots', '.cat-new', '.rail-arw']) {
    assert.doesNotMatch(rules(sel), /backdrop-filter|box-shadow: 0 8px/, sel);
  }
});

test('an entry page\'s facts are small outline tags, not buttons', () => {
  for (const src of [readFileSync(join(root, 'tools', 'build-seo.mjs'), 'utf8'), readFileSync(join(root, 'docs', 'catalog', 'nitrato', 'index.html'), 'utf8')]) {
    const chip = src.match(/\.chip\{([^}]*)\}/)[1];
    assert.match(chip, /border:1px solid var\(--rule-2\);border-radius:4px;padding:2px 6px/);
    assert.doesNotMatch(chip, /background/);
  }
});

test('filters and the link button are big enough to tap', () => {
  assert.match(rules('.seg button'), /min-height: 38px/);
  assert.match(css, /@media \(max-width: 700px\) \{[^@]*\.seg button \{ min-height: 44px; \}/);
  assert.match(rules('.cat-link'), /width: 42px; height: 42px/);
});
