// The home page (docs/index.html), as the site plan lays it out: the hero, the
// widgets people ask for, the screens (and one screen), games, Bit, the catalog
// with the Maker, Supporters with prices and names, questions, and Download last.
// Its dictionaries carry the same keys in all 7 site languages, every key the page
// uses, and no key it no longer uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const home = readFileSync(join(root, 'docs', 'index.html'), 'utf8');
const homeScripts = ['home-widgets.js', 'home-game.js'].map((f) => readFileSync(join(root, 'docs', f), 'utf8')).join('\n');
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
// Every section but the hero has an id; each wears its own sheet as its class.
const sectionIds = () => [...home.matchAll(/<section class="(?!hero)[^"]*" id="([a-z-]+)"/g)].map((m) => m[1]);
const section = (id) => {
  const at = home.search(new RegExp(`<section class="[^"]*" id="${id}"`));
  assert.ok(at >= 0, `no section #${id}`);
  return home.slice(at, home.indexOf('</section>', at));
};

test('the sections come in the order of the plan, Download last', () => {
  assert.deepEqual(sectionIds(), ['widgets', 'screens', 'games', 'bit', 'catalog', 'support', 'faq', 'install']);
  assert.doesNotMatch(home, /id="controls"|id="price"|id="make"|id="community"/);
});

test('the hero offers the demo beside Download', () => {
  assert.match(home, /<a class="key-alt for-desk" href="\/demo\/"[^>]*data-i18n="hero\.try">Try it in your browser<\/a>/);
});

test('every picture below the hero is a real file with its size, alt text and lazy loading', () => {
  const body = home.slice(home.indexOf('id="widgets"'), home.indexOf('<footer'));
  const imgs = [...body.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]).filter((t) => !t.includes('data-store-badge') && !/\salt=""/.test(t));
  assert.ok(imgs.length >= 8, `${imgs.length} pictures`);
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

test('the widgets section walks fifteen things people ask for, each with its own picture', () => {
  const s = section('widgets');
  const words = [...s.matchAll(/<button class="word"[^>]*>/g)].map((m) => m[0]);
  assert.equal(words.length, 15);
  for (const tag of words) {
    const id = tag.match(/data-w="([a-z]+)"/)[1];
    assert.ok(existsSync(join(root, 'docs', 'images', 'home', `w-${id}.webp`)), id);
    assert.match(tag, /data-c="#[0-9A-Fa-f]{6}" data-k="#[0-9A-Fa-f]{6}"/, id);
    const fact = tag.match(/data-fact="([a-z.]+)"/)[1];
    for (const lang of SITE_LANGS) assert.ok(I18N[lang][fact], `${lang} ${fact}`);
  }
  assert.equal(words.filter((t) => /aria-pressed="true"/.test(t)).length, 1, 'one word open at the start');
  assert.ok(s.includes('href="/widgets.html"'));
  assert.match(s, /<input id="ask-in" type="search"/);
  assert.match(s, /<button class="pz" id="fw-pause"/, 'the walk can be paused (WCAG 2.2.2)');
});

test('a word that is not built in says where it lives', () => {
  const steam = section('widgets').match(/<button class="word"[^>]*data-w="steam"[^>]*>/)[0];
  assert.match(steam, /data-have="have\.catalog"/);
  const id = steam.match(/data-href="\/catalog\/#([a-z0-9-]+)"/)[1];
  const { entries } = JSON.parse(readFileSync(join(root, 'docs', 'community', 'catalog.json'), 'utf8'));
  const entry = entries.find((e) => e.id === id);
  assert.ok(entry && entry.active !== false, id);
});

test('games list four things under the real overlay, the replay key the app uses', () => {
  const s = section('games');
  assert.equal((s.match(/<li><h3 data-i18n="games\.\d\.t">/g) || []).length, 4);
  assert.match(s, /<canvas id="game"/);
  assert.match(s, /<button class="pz on-pic" id="game-pause"/);
  assert.match(s, /src="\/images\/home\/overlay-hud\.webp"/);
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
  assert.match(s, /<article class="maker">[\s\S]*href="\/maker\/"[\s\S]*href="\/submit\/"/);
  assert.match(s, /<button class="pz on-pic" id="maker-pause"/, 'the clip can be paused');
  assert.match(home, /\/catalog\/installs\?ids=/);
  assert.match(home, /MIN_INSTALLS_SHOWN = 10;/, 'a count shows only from 10 installs');
  assert.match(home, /AbortController/, 'a slow hub falls back to the catalog order');
  for (const lang of SITE_LANGS) assert.match(I18N[lang]['cat.installs'], /\{n\}/, `${lang} cat.installs`);
});

test('supporters see the prices in USD beside the names', () => {
  const s = section('support');
  assert.ok(s.indexOf('id="tiers"') < s.indexOf('id="bill"'), 'offers first, then the names');
  for (const lang of SITE_LANGS) {
    for (const k of ['tier.2.price', 'tier.month.price', 'tier.3.price']) {
      assert.match(I18N[lang][k], /^\d+ USD <small>/, `${lang} ${k}`);
    }
  }
  assert.doesNotMatch(home, /--blue|#008DFF;\s*margin/);
});

// Three plans beat four, the year is the one that stays and earns most, and the one-off
// month and the free week are lines, so they never compete with the plans for the key.
test('three plans, the year in front, renewals said aloud', () => {
  const s = section('support');
  const cards = [...s.matchAll(/<a class="tier( pick)?" href="([^"]+)"[^>]*data-track-location="([^"]+)"/g)];
  assert.deepEqual(cards.map((m) => m[3]), ['tier_month', 'tier_year', 'tier_pass']);
  assert.deepEqual(cards.map((m) => Boolean(m[1])), [false, true, false], 'the year is the one marked');
  assert.match(cards[0][2], /\/membership$/);
  assert.match(cards[1][2], /\/membership$/);
  assert.doesNotMatch(cards[2][2], /membership/, 'the pass is a one-off payment');
  assert.match(home, /\.tiers \{ display: grid; grid-template-columns: repeat\(3, /);
  const TEN = { en: /price of ten/, it: /prezzo di dieci/, es: /precio de diez/, fr: /prix de dix/, ja: /10 か月分の価格/, ko: /10개월 가격/, zh: /十个月的价格/ };
  const FIVE = { en: /5 coffees/, it: /5 caffè/, es: /5 cafés/, fr: /5 cafés/, ja: /コーヒー 5 杯/, ko: /커피 5잔/, zh: /5 杯咖啡/ };
  for (const l of SITE_LANGS) {
    assert.match(I18N[l]['tier.3.what'], TEN[l], `${l} says what the year saves`);
    assert.match(I18N[l]['tier.2.what'], FIVE[l], `${l} says how to pay the pass`);
    assert.equal(I18N[l]['tier.1.price'], undefined, `${l} keeps the old card`);
  }
  assert.doesNotMatch(home, /most popular|best value/i, 'a claim nobody can check');
});

test('the free week and the one-off month are plain lines in every language', () => {
  const s = section('support');
  assert.ok(s.indexOf('class="sup-try"') > s.indexOf('class="sup-all"'), 'below the Sparks line');
  assert.ok(s.indexOf('class="sup-once"') > s.indexOf('class="sup-try"'), 'the one-off month last');
  const WORD = { it: /Testi delle canzoni/, es: /Letra/, fr: /Paroles/, ja: /歌詞/, ko: /가사/, zh: /歌词/ };
  for (const l of SITE_LANGS) {
    const trial = I18N[l]['sup.trial'];
    const wants = l === 'en' ? "/trial'" : `/trial?lang=${l}'`;
    assert.ok(trial.includes(wants), `${l} keeps the reader's language: ${trial}`);
    assert.match(trial, /data-track='trial_click' data-track-location='home_support'/, l);
    assert.match(trial, /7/, l);
    assert.match(I18N[l]['sup.once'], /5 USD/, l);
    assert.match(I18N[l]['sup.once'], /data-track-location='tier_coffee'/, l);
    // It used to say only Lyrics could be tried. The trial opens the drops too.
    const unlock = I18N[l]['sup.unlock'];
    assert.match(unlock, /30/, `${l} names the 30 days`);
    if (WORD[l]) assert.match(unlock, WORD[l], `${l} keeps the app's name for Lyrics`);
  }
  for (const l of SITE_LANGS.filter((x) => x !== 'en')) {
    const copy = readFileSync(join(root, 'docs', l, 'index.html'), 'utf8');
    assert.ok(copy.includes(`/trial?lang=${l}' target='_blank' rel='noopener' data-track='trial_click'`), `${l} copy is baked`);
  }
});

test('the questions are five, each with its answer in every language', () => {
  const s = section('faq');
  const qs = [...s.matchAll(/<summary data-i18n="faq\.(\d)\.q">/g)].map((m) => m[1]);
  assert.deepEqual(qs, ['1', '2', '3', '4', '5']);
  for (const lang of SITE_LANGS) for (const n of qs) assert.ok(I18N[lang][`faq.${n}.a`], `${lang} faq.${n}.a`);
});

test('the page ends on Download: one key per system, Bit on the visitor\'s column', () => {
  const s = section('install');
  assert.match(s, /<h2 id="h-inst" data-i18n="inst\.h2">Download Xenon<\/h2>/);
  const FILES = {
    final_windows: 'Xenon-Setup-x64.exe',
    final_macos: 'Xenon-macOS-universal.dmg',
    final_linux: 'Xenon-Linux-x86_64.AppImage',
  };
  for (const [location, file] of Object.entries(FILES)) {
    assert.ok(s.includes(`<a class="key" data-os-fixed href="https://github.com/marcimastro98/Xenon/releases/latest/download/${file}" data-track="download_click" data-track-location="${location}"`), file);
  }
  assert.deepEqual([...s.matchAll(/<div class="os-col[^"]*" data-os="([a-z]+)">/g)].map((m) => m[1]), ['windows', 'macos', 'linux']);
  for (const href of ['/mac.html', '/linux.html', '/download.html', '/privacy.html']) assert.ok(s.includes(`href="${href}"`), href);
  assert.match(home, /document\.querySelectorAll\('\[data-os-icon\] use'\)/, 'the hero key takes the system\'s mark');
  assert.match(home, /col\.prepend\(bit\)/, 'Bit moves onto the visitor\'s column');
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
  const body = home.replace(/  I18N\.[a-z]{2} = \{[\s\S]*?\n  \};/g, '') + homeScripts;
  // Read by the build.
  const indirect = new Set(['meta.title', 'meta.desc']);
  const unused = en.filter((k) => !indirect.has(k) && !body.includes(`"${k}"`) && !body.includes(`'${k}'`));
  assert.deepEqual(unused, []);
  const used = [...body.matchAll(/data-i18n(?:-html|-alt|-aria)?="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].filter((k) => !(k in I18N.en)), []);
});

// Every plan brings 300 Scintille a month (hub AI_INCLUDED_CREDITS): one line
// under the three plans says so, with the app's own spark, as Xenon's credits.
test('one line under the tiers names the 300 Sparks of every plan, with the spark, in every language', () => {
  const UNIT = { en: 'Sparks', it: 'Scintille', es: 'Chispas', fr: 'Étincelles', ja: 'スパーク', ko: '스파크', zh: '火花' };
  const tiersEnd = home.indexOf('</div>', home.indexOf('<div class="tiers" id="tiers">'));
  assert.ok(home.indexOf('<p class="sup-all">') > tiersEnd, 'below the plans');
  assert.match(home, /<p class="sup-all"><img src="\/images\/brand\/spark\.svg" width="20" height="20" alt=""><span data-i18n="sup\.all">/);
  assert.ok(existsSync(join(root, 'docs', 'images', 'brand', 'spark.svg')), 'the spark file is there');
  for (const l of SITE_LANGS) {
    const v = I18N[l]['sup.all'];
    assert.ok(v && v.includes('300') && v.includes(UNIT[l]) && v.includes('Xenon'), `${l}: ${v}`);
    assert.doesNotMatch(v, /\bBit\b|—/, `${l} ties them to Bit or uses a dash`);
  }
  for (const l of SITE_LANGS.filter((x) => x !== 'en')) {
    const copy = readFileSync(join(root, 'docs', l, 'index.html'), 'utf8');
    assert.ok(copy.includes(`<span data-i18n="sup.all">${I18N[l]['sup.all']}</span>`), `${l} copy is baked`);
    // A copy lives in /<lang>/: a relative spark would look for /<lang>/images and show nothing.
    assert.equal((copy.match(/<img src="\/images\/brand\/spark\.svg"/g) || []).length, 1, `${l}: the one line, root-relative`);
    assert.doesNotMatch(copy, /<img src="images\/brand\/spark\.svg"/, `${l} has a relative spark`);
  }
});

// The packs the hub books (ai-credits.js TOPUP_PACKS) and the app sells
// (xenon-credits.js PACKS), behind "more" so the plans stay the choice.
test('the supporter section names the Sparks packs with their price, after the tiers, in every language', () => {
  const tiersEnd = home.indexOf('</div>', home.indexOf('<div class="tiers" id="tiers">'));
  const at = home.indexOf('<p data-i18n="sup.sparks">');
  assert.ok(at > tiersEnd, 'below the plans');
  assert.doesNotMatch(home.slice(at, home.indexOf('</p>', at)), /\/extras/, 'no link to the Extras until they are open');
  const UNIT = { en: 'Sparks', it: 'Scintille', es: 'Chispas', fr: 'Étincelles', ja: 'スパーク', ko: '스파크', zh: '火花' };
  for (const l of SITE_LANGS) {
    const v = I18N[l]['sup.sparks'];
    for (const bit of ['500', '1050', '2200', '5', '10', '20 USD', UNIT[l]]) assert.ok(v && v.includes(bit), `${l} lacks ${bit}: ${v}`);
    assert.equal(I18N[l]['sup.sparks.go'], undefined, `${l} keeps no link text`);
    assert.doesNotMatch(v, /\bBit\b|—/, `${l} ties them to Bit or uses a dash`);
  }
  for (const l of SITE_LANGS.filter((x) => x !== 'en')) {
    const copy = readFileSync(join(root, 'docs', l, 'index.html'), 'utf8');
    assert.ok(copy.includes(`<p data-i18n="sup.sparks">${I18N[l]['sup.sparks']}</p>`), `${l} copy is baked`);
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
  assert.deepEqual([...watched].sort(), [...sectionIds()].sort());
});
