// What a visitor can press, in one order on every page: one main key in view, at most one
// outlined key beside it, one row of marks or plain links for the rest, the same size
// everywhere, and GitHub as its mark alone. tools/site-review/actions.mjs holds the rendered pages to the same rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headerHtml, footerHtml, chromeLabels } from '../../tools/site-chrome.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const SITE_LANGS = ['en', 'it', 'es', 'fr', 'ja', 'ko', 'zh'];

const pages = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory() && e.name !== 'demo') walk(p);
    else if (e.name.endsWith('.html')) pages.push(p);
  }
};
walk(join(root, 'docs'));

const home = read('docs/index.html');
const site = read('docs/site.css');
const chrome = read('docs/chrome.js');

// The body of the first rule whose selector is exactly `selector`.
function rule(css, selector) {
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `no rule for ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}

const between = (text, from, to) => {
  const at = text.indexOf(from);
  assert.ok(at >= 0, `no ${from}`);
  return text.slice(at, text.indexOf(to, at));
};

test('GitHub is its mark alone: no star and no count anywhere on the site', () => {
  const star = /xh-stars?\b|gh-stars?\b|stargazers|xenon\.site\.stars|"p\.st"|pf-gh/;
  for (const f of ['docs/chrome.js', 'docs/site.css', 'docs/guide.css', 'tools/site-chrome.mjs']) {
    assert.doesNotMatch(read(f), star, f);
  }
  for (const p of pages) assert.doesNotMatch(readFileSync(p, 'utf8'), star, relative(root, p));
});

test('the privacy page says what the site still asks GitHub, in every language', () => {
  for (const lang of SITE_LANGS) {
    const file = lang === 'en' ? 'docs/privacy.html' : `docs/${lang}/privacy.html`;
    assert.doesNotMatch(read(file), /star count|stelle del progetto|スター数|별 개수|星标数|estrellas del proyecto|nombre d'étoiles/i, file);
  }
  assert.match(read('docs/privacy.html'), /asks the GitHub API for the download count/);
});

test('the bar holds Discord and GitHub, and the coffee stays in the menu', () => {
  const shared = between(headerHtml(), '<div class="xh-marks">', '</div>');
  const own = between(home, '<div class="marks">', '</div>');
  for (const marks of [shared, own]) {
    assert.match(marks, /discord\.gg/);
    assert.match(marks, /github\.com\/marcimastro98\/Xenon/);
    assert.doesNotMatch(marks, /buymeacoffee/);
  }
  assert.match(between(headerHtml(), '<ul class="xh-mlinks">', '</ul>'), /buymeacoffee/);
  assert.match(between(home, '<ul class="mlinks">', '</ul>'), /buymeacoffee/);
});

test('the hero offers one main key, one outlined key and one row of marks', () => {
  const hero = between(home, '<div class="hero-act">', '<div class="stage">');
  assert.equal(hero.match(/class="key for-desk"/g).length, 1);
  assert.equal(hero.match(/class="key-alt for-desk"/g).length, 1);
  assert.doesNotMatch(hero, /data-store-badge/, 'the badge is a third kind of button: it lives in the download section');
  const row = between(hero, '<div class="act-row for-desk">', '<button');
  assert.match(row, /id="hero-store"[^>]*data-track="store_click"[^>]*><svg[^>]*><use href="#i-store"\/>/);
  for (const mark of ['#i-store', '#os-mac', '#os-linux', '#i-dl', '#i-dc', '#i-gh']) assert.ok(row.includes(`<use href="${mark}"/>`), mark);
  assert.match(home, /<a class="store"[^>]*>\s*<img data-store-badge/, 'the download section keeps the official badge');
});

test('the marks under the keys are one family: same class, one colour, a name a screen reader can say', () => {
  const row = between(home, '<div class="act-row for-desk">', '<button');
  const marks = row.split('</a>').filter((m) => m.includes('<a '));
  assert.equal(marks.length, 4);
  for (const mark of marks) {
    assert.match(mark, /<a class="mk/);
    assert.match(mark, /class="sr"|data-i18n="hero\.alt"/, 'a logo alone needs words for a screen reader');
  }
  assert.doesNotMatch(row, /<img/, 'a picture in colour would be the one mark out of line');
  assert.match(rule(home, '.act-row .mk svg'), /width: 22px; height: 22px/);
  for (const name of ['i-store', 'i-dl']) assert.doesNotMatch(between(home, `<symbol id="${name}"`, '</symbol>'), /stroke/, `${name} is solid, like the marks beside it`);
});

test('the keys and marks stop short of Bit on every width but the phone', () => {
  assert.match(rule(home, '.hero-act'), /max-width: calc\(94\.5% - clamp\(62px, 6\.4vw, 96px\) - 16px\)/);
  assert.match(home, /@media[^{]*\{[\s\S]*\.hero-act \{ display: grid; gap: 8px; max-width: none;/);
  assert.match(rule(home, '.bit-big'), /right: 5\.5%;[^}]*width: clamp\(62px, 6\.4vw, 96px\)/, 'the limit above repeats these two numbers');
});

test('the numbers keep their place, so nothing in the row moves when they land', () => {
  assert.match(rule(home, '.act-row .n'), /min-width: 3ch/);
  assert.match(rule(home, '#p-dl .n'), /min-width: 5ch/);
});

test('the Store link in the hero only shows where the Store exists', () => {
  assert.match(home, /document\.getElementById\('hero-store'\)/);
  assert.doesNotMatch(home, /a\.store:not/);
  assert.doesNotMatch(home, /\.act-row > a:not\(\.store\)/, 'the hero has no badge left for that rule to skip');
});

test('a key is one size on every page', () => {
  const size = /min-height: 56px/;
  const type = /font: 700 19px\/1\.1 /;
  for (const [css, sel] of [[home, '.key'], [home, '.key-alt'], [site, '.pg-key, .pg-alt']]) {
    assert.match(rule(css, sel), size, sel);
    assert.match(rule(css, sel), type, sel);
  }
  const guide = read('docs/guide.css');
  assert.doesNotMatch(rule(guide, '.os-col .pg-key'), /min-height|font-size/, 'the Download page keeps the same key');
  const join_ = between(read('docs/catalog/index.html'), '.plan-join {', '}');
  assert.match(join_, size);
  assert.match(join_, /font: 700 19px/);
});

test('a sheet holds one key and one outlined key at most', () => {
  let seen = 0;
  for (const p of pages) {
    const html = readFileSync(p, 'utf8');
    for (const m of html.matchAll(/<div class="pg-act[^"]*"[^>]*>([\s\S]*?)<\/div>/g)) {
      seen += 1;
      const name = relative(root, p);
      assert.ok((m[1].match(/class="pg-key/g) || []).length <= 1, `${name}: two keys`);
      assert.ok((m[1].match(/class="pg-alt/g) || []).length <= 1, `${name}: two outlined keys`);
    }
  }
  assert.ok(seen > 50, `${seen} action rows`);
});

test('Download in the bar steps back while the page has its own key in view', () => {
  assert.match(site, /body:is\(\[data-own-key\], :has\(\.pg-key\)\) \.xh-dl:not\(\.lit\) \{[^}]*background: none/);
  assert.match(chrome, /querySelectorAll\('\.pg-key'\)/, 'a hidden key must not count as gone by');
  assert.match(home, /document\.querySelectorAll\('main \.key'\)\.forEach\(\(k\) => keys\.observe\(k\)\)/, 'the home steps back for its last key too');
  for (const page of ['docs/thanks.html', 'docs/submit/index.html', 'docs/catalog/index.html']) assert.match(read(page), /<body[^>]*data-own-key/, `${page} draws its own key`);
  assert.match(chrome, /toggle\('lit', !/);
  assert.match(rule(site, '.xh-dl'), /background: var\(--main\)/, 'with no key on the page it is the main action');
});

test('a key on a guide names the system in every language, a handheld keeps the plain name', () => {
  const L = chromeLabels();
  for (const lang of SITE_LANGS) {
    assert.match(L[lang].cta, /Windows/, lang);
    assert.match(L[lang].ctaos, /\{os\}/, lang);
    assert.equal(L[lang].cta, L[lang].ctaos.replace('{os}', 'Windows'), lang);
    assert.match(L[lang].ctaany, /Xenon/, lang);
    const page = read(lang === 'en' ? 'docs/deck.html' : `docs/${lang}/deck.html`);
    assert.ok(page.includes(`data-xl="cta">${L[lang].cta}<`), `${lang} deck page`);
  }
  assert.match(site, /\.pg-key:is\(\[data-dl\], \[data-for\]\)::before/);
  assert.match(chrome, /documentElement\.setAttribute\('data-os'/);
  for (const os of ['windows', 'mac', 'linux']) assert.match(read(`docs/images/os/${os}.svg`), /<svg /);
});

test('the Mac and Linux pages name their own system, whatever the visitor runs', () => {
  const L = chromeLabels();
  for (const lang of SITE_LANGS) {
    const at = (page) => read(lang === 'en' ? `docs/${page}` : `docs/${lang}/${page}`);
    assert.ok(at('mac.html').includes(`data-xl="ctamac">${L[lang].ctamac}<`), `${lang} mac`);
    assert.ok(at('linux.html').includes(`data-xl="ctalinux">${L[lang].ctalinux}<`), `${lang} linux`);
    assert.match(L[lang].ctamac, /macOS/, lang);
    assert.match(L[lang].ctalinux, /Linux/, lang);
  }
});

test('every other key that says Download is the one that follows the visitor', () => {
  for (const p of pages) {
    for (const m of readFileSync(p, 'utf8').matchAll(/<a class="pg-key"[^>]*data-xl="cta"[^>]*>/g)) {
      assert.match(m[0], /data-dl/, relative(root, p));
    }
  }
});

test('the first line says widgets in every language and promises no second screen', () => {
  const word = { en: /widgets/, it: /widget/, es: /widgets/, fr: /widgets/, ja: /ウィジェット/, ko: /위젯/, zh: /小组件/ };
  const old = /dashboard|second screen|secondo schermo|segunda pantalla|second écran|ダッシュボード|サブモニター|대시보드|두 번째|仪表盘|副屏/i;
  for (const lang of SITE_LANGS) {
    const page = lang === 'en' ? home : read(`docs/${lang}/index.html`);
    const h1 = /<h1 id="h1"[^>]*>([^<]*)<\/h1>/.exec(page)[1];
    assert.match(h1, word[lang], lang);
    assert.doesNotMatch(h1, old, lang);
    const title = /<title>([^<]*)<\/title>/.exec(page)[1];
    assert.match(title, word[lang], `${lang} title`);
  }
});

test('the line in the footer says the same thing as the home', () => {
  const L = chromeLabels();
  for (const lang of SITE_LANGS) assert.doesNotMatch(L[lang].tag, /dashboard|tableau de bord|panel|ダッシュボード|대시보드|仪表盘/i, lang);
  assert.ok(footerHtml().includes(`data-xl="tag">${L.en.tag}<`));
});

test('the first line of the guides says what Xenon is today, in every language', () => {
  const OLD = /dashboard|panel (táctil )?gratuito|대시보드|ダッシュボード|仪表盘|next to (a|your) PC/i;
  for (const lang of SITE_LANGS) {
    for (const guide of ['mac', 'linux', 'sensor-panel', 'widgets', 'deck', 'phone']) {
      const path = lang === 'en' ? `docs/${guide}.html` : `docs/${lang}/${guide}.html`;
      const lede = /<p class="lede"[^>]*>([\s\S]*?)<\/p>/.exec(read(path))?.[1];
      assert.ok(lede, `${path}: no opening line`);
      assert.doesNotMatch(lede, OLD, path);
    }
  }
});

test('the share page opens with the home headline, in every language', () => {
  const h1 = (html) => /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)[1].trim();
  const homes = SITE_LANGS.map((lang) => h1(read(lang === 'en' ? 'docs/index.html' : `docs/${lang}/index.html`)));
  const get = read('docs/get/index.html');
  const said = [...get.matchAll(/nh1: (["'])(.*?)\1/g)].map((m) => m[2]);
  assert.deepEqual([...new Set(said)].sort(), [...new Set(homes)].sort());
  assert.ok(homes.includes(h1(get)));
});

test('the Linux page says when it was updated in a sentence, not a dotted string', () => {
  assert.doesNotMatch(read('docs/linux.html'), /Last updated[^<]*·/);
});
