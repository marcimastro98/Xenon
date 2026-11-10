// A drop sold only for Sparks (Culprit: the hub's "item" access) on the website.
// No supporter pass opens it, so the site must never call it a supporter drop:
// the catalog cards, the detail panel, the home shelf and the static entry pages
// show its price and send people to Xenon's Store, never "Become a supporter" or
// "Unlock with a code". The rule is the app's own sparksOnly().
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const site = read('../../docs/catalog/index.html');
const home = read('../../docs/index.html');
const seo = read('../../tools/build-seo.mjs');
const app = read('../js/community-gallery.js');
const SITE_LANGS = ['en', 'it', 'es', 'fr', 'ja', 'ko', 'zh'];

const fnFrom = (src, re) => {
  const m = re.exec(src);
  assert.ok(m, `not found: ${re}`);
  return vm.runInNewContext(`(${m[1]})`);
};
const siteRule = fnFrom(site, /(function sparksOnly\(entry\) \{[^\n]*\})/);
const appRule = fnFrom(app, /const sparksOnly = (\(entry\) => [^;]*);/);
const ENTRIES = [
  { locked: true, sparks: 300 },
  { locked: true, sparks: 300, supportersOnly: true },
  { locked: true, sparks: 300, limited: { total: 10 } },
  { locked: true },
  { locked: true, sparks: 0 },
  {},
  null,
];

test('the site and the app agree on which drops are Sparks-only', () => {
  for (const e of ENTRIES) assert.equal(!!siteRule(e), !!appRule(e), JSON.stringify(e));
  assert.equal(siteRule(ENTRIES[0]), true);
  assert.equal(siteRule(ENTRIES[1]), false, 'supporters or Sparks stays a supporter drop');
});

test('a Sparks drop shows its price, never the supporter mark', () => {
  assert.match(site, /else if \(sparksOnly\(entry\)\) media\.appendChild\(sparksPill\('cat-badge locked', entry\)\);\n\s*else if \(entry\.locked\)/);
  assert.match(site, /else if \(sparksOnly\(entry\)\) meta\.appendChild\(sparksPill\('dt-tier', entry\)\);\n\s*else if \(entry\.locked\)/);
  assert.equal((site.match(/sparksPill\('drop-badge sparks', entry\)/g) || []).length, 2, 'featured and spotlight cards');
  // The supporters strip hides its gold badge (the heading says it); the price stays.
  assert.match(site, /\.sup-strip \.drop-badge\.gold, \.lim-strip \.drop-badge\.lim \{ display: none; \}/);
  assert.ok(!/\.drop-badge\.sparks \{[^}]*display: none/.test(site));
});

test('no join key and no code key on a Sparks drop: its key opens the card', () => {
  assert.equal((site.match(/if \(entry\.locked && !sparksOnly\(entry\)\) foot\.appendChild\(joinKey\(\)\);/g) || []).length, 2);
  assert.ok(!/if \(entry\.locked\) foot\.appendChild\(joinKey\(\)\);/.test(site));
  assert.match(site, /function codeButton\(entry\) \{\n\s*if \(sparksOnly\(entry\)\) \{\n\s*const key = el\('button', 'cat-unlock', T\('card\.inxenon'\)\);[^\n]*\n\s*key\.addEventListener\('click', \(\) => openDetail\(entry\)\);/);
  assert.match(site, /const gold = !entry\.limited && entry\.locked && !sparksOnly\(entry\);/);
  assert.match(site, /entry\.locked && !sparksOnly\(entry\) \? ' gold' : ''/);
});

test('the detail says where it is bought and leads to Xenon', () => {
  assert.match(site, /say\.append\(sparksDrop \? sparksNote\(\) : entry\.locked \? planNote\(\) : freeNote\(\)\);/);
  assert.match(site, /if \(sparksDrop\) \{\n\s*const get = el\('a', 'dt-support', T\('dt\.get'\)\); get\.href = '\/download\.html';/);
  assert.match(site, /if \(!sparksDrop\) keys\.appendChild\(btn\);/);
});

test('the new lines exist in the 7 site languages, placeholders kept, no dash', () => {
  for (const key of ['card.sparks', 'card.inxenon', 'dt.sparks', 'dt.sparks.pass']) {
    const re = new RegExp(`'${key.replace(/\./g, '\\.')}': '((?:[^'\\\\]|\\\\.)*)'`, 'g');
    const found = [...site.matchAll(re)].map((m) => m[1]);
    assert.equal(found.length, SITE_LANGS.length, key);
    for (const s of found) {
      assert.ok(!/[—–]/.test(s), `${key}: no dash in ${s}`);
      if (key === 'card.sparks') assert.match(s, /\{n\}/);
      if (key === 'dt.sparks.pass') { assert.match(s, /\{spark\}/); assert.match(s, /\{n\}/); }
    }
  }
});

test('the home shelf names the price of a Sparks drop', () => {
  assert.match(home, /if \(!e\.limited && e\.supportersOnly !== true && Number\.isInteger\(e\.sparks\) && e\.sparks > 0\) meta \+= ', ' \+ window\.XT\('cat\.sparks'\)/);
  assert.equal((home.match(/"cat\.sparks": "[^"]*\{n\}[^"]*"/g) || []).length, SITE_LANGS.length);
  for (const lang of SITE_LANGS.filter((l) => l !== 'en')) {
    assert.match(read(`../../docs/${lang}/index.html`), /"cat\.sparks":/, `${lang} copy rebuilt`);
  }
});

test('the static entry page sells it in Xenon, not as a supporter pack', () => {
  const rule = fnFrom(seo, /(function sparksPrice\(e\) \{\n[^\n]*\n\})/);
  for (const e of ENTRIES.filter(Boolean)) assert.equal(rule(e) > 0, !!appRule(e), JSON.stringify(e));
  assert.match(seo, /\} else if \(price\) \{\n\s*buttons =\n\s*`<a class="pg-key" href="\/download\.html">Get Xenon<\/a>`/);
  // The price branch comes before the supporter one, which would say "Become a supporter".
  assert.ok(seo.indexOf('} else if (price) {') < seo.indexOf('} else if (locked) {\n    buttons'));
  const monthly = /const MONTHLY = (\d+);/.exec(read('../js/sparks-store.js'))[1];
  assert.equal(/const SPARKS_MONTHLY = (\d+);/.exec(seo)[1], monthly);
});
