// The home page (docs/index.html), as the site plan lays it out: the hero, the
// screens (and one screen), widgets, games, work tools, Bit, the catalog with the
// Maker, Supporters with prices and names, questions, and Download last. Its
// dictionaries carry the same keys in all 7 site languages, every key the page
// uses, and no key it no longer uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const home = readFileSync(join(root, 'docs', 'index.html'), 'utf8');
const SITE_LANGS = ['en', 'it', 'es', 'fr', 'ja', 'ko', 'zh'];

// The same reading tools/build-i18n.mjs does.
function tables() {
  const out = {};
  const re = /  I18N\.([a-z]{2}) = \{([\s\S]*?)\n  \};/g;
  let m;
  while ((m = re.exec(home))) out[m[1]] = new Function('return {' + m[2] + '\n}')();
  return out;
}
const I18N = tables();
const section = (id) => {
  const at = home.search(new RegExp(`<section class="sec[^"]*" id="${id}"`));
  assert.ok(at >= 0, `no section #${id}`);
  return home.slice(at, home.indexOf('</section>', at));
};

test('the sections come in the order of the plan, Download last', () => {
  const ids = [...home.matchAll(/<section class="sec[^"]*" id="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['screens', 'widgets', 'games', 'work', 'bit', 'catalog', 'support', 'faq', 'install']);
  assert.doesNotMatch(home, /id="controls"|id="price"|id="make"|id="community"/);
});

test('the hero offers the demo beside Download', () => {
  assert.match(home, /<a class="key-alt for-desk" href="\/demo\/"[^>]*data-i18n="hero\.try">Try it in your browser<\/a>/);
});

test('every picture below the hero is a real file with its size, alt text and lazy loading', () => {
  const body = home.slice(home.indexOf('<section class="sec"'), home.indexOf('<footer'));
  const imgs = [...body.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]).filter((t) => !t.includes('data-store-badge') && !/\salt=""/.test(t));
  assert.ok(imgs.length >= 13, `${imgs.length} pictures`);
  for (const tag of imgs) {
    const src = tag.match(/\ssrc="\/([^"]+)"/)[1];
    assert.ok(existsSync(join(root, 'docs', src)), src);
    assert.match(tag, /\swidth="\d+" height="\d+"/, src);
    assert.match(tag, /\sloading="lazy"/, src);
    assert.match(tag, /\salt="[^"]{8,}" data-i18n-alt="[^"]+"/, src);
  }
});

test('the screens are four real devices and a way in for one screen', () => {
  const s = section('screens');
  const figs = [...s.matchAll(/<figure class="(scr-[a-z]+)"><img src="\/images\/home\/([a-z-]+)\.webp"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(figs, [['scr-edge', 'screen-edge'], ['scr-mon', 'screen-monitor'], ['scr-tab', 'screen-tablet'], ['scr-ph', 'screen-phone']]);
  for (const href of ['/xeneon-edge-widgets.html', '/tablet-dashboard.html', '/phone.html', '/single-screen.html']) {
    assert.ok(s.includes(`href="${href}"`), href);
    assert.ok(existsSync(join(root, 'docs', href.slice(1))), href);
  }
  assert.match(readFileSync(join(root, 'server/js/layers-model.js'), 'utf8'), /'alt\+shift\+x'/, 'the menu key the page names');
  for (const lang of SITE_LANGS) assert.match(I18N[lang]['one.p'], /Alt\+(Shift|Maiusc|Mayús|Maj)\+X/, `${lang} one.p`);
});

test('six widget cards, with no count to go stale', () => {
  const s = section('widgets');
  const shots = [...s.matchAll(/<div class="wframe"><img src="\/images\/home\/(w-[a-z]+)\.webp"/g)].map((m) => m[1]);
  assert.deepEqual(shots, ['w-system', 'w-lyrics', 'w-deck', 'w-calendar', 'w-discord', 'w-notes']);
  for (const lang of SITE_LANGS) assert.doesNotMatch(I18N[lang]['widgets.p'], /\d/, `${lang} widgets.p`);
  for (const href of ['/widgets.html', '/claude-code.html', '/codex.html']) assert.ok(s.includes(`href="${href}"`), href);
});

test('games and work list four and six tools, the replay key the app uses', () => {
  assert.equal((section('games').match(/<li><h3 data-i18n="games\.\d\.t">/g) || []).length, 4);
  assert.equal((section('work').match(/<li><h3 data-i18n="work\.\d\.t">/g) || []).length, 6);
  assert.match(readFileSync(join(root, 'server/capture-settings.js'), 'utf8'), /REPLAY_KEY = 'ctrl\+shift\+f10'/);
  for (const lang of SITE_LANGS) assert.match(I18N[lang]['games.1.p'], /^Ctrl\+(Shift|Maiusc|Mayús|Maj)\+F10/, `${lang} games.1.p`);
});

test('Bit is a real photo of its chat with four things to ask', () => {
  const s = section('bit');
  assert.match(s, /<h2 id="h-bit">Bit<\/h2>/);
  assert.match(s, /<img class="bit-im" src="\/images\/home\/bit-chat\.webp"/);
  assert.equal((s.match(/<li data-i18n="bit\.q\d">/g) || []).length, 4);
  assert.doesNotMatch(home, /bit-player\.js|class="bit-card"/);
});

test('the catalog ranks free entries by installs, shows supporter drops apart, and leads to the Maker', () => {
  const s = section('catalog');
  assert.match(s, /<div class="shelf" id="cat"><\/div>/);
  assert.match(s, /<div class="shelf" id="cat-sup"><\/div>/);
  assert.match(s, /<div class="makerbox">[\s\S]*href="\/maker\/"[\s\S]*href="\/submit\/"/);
  assert.match(home, /\/catalog\/installs\?ids=/);
  assert.match(home, /MIN_INSTALLS_SHOWN = 10;/, 'a count shows only from 10 installs');
  assert.match(home, /AbortController/, 'a slow hub falls back to the catalog order');
  for (const lang of SITE_LANGS) assert.match(I18N[lang]['cat.installs'], /\{n\}/, `${lang} cat.installs`);
});

test('supporters see the prices in USD beside the names', () => {
  const s = section('support');
  assert.ok(s.indexOf('id="tiers"') < s.indexOf('id="bill"'), 'offers first, then the names');
  assert.match(s, /class="[^"]*\bsup-cols\b/);
  for (const lang of SITE_LANGS) {
    for (const k of ['tier.1.price', 'tier.2.price', 'tier.month.price', 'tier.3.price']) {
      assert.match(I18N[lang][k], /^\d+ USD <small>/, `${lang} ${k}`);
    }
  }
  assert.doesNotMatch(home, /--blue|#008DFF;\s*margin/);
});

test('the questions are five, each with its answer in every language', () => {
  const s = section('faq');
  const qs = [...s.matchAll(/<summary data-i18n="faq\.(\d)\.q">/g)].map((m) => m[1]);
  assert.deepEqual(qs, ['1', '2', '3', '4', '5']);
  for (const lang of SITE_LANGS) for (const n of qs) assert.ok(I18N[lang][`faq.${n}.a`], `${lang} faq.${n}.a`);
});

test('the page ends on Download, the key following the visitor\'s system', () => {
  const s = section('install');
  assert.match(s, /<h2 id="h-inst" data-i18n="inst\.h2">Download Xenon<\/h2>/);
  assert.match(s, /<a class="key" href="https:\/\/github\.com\/marcimastro98\/Xenon\/releases\/latest\/download\/Xenon-Setup-x64\.exe" data-track="download_click" data-track-location="final">/);
  for (const href of ['/mac.html', '/linux.html', '/download.html', '/privacy.html']) assert.ok(s.includes(`href="${href}"`), href);
  assert.match(home, /document\.querySelectorAll\('\[data-os-icon\] use'\)/, 'both keys take the system\'s mark');
  assert.doesNotMatch(home, /data-os-card/);
});

test('no copy has an em-dash or a bare dollar amount', () => {
  for (const lang of SITE_LANGS) {
    for (const [k, v] of Object.entries(I18N[lang])) {
      assert.doesNotMatch(v, /—/, `${lang} ${k}`);
      assert.doesNotMatch(v, /\$\s?\d/, `${lang} ${k}`);
    }
  }
});

test('every language has the same keys, all used by the page', () => {
  const en = Object.keys(I18N.en).sort();
  for (const lang of SITE_LANGS) assert.deepEqual(Object.keys(I18N[lang]).sort(), en, `${lang} keys`);
  const body = home.replace(/  I18N\.[a-z]{2} = \{[\s\S]*?\n  \};/g, '');
  // Read by the build (meta.*) or built from a system name ('fact.' + os).
  const indirect = new Set(['meta.title', 'meta.desc', 'fact.windows', 'fact.macos', 'fact.linux']);
  const unused = en.filter((k) => !indirect.has(k) && !body.includes(`"${k}"`) && !body.includes(`'${k}'`));
  assert.deepEqual(unused, []);
  const used = [...body.matchAll(/data-i18n(?:-html|-alt|-aria)?="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].filter((k) => !(k in I18N.en)), []);
});

// Every plan brings 300 Scintille a month (hub AI_INCLUDED_CREDITS): each tier
// says so, with the app's own spark, as Xenon's credits rather than Bit's.
test('each support tier names its 300 Sparks a month, with the spark, in every language', () => {
  const tiers = home.slice(home.indexOf('<div class="tiers" id="tiers">'), home.indexOf('</div>', home.indexOf('<div class="tiers" id="tiers">')));
  const lines = [...tiers.matchAll(/<span class="tier-sparks"><img src="images\/brand\/spark\.svg" width="16" height="16" alt=""><span data-i18n="tier\.sparks">/g)];
  assert.equal(lines.length, 4, 'one line on each of the four tiers');
  assert.ok(existsSync(join(root, 'docs', 'images', 'brand', 'spark.svg')), 'the spark file is there');
  const UNIT = { en: 'Sparks', it: 'Scintille', es: 'Chispas', fr: 'Étincelles', ja: 'スパーク', ko: '스파크', zh: '火花' };
  for (const l of SITE_LANGS) {
    const v = I18N[l]['tier.sparks'];
    assert.ok(v && v.includes('300') && v.includes(UNIT[l]) && v.includes('Xenon'), `${l}: ${v}`);
    assert.doesNotMatch(v, /\bBit\b|—/, `${l} ties them to Bit or uses a dash`);
  }
  for (const l of SITE_LANGS.filter((x) => x !== 'en')) {
    const copy = readFileSync(join(root, 'docs', l, 'index.html'), 'utf8');
    assert.ok(copy.includes(`<span data-i18n="tier.sparks">${I18N[l]['tier.sparks']}</span>`), `${l} copy is baked`);
  }
});

// The packs the hub books (ai-credits.js TOPUP_PACKS) and the app sells
// (xenon-credits.js PACKS), after the tiers so the plans stay the choice.
test('the supporter section names the Sparks packs with their price, after the tiers, in every language', () => {
  const tiersEnd = home.indexOf('</div>', home.indexOf('<div class="tiers" id="tiers">'));
  const at = home.indexOf('<p class="sup-note sup-sparks">');
  assert.ok(at > tiersEnd, 'below the four tiers');
  const line = home.slice(at, home.indexOf('</p>', at));
  assert.match(line, /<img src="images\/brand\/spark\.svg" width="16" height="16" alt="">/);
  assert.match(line, /href="https:\/\/www\.buymeacoffee\.com\/marcimastro98\/extras" target="_blank" rel="noopener" data-track="coffee_click" data-track-location="sparks_packs"/);
  const UNIT = { en: 'Sparks', it: 'Scintille', es: 'Chispas', fr: 'Étincelles', ja: 'スパーク', ko: '스파크', zh: '火花' };
  for (const l of SITE_LANGS) {
    const v = I18N[l]['sup.sparks'];
    for (const bit of ['500', '1050', '2200', '5', '10', '20 USD', UNIT[l]]) assert.ok(v && v.includes(bit), `${l} lacks ${bit}: ${v}`);
    assert.ok(I18N[l]['sup.sparks.go'], `${l} has the link text`);
    assert.doesNotMatch(v, /\bBit\b|—/, `${l} ties them to Bit or uses a dash`);
  }
  for (const l of SITE_LANGS.filter((x) => x !== 'en')) {
    const copy = readFileSync(join(root, 'docs', l, 'index.html'), 'utf8');
    assert.ok(copy.includes(`<span data-i18n="sup.sparks">${I18N[l]['sup.sparks']}</span>`), `${l} copy is baked`);
    // A copy lives in /<lang>/: a relative spark would look for /<lang>/images and show nothing.
    assert.equal((copy.match(/<img src="\/images\/brand\/spark\.svg"/g) || []).length, 5, `${l}: four tiers + the packs line, root-relative`);
    assert.doesNotMatch(copy, /<img src="images\/brand\/spark\.svg"/, `${l} has a relative spark`);
  }
});

test('the assistant paragraph calls Sparks Xenon\'s credits, never Bit\'s, in every language', () => {
  const BITS = /Bit's credits|crédits de Bit|crediti di Bit|créditos de Bit|Bit のクレジット|Bit의 크레딧|Bit 的点数/;
  for (const l of SITE_LANGS) {
    const v = I18N[l]['ctl.ai.p'];
    assert.doesNotMatch(v, BITS, `${l}: ${v}`);
    assert.match(v, /Xenon/, `${l} names Xenon's credits`);
  }
});

test('the usage counter watches exactly the home sections', () => {
  const src = readFileSync(join(root, 'docs/analytics.js'), 'utf8');
  const watched = /const HOME_SECTIONS = \[([^\]]+)\]/.exec(src)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  const ids = [...home.matchAll(/<section class="sec[^"]*" id="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...watched].sort(), [...ids].sort());
});
