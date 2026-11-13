// The Store at full screen: what must stay true of its shape, whatever moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from './browser-source.mjs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { appStringsSource } from './i18n-source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(here, '..', f), 'utf8').replace(/\r\n/g, '\n');
const js = read('js/community-gallery.js');
const css = read('components/CommunityStore/CommunityStore.css');
const modal = read('components/SettingsModal/SettingsModal.css');

test('the Store fills the screen and its stylesheet comes after the one it overrides', () => {
  assert.match(css, /\.preset-modal\.cst \{[^}]*width: 100%;[^}]*height: 100%;[^}]*max-width: none;[^}]*border-radius: 0;/s);
  assert.match(css, /\.cgal-overlay\.cst-overlay \{ padding: 0; \}/);
  const html = read('index.html');
  const own = html.indexOf('components/CommunityStore/CommunityStore.css');
  assert.ok(own > html.indexOf('components/SettingsModal/SettingsModal.css'));
  assert.ok(own < html.indexOf('styles/liquid-chrome.css'));
});

test('no blur on the slow path, and none when transparency is turned down', () => {
  assert.match(css, /body\.low-power-gpu \.preset-modal\.cst \{ backdrop-filter: none; \}/);
  assert.match(css, /prefers-reduced-transparency: reduce\) \{ \.preset-modal\.cst \{ backdrop-filter: none; \} \}/);
  assert.match(read('styles/page-tokens.css'), /body\.low-power-gpu :is\(\.cst-overlay, \.settings-overlay, \.xm-frame\) \{ --cst-page: var\(--cst-solid\); \}/);
});

test('every Store class the script names has a rule', () => {
  const inJs = new Set([...js.matchAll(/\bcst-[a-z-]+/g)].map((m) => m[0]));
  const named = new Set([...css.matchAll(/\.(cst-[a-z-]+)/g)].map((m) => m[1]));
  // Tokens are not classes, and a hook only the script reads needs no rule.
  for (const free of ['cst-sheet', 'cst-paper', 'cst-ink', 'cst-card-kind', 'cst-host-x']) inJs.delete(free);
  for (const c of inJs) assert.ok(named.has(c), c + ' has no rule');
});

test('the old Store is gone from the shared stylesheet, the shared parts stay', () => {
  for (const gone of ['.cgal-card', '.cgal-hero', '.cgal-spot', '.cgal-tab', '.cgal-khead', '.cgal-metachip', 'cgal-holo', '.cgal-info', '.cgal-unlock', 'cgal-pop', '.cgal-detail-head']) {
    assert.ok(!modal.includes(gone), gone);
  }
  for (const kept of ['.cgal-overlay', '.cgal-iconbtn', '.cgal-zoom', '.cgal-gal-stage']) {
    assert.ok(modal.includes(kept), kept);
  }
});

test('a card has no key: the whole card opens the page, where the choice is made', () => {
  const card = js.slice(js.indexOf('function renderCard('), js.indexOf('// Available updates for INSTALLED'));
  assert.ok(!card.includes('importButton'));
  assert.match(card, /wireCardOpen\(card, entry\)/);
});

test('Esc walks back one step and leaves what sits above the Store alone', () => {
  const key = js.slice(js.indexOf('function onStoreKey('), js.indexOf('function kindLabel('));
  assert.match(key, /if \(infoEl\) closeInfo\(\);\n\s*else if \(detailEntry\) closeDetail\(\);\n\s*else close\(\);/);
  assert.match(key, /\.cs-wrap\.cs-open/);
  assert.match(key, /\.preset-modal-overlay'\)\.length > 1/);
  assert.match(js, /document\.addEventListener\('keydown', onStoreKey, true\)/);
  assert.match(js, /document\.removeEventListener\('keydown', onStoreKey, true\)/);
});

test('a load that lost its turn draws nothing', () => {
  const render = js.slice(js.indexOf('async function render('), js.indexOf('function paintTab('));
  assert.match(render, /const turn = \+\+renderTurn;/);
  assert.ok((render.match(/turn !== renderTurn/g) || []).length >= 3, 'after every await');
  assert.match(js.slice(js.indexOf('function paintTab('), js.indexOf('function syncRail(')), /renderTurn \+= 1;/);
});

test('the hub still commands the shelves: one pass over its order, same contracts', () => {
  assert.match(js, /const LAYOUT = storefrontLayout\(out\.layout\);/);
  assert.match(js, /LAYOUT\.forEach\(\(b\) => \{\n\s*if \(!b\.on\) return;/);
  for (const type of ['spotlight', 'limited', 'supporters', 'new', 'archive', 'kinds']) {
    assert.ok(js.includes(`b.type === '${type}'`), type);
  }
  assert.match(js, /window\.Xenon\.storefront\.splitLimited\(limited, LAYOUT, dropUnavailable\)/);
});

test('the hero wears the entry\'s colours only when they can be read', () => {
  const start = js.indexOf('function hexRgb(');
  const end = js.indexOf('const firstSentence');
  const ctx = {};
  vm.runInNewContext(`${js.slice(start, end)}\nthis.readablePair = readablePair;`, Object.assign(ctx, { HERO_CONTRAST: 4.5 }));
  assert.equal(ctx.readablePair({ bg: '#14181c', text: '#f2f4f3' }), true);
  assert.equal(ctx.readablePair({ bg: '#fff', text: '#000' }), true, 'three digits too');
  assert.equal(ctx.readablePair({ bg: '#777777', text: '#888888' }), false);
  assert.equal(ctx.readablePair({ bg: 'url(x)', text: '#000000' }), false, 'anything else stays out of the style');
  assert.equal(ctx.readablePair(null), false);
});

test('the first sentence ends at its full stop, in every script', () => {
  const start = js.indexOf('const firstSentence');
  const end = js.indexOf('// One key: an entry that installs');
  const ctx = {};
  vm.runInNewContext(`${js.slice(start, end)}\nthis.firstSentence = firstSentence;`, ctx);
  assert.equal(ctx.firstSentence('A clock. It ticks.'), 'A clock.');
  assert.equal(ctx.firstSentence('v1.2 ships today! Soon more.'), 'v1.2 ships today!');
  assert.equal(ctx.firstSentence('時計です。動きます。'), '時計です。');
  assert.equal(ctx.firstSentence('No stop at all'), 'No stop at all');
});

test('a locked entry leads with one key, and an owner is not sold the membership', () => {
  const keys = js.slice(js.indexOf('function appendLockedButtons('), js.indexOf('// ── Fullscreen screenshot zoom'));
  assert.match(keys, /const trial = !trialUsed && trialCovers\(entry\);/);
  assert.match(keys, /tryTrialButton\('cst-key is-wide'\) : becomeSupporterButton\('cst-key is-wide'\)/);
  assert.match(keys, /entryInstallState\(entry\) !== 'none'/);
});

test('Installed and Sparks stay reachable by name from outside', () => {
  assert.match(js, /filterKind === '__installed'\) \? 'installed'/);
  assert.match(js, /window\.CommunityGallery = \{[^}]*\bopenSparks\b/);
  assert.match(js, /window\.CommunityGallery = \{[^}]*\bopenEntryById\b/);
});

test('supporter packs lead on their own paper, with the offer and the Sparks beside them', () => {
  const poster = js.slice(js.indexOf('function renderPoster('), js.indexOf('// Available updates for INSTALLED'));
  assert.match(poster, /readablePair\(entry\.preview\)/, 'an unreadable pair stays on the neutral well');
  assert.match(poster, /wireCardOpen\(card, entry\)/);
  const block = js.slice(js.indexOf("b.type === 'supporters'"), js.indexOf("} else if (b.type === 'new')"));
  assert.match(block, /card: renderPoster/);
  assert.match(block, /supporterBand\(\)/);
  assert.match(block, /sparksBand\(\)/);
  assert.match(js, /flatInto\(frag, sortList\(supporters\), undefined, renderPoster\)/);
  assert.match(js.slice(js.indexOf('function sparksBand('), js.indexOf('// What the current view is called')), /goView\('__sparks'\)/);
  // A PC that keeps a code is not sold what it has: one line, no key.
  const band = js.slice(js.indexOf('function supporterBand('), js.indexOf('function sparksBand('));
  const saved = band.slice(band.indexOf('if (supporterSaved) {'), band.indexOf('return band;'));
  assert.match(saved, /gallery_supporters_lead_saved/);
  assert.doesNotMatch(saved, /Button\(/);
});

test('an entry page fits a low screen: the gallery follows the height of the window', () => {
  assert.match(css, /--cst-gal-w: calc\(\(100dvh - 110px\) \* 1\.5\);/);
  assert.match(css, /grid-template-columns: minmax\(0, var\(--cst-gal-w\)\) minmax\(380px, 1fr\);/);
});

test('a date that has passed is not shown: an entry brought back by hand outlives it', () => {
  const label = js.slice(js.indexOf('function untilLabel('), js.indexOf('// What an entry costs'));
  assert.match(label, /ts < Date\.now\(\)\) return null;/);
  const page = readFileSync(path.join(here, '../../docs/catalog/index.html'), 'utf8');
  assert.match(page, /if \(!Number\.isFinite\(ts\) \|\| ts < Date\.now\(\)\) return null;/);
});

test('the demo keeps the server\'s rule: what the hub pulled is not in its Store', () => {
  const boot = readFileSync(path.join(here, '../../tools/demo/boot.js'), 'utf8');
  assert.match(boot, /e\.active === true \|\| \(e\.active !== false/);
});

test('the supporter sheet is for a PC with no code: with one, the link opens the Supporters list', () => {
  const sheet = js.slice(js.indexOf('function openSupporterInfo('), js.indexOf('function closeInfo') > js.indexOf('function openSupporterInfo(') ? js.indexOf('function closeInfo') : undefined);
  assert.match(sheet, /^function openSupporterInfo\(\) \{\s*if \(!overlayEl \|\| supporterSaved\) return;/);
  const open = js.slice(js.indexOf('async function openSupporters('));
  const first = open.slice(0, open.indexOf('openSupporterInfo()'));
  assert.match(first, /await refreshSupporterSaved\(\);/);
  assert.match(first, /if \(supporterSaved\) \{ goView\('__supporters'\); return; \}/);
  assert.ok(!js.includes('sparkPacks'), 'the packs are drawn in the Sparks view alone');
});

test('an item a PC can pay for says the price by the key, and only then', () => {
  const words = js.slice(js.indexOf('function detailWords('), js.indexOf('function detailWords(') + 2500);
  assert.match(words, /!supporterSaved && !sparksOnly\(entry\) && entryInstallState\(entry\) === 'none' \? memberLine\(\) : ''/);
  assert.match(words, /'cst-offer-line'/);
});

test('the shelves do not repeat Just added, and lead with what people install', () => {
  const home = js.slice(js.indexOf('function paintHome('), js.indexOf('function paintGrid('));
  assert.match(home, /byInstalls\(browse\.filter\([^\n]*!justAddedIds\.has/);
  assert.match(home, /KIND_SHELF_MIN/);
  assert.match(home, /gallery_more_shelf/);
  assert.match(home, /seeAll: true/);
  // The first paint waits a moment for the counts: the order must not jump under a finger.
  assert.match(js, /Promise\.race\(\[counts, new Promise\(\(go\) => \{ setTimeout\(go, INSTALLS_WAIT_MS\); \}\)\]\)/);
});

test('the Sparks band shows what the packs cost, in the card the catalog keeps beside the offer', () => {
  const band = js.slice(js.indexOf('function sparksBand('), js.indexOf('function askBitBlock('));
  assert.match(band, /C\.offerMark\(\)/);
  assert.match(band, /C\.PACKS/);
  assert.match(band, /C\.format\(p\.credits\)/);
  assert.match(band, /xai_pack_price/);
  assert.match(band, /goView\('__sparks'\)/);
});

test('a wide picture fills its card: looks from the centre, widgets and packs from the left', () => {
  assert.match(js, /CENTRED_KINDS = new Set\(\['theme', 'bg', 'ambient'\]\)/);
  assert.match(js, /media\.classList\.toggle\('from-left', wide && !CENTRED_KINDS\.has\(entry\.kind\)\)/);
  assert.match(css, /\.cgal-media\.from-left img \{ object-position: left center; \}/);
});

test('with no catalog the Store says so and offers to try again; a saved copy says it above the page', () => {
  const failed = js.slice(js.indexOf('function catalogFailed('), js.indexOf('async function render('));
  assert.match(failed, /gallery_error/);
  assert.match(failed, /gallery_retry/);
  assert.match(failed, /render\(body\)/, 'not a forced repaint: that keeps the failed page on screen');
  assert.match(js, /body\.replaceChildren\(catalogFailed\(body\)\)/);
  assert.match(js, /shell\.appendChild\(listHead\); if \(stale\) shell\.appendChild\(stale\); shell\.appendChild\(host\);/);
});

test('the search field stays one surface on a light theme', () => {
  // :root[data-appearance="light"] input[type="search"] weighs (0,3,1).
  assert.match(css, /\.cst \.cst-find input\.cst-search\[type\] \{[^}]*background: none;/s);
});

test('the changelog label stays neutral on a light theme', () => {
  // :root[data-appearance="light"] .cgal-changelog-label weighs (0,3,0).
  assert.match(css, /\.cst-overlay \.cst-detail \.cgal-detail-changelog \.cgal-changelog-label \{[^}]*color: var\(--cst-muted\);/s);
});

test('the words the Store added are in all 11 languages', () => {
  const i18n = vm.runInNewContext(appStringsSource() + '\ni18n;', { window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null }, document: { documentElement: {} } });
  for (const lang of ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']) {
    for (const key of ['gallery_more_shelf', 'gallery_ask_bit_line', 'gallery_ask_bit_key', 'gallery_ask_bit_draft', 'gallery_retry']) {
      const v = i18n[lang][key];
      assert.equal(typeof v, 'string', lang + ' ' + key);
      assert.doesNotMatch(v, /—/, lang + ' ' + key);
    }
    assert.match(i18n[lang].gallery_ask_bit_draft, /\{q\}/, lang);
  }
});
