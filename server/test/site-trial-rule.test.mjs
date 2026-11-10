// Three copies of "may the trial open this entry?" live outside the hub: the app's
// Store button, the catalog page (one self-contained file) and the item pages built
// at deploy. A link offered on an entry the hub refuses is a promise broken at the
// last step, so all three run on one table and fail on any disagreement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { trialCovers as forItemPages } from '../../tools/trial-covers.mjs';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { covers: forApp } = require('../js/trial-pass-ui.js');
const page = readFileSync(join(root, 'docs', 'catalog', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const seo = readFileSync(join(root, 'tools', 'build-seo.mjs'), 'utf8').replace(/\r\n/g, '\n');

function catalogCopy() {
  const start = page.indexOf('const TRIAL_FRESH_MS');
  const end = page.indexOf('// A line with one link in it.');
  assert.ok(start > 0 && end > start, 'the catalog page no longer carries its copy of the rule');
  const sandbox = { globalThis: {} };
  vm.createContext(sandbox);
  vm.runInContext(`${page.slice(start, end)}\n;globalThis.covers = trialCovers;`, sandbox);
  return sandbox.globalThis.covers;
}

const NOW = Date.parse('2026-11-06T12:00:00Z');
const CASES = [
  [null, false],
  [{ id: 'free-theme', addedAt: '2026-01-01' }, false],
  [{ id: 'old', locked: true, addedAt: '2026-09-01' }, true],
  [{ id: 'old', supportersOnly: true, addedAt: '2026-09-01' }, true],
  [{ id: 'fresh', locked: true, addedAt: '2026-10-20' }, false],
  [{ id: 'day-30', locked: true, addedAt: '2026-10-07T12:00:00Z' }, true],
  [{ id: 'day-29', locked: true, addedAt: '2026-10-08T12:00:00Z' }, false],
  [{ id: 'no-date', locked: true }, false],
  [{ id: 'bad-date', locked: true, addedAt: 'soon' }, false],
  [{ id: 'fresh-now', locked: true, addedAt: '2026-11-05', trial: 'now' }, true],
  [{ id: 'old-never', locked: true, addedAt: '2026-01-01', trial: 'never' }, false],
  [{ id: 'limited', locked: true, addedAt: '2026-01-01', limited: { total: 50 } }, false],
  [{ id: 'sparks-only', locked: true, addedAt: '2026-01-01', sparks: 300 }, false],
  [{ id: 'sparks-and-supporters', supportersOnly: true, addedAt: '2026-01-01', sparks: 300 }, true],
  [{ id: 'feature-lyrics', locked: true }, true],
  [{ id: 'feature-devclean', locked: true }, false],
];

test('the app, the catalog and the item pages give the same answer', () => {
  const forCatalog = catalogCopy();
  for (const [entry, want] of CASES) {
    const name = JSON.stringify(entry);
    assert.equal(forApp(entry, NOW), want, `app ${name}`);
    assert.equal(forCatalog(entry, NOW), want, `catalog ${name}`);
    assert.equal(forItemPages(entry, NOW), want, `item page ${name}`);
  }
});

test('the catalog keeps what the rule and the Newest sort read', () => {
  assert.match(page, /out\.addedAt = added/);
  assert.match(page, /supportersOnly: entry\.supportersOnly === true/);
  assert.match(page, /out\.sparks = entry\.sparks/);
  assert.match(page, /entry\.trial === 'now' \|\| entry\.trial === 'never'/);
  // Dates are text: a subtraction gives NaN and leaves the list in file order.
  assert.doesNotMatch(page, /\(y\.addedAt \|\| 0\) - \(x\.addedAt \|\| 0\)/);
});

test('every language offers the trial with one link, and the link keeps the language', () => {
  for (const key of ['dt.trial', 'plan.trial']) {
    const lines = [...page.matchAll(new RegExp(`'${key.replace('.', '\\.')}': '([^\\n]*?)'[,\\n]`, 'g'))].map((m) => m[1]);
    assert.equal(lines.length, 7, `${key} in all 7 tables`);
    for (const line of lines) {
      assert.equal(line.split('{a}').length, 2, line);
      assert.equal(line.split('{/a}').length, 2, line);
      assert.match(line, /7/, line);
    }
  }
  assert.match(page, /cur === 'en' \? TRIAL_URL : TRIAL_URL \+ '\?lang=' \+ cur/);
  assert.match(page, /data-track', 'trial_click'/);
});

test('an item page offers the trial only where the rule says so', () => {
  assert.match(seo, /import \{ trialCovers \} from '\.\/trial-covers\.mjs'/);
  assert.match(seo, /if \(trialCovers\(e, Date\.now\(\)\)\) \{\n\s+note \+=/);
  assert.match(seo, /data-track="trial_click" data-track-location="catalog_item"/);
});

test('"5 USD a month" leads to the membership page, not to the coffee page', () => {
  assert.match(page, /const MEMBERSHIP = COFFEE \+ '\/membership'/);
  assert.doesNotMatch(page, /join\.href = COFFEE/);
  assert.match(seo, /const SUPPORT = 'https:\/\/www\.buymeacoffee\.com\/marcimastro98\/membership'/);
});
