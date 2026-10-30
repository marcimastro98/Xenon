// The Sparks block on the site catalog (docs/catalog/index.html).
//
// The rules these tests hold:
//  - the packs, the widget costs and the shop link are the app's own
//    (js/xenon-credits.js), so the site never sells at another price;
//  - the monthly Sparks and the membership price are the numbers the app's
//    Store says, on one plan card the page shows once;
//  - no strip repeats what the spotlight shows (the app's Store does the same);
//  - every string exists in the site's 7 languages, placeholders kept, no dash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const site = read('../../docs/catalog/index.html');
const credits = read('../js/xenon-credits.js');
const SITE_LANGS = ['en', 'it', 'es', 'fr', 'ja', 'ko', 'zh'];

const literal = (src, re) => {
  const m = re.exec(src);
  assert.ok(m, `not found: ${re}`);
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${m[1]})`, { Object })));
};

test('the site sells the packs at the app prices, at the app shop link', () => {
  const appPacks = literal(credits, /const PACKS = Object\.freeze\((\[[\s\S]*?\])\);/);
  const sitePacks = literal(site, /const SPARK_PACKS = (\[[^\]]*\]);/);
  assert.deepEqual(sitePacks.map((p) => [p.credits, p.usd]), appPacks.map((p) => [p.credits, p.usd]));
  assert.deepEqual(literal(site, /const SPARK_COST = (\{[^}]*\});/), literal(credits, /const WIDGET_COST = (\{[^}]*\});/));
  const topup = /const TOPUP_URL = '([^']+)';/.exec(credits)[1];
  const coffee = /const COFFEE = '([^']+)';/.exec(site)[1];
  assert.match(site, /const SPARKS_URL = COFFEE \+ '\/extras';/);
  assert.equal(coffee + '/extras', topup);
});

test('the monthly Sparks and the membership price match the app Store', () => {
  const store = read('../js/sparks-store.js');
  assert.equal(/const SPARKS_MONTHLY = (\d+);/.exec(site)[1], /const MONTHLY = (\d+);/.exec(store)[1]);
  assert.equal(/const MEMBER_USD = (\d+);/.exec(site)[1], /const MEMBER_USD = (\d+);/.exec(store)[1]);
  assert.match(site, /T\('plan\.sparks'\)\.replace\('\{n\}', SPARKS_MONTHLY\)\]/, 'no price on Sparks that are not sold apart, as in the app');
});

test('the plan card shows once: in the Supporters strip, else in the Sparks block', () => {
  assert.match(site, /let planShown = false;/);
  assert.match(site, /sparksBlock\(sellsForSparks, !planShown\)\); sparksShown = true; planShown = true;/);
  assert.match(site, /const withPlan = !planShown;\n\s*planShown = true;/);
  assert.match(site, /if \(withPlan\) s\.appendChild\(planCard\('catalog_supporters'\)\);/);
  assert.match(site, /if \(withPlan\) s\.appendChild\(planCard\('catalog_sparks_join'\)\);/);
  const block = /function supportersBlock\([\s\S]*?\n  \}\n/.exec(site)[0];
  assert.ok(!/sec\.supporters_join/.test(block), 'one join button, on the plan');
});

test('the strips skip what the spotlight shows', () => {
  assert.match(site, /const limited = limitedAll\.filter\(\(e\) => !spotIds\.has\(e\.id\)\);/);
  assert.match(site, /const sup = supTier\.filter\(\(e\) => !spotIds\.has\(e\.id\)\);/);
  assert.match(site, /const free = pool\.filter\(\(e\) => !spotIds\.has\(e\.id\)\);/);
});

test('the block sits after the supporters one, once, and links out safely', () => {
  assert.equal((site.match(/addSparks\(\);/g) || []).length, 3, 'after supporters, before the free sections, or at the end');
  assert.match(site, /let sparksShown = false;/);
  assert.match(site, /a\.href = SPARKS_URL; a\.target = '_blank'; a\.rel = 'noopener';/);
  assert.match(site, /join\.href = COFFEE; join\.target = '_blank'; join\.rel = 'noopener';/);
  const block = /function sparksBlock\([\s\S]*?\n  \}\n/.exec(site)[0];
  assert.ok(!/innerHTML/.test(block), 'text only');
});

test('the Sparks strings are in all 7 site languages, placeholders kept, no dash', () => {
  const start = site.indexOf('const I18N = {');
  const end = site.indexOf('\n};', start);
  const I18N = vm.runInNewContext(`(${site.slice(start + 'const I18N = '.length, end + 2)})`);
  const PH = { 'sp.cost': ['{haiku}', '{sonnet}', '{opus}'], 'sp.bonus': ['{n}'], 'sp.widgets': ['{n}'], 'plan.price': ['{usd}'], 'plan.sparks': ['{n}'] };
  const keys = Object.keys(I18N.en).filter((k) => k.startsWith('sp.') || k.startsWith('plan.'));
  assert.equal(keys.length, 14);
  for (const gone of ['sp.sub_t', 'sp.sub_d', 'sec.supporters_sub']) assert.equal(I18N.en[gone], undefined, gone + ' is unused');
  for (const l of SITE_LANGS) {
    for (const k of keys) {
      const v = I18N[l][k];
      assert.equal(typeof v, 'string', `${l}.${k} is missing`);
      assert.doesNotMatch(v, /—|·/, `${l}.${k}: ${v}`);
      for (const p of PH[k] || []) assert.ok(v.includes(p), `${l}.${k} lost ${p}`);
    }
    if (l !== 'en') assert.notEqual(I18N[l]['sp.sub'], I18N.en['sp.sub'], `${l} is translated`);
  }
});
