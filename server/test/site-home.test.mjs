// The home page (docs/index.html), as the brand plan lays it out: the hero,
// the screens on one desk line, Bit, four widget cards, three catalog
// entries, Xenon Maker, Supporters with prices and names, and Download last.
// Its dictionaries carry the same keys in all 7 site languages, every key the
// page uses, and no key it no longer uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const home = readFileSync(join(root, 'docs', 'index.html'), 'utf8');
const { LINES, MOMENTS } = createRequire(import.meta.url)('../../packages/core/src/bit-phrases.js');
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
  const at = home.indexOf(`<section class="sec" id="${id}"`);
  assert.ok(at >= 0, `no section #${id}`);
  return home.slice(at, home.indexOf('</section>', at));
};

test('the sections come in the order of the plan, Download last', () => {
  const ids = [...home.matchAll(/<section class="sec[^"]*" id="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['screens', 'bit', 'widgets', 'community', 'make', 'support', 'install']);
  assert.doesNotMatch(home, /id="controls"|id="price"/);
});

test('the hero offers the demo beside Download', () => {
  assert.match(home, /<a class="key-alt for-desk" href="\/demo\/"[^>]*data-i18n="hero\.try">Try it in your browser<\/a>/);
});

// Physical sizes (inches): 27-inch 16:9 monitor 23.5 x 13.2, the 14.5-inch
// 32:9 Edge 13.96 x 3.93 lying and 3.93 x 13.96 standing, an 11-inch tablet
// 9.0 wide, a 6.1-inch phone 2.6 wide.
test('every screen sits in its device frame on one desk line, the upright Edge among them', () => {
  const s = section('screens');
  const units = [...s.matchAll(/<figure class="unit (u-[a-z]+)">/g)].map((m) => m[1]);
  assert.deepEqual(units, ['u-mon', 'u-edge', 'u-vert', 'u-tab', 'u-ph']);
  assert.equal((s.match(/<div class="dv">/g) || []).length, 5, 'one frame per screen');
  assert.match(s, /<figure class="unit u-vert">[\s\S]*?edge-vertical\.webp/);
  assert.match(s, /<div class="stand"><\/div><div class="foot-base"><\/div>/, 'the monitor stands on its foot');
  assert.doesNotMatch(home, /<figure class="vert">/, 'no second, separate upright Edge');
  const css = home.match(/\n\.lineup \{[^}]*\}/)[0];
  const cols = css.match(/grid-template-columns: ([^;]+);/)[1].split(/\s+(?![^(]*\))/);
  const cq = (v) => Number(v.replace('cqw', ''));
  const k = cq(cols[0]) / 23.5;
  assert.ok(Math.abs(cq(cols[1]) / k - 13.96) < 0.2, 'the Edge to the monitor\'s scale');
  assert.ok(Math.abs(cq(cols[3]) / k - 9.0) < 0.2, 'the tablet to the monitor\'s scale');
  const vert = home.match(/\n\.u-vert \.dv-stack \{ width: ([\d.]+)cqw;/);
  assert.ok(vert && Math.abs(Number(vert[1]) / k - 3.93) < 0.15, 'the upright Edge to the monitor\'s scale');
});

// The card, its moment in bit-phrases.js, the line it quotes.
const BIT = [['done', 'done', 1], ['hot', 'hotPc', 1], ['err', 'error', 0], ['night', 'night', 0]];

test('Bit says on the page the very lines it says in the app, in every language', () => {
  const s = section('bit');
  assert.match(s, /<h2 id="h-bit">Bit<\/h2>/);
  for (const [k, moment, i] of BIT) {
    const card = s.match(new RegExp(`<li class="bit-card"><div class="bit-stage" data-clip="([a-z]+)"></div><b data-i18n="bit\\.${k}\\.t">[^<]+</b><q data-i18n="bit\\.${k}\\.q">([^<]+)</q></li>`));
    assert.ok(card, `card ${k}`);
    assert.ok(MOMENTS[moment].clips.includes(card[1]), `${k} plays a clip of ${moment}`);
    for (const lang of SITE_LANGS) {
      assert.equal(I18N[lang][`bit.${k}.q`], LINES[lang][moment][i], `${lang} bit.${k}.q`);
    }
    assert.equal(card[2], LINES.en[moment][i]);
  }
  for (const f of ['bit-clips.js', 'bit.js', 'bit-player.js']) {
    assert.match(home, new RegExp(`<script src="/demo/shared/src/${f.replace('.', '\\.')}" defer></script>`));
    assert.equal(readFileSync(join(root, 'docs/demo/shared/src', f), 'utf8'), readFileSync(join(root, 'packages/core/src', f), 'utf8'), `${f} is the app's own`);
  }
});

test('widgets and keys are four cards, with no count to go stale', () => {
  const s = section('widgets');
  const shots = [...s.matchAll(/<article class="feat"><img src="\/images\/home\/(crop-[a-z]+)\.webp"/g)].map((m) => m[1]);
  assert.deepEqual(shots, ['crop-system', 'crop-media', 'crop-calendar', 'crop-deck']);
  for (const lang of SITE_LANGS) assert.doesNotMatch(I18N[lang]['widgets.p'], /\d{2}/, `${lang} widgets.p`);
  for (const href of ['/widgets.html', '/claude-code.html', '/codex.html', '/create/#widgets']) assert.ok(s.includes(`href="${href}"`), href);
});

test('the catalog shelf shows three entries', () => {
  assert.match(home, /pick\.length < 3/);
  assert.match(home, /pick\.slice\(0, 3\)/);
});

test('Xenon Maker has its own section, Beta, with a picture of it', () => {
  const s = section('make');
  assert.match(s, /<h2 id="h-make"><span data-i18n="make\.h2">Xenon Maker<\/span><span class="beta" data-i18n="beta">Beta<\/span><\/h2>/);
  assert.match(s, /<a class="key-alt" href="\/maker\/" data-i18n="make\.open">/);
  assert.match(s, /src="\/images\/home\/maker\.webp"/);
  assert.ok(existsSync(join(root, 'docs/images/home/maker.webp')));
});

test('supporters see the prices in USD beside the names', () => {
  const s = section('support');
  assert.ok(s.indexOf('id="tiers"') < s.indexOf('id="bill"'), 'offers first, then the names');
  assert.match(s, /<div class="sup-cols">/);
  for (const lang of SITE_LANGS) {
    for (const k of ['tier.1.price', 'tier.2.price', 'tier.month.price', 'tier.3.price']) {
      assert.match(I18N[lang][k], /^\d+ USD <small>/, `${lang} ${k}`);
    }
  }
  assert.doesNotMatch(home, /--blue|#008DFF;\s*margin/);
});

test('the page ends on Download, the key following the visitor\'s system', () => {
  const s = section('install');
  assert.match(s, /<h2 id="h-inst" data-i18n="inst\.h2">Download Xenon<\/h2>/);
  assert.match(s, /<a class="key" href="https:\/\/github\.com\/marcimastro98\/Xenon\/releases\/latest\/download\/Xenon-Setup-x64\.exe" data-track="download_click" data-track-location="final">/);
  for (const href of ['/mac.html', '/linux.html', '/download.html', '/privacy.html']) assert.ok(s.includes(`href="${href}"`), href);
  assert.match(home, /document\.querySelectorAll\('\[data-os-icon\] use'\)/, 'both keys take the system\'s mark');
  assert.doesNotMatch(home, /data-os-card/);
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
