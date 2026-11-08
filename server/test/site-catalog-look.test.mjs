// The catalog page (docs/catalog/index.html) on the home's system: a sheet with the
// name and the search, flat cards, the Supporters block as the home's yellow sheet,
// words instead of plates, and on a phone the start of each shelf.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const page = readFileSync(join(root, 'docs', 'catalog', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const css = page.slice(page.indexOf('<style>'), page.indexOf('</style>'));
const rules = (selector) => {
  const out = [];
  const re = new RegExp('(?:^|[\\n}])\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
  let m;
  while ((m = re.exec(css))) out.push(m[1]);
  assert.ok(out.length, `no rule ${selector}`);
  return out.join(';');
};

test('the sheet holds the name, the search and the count', () => {
  assert.match(page, /<body data-sheet="violet"[^>]*>/);
  assert.match(page, /<meta name="theme-color" content="#B4A0FF">/);
  const start = page.indexOf('<section class="pg"');
  const sheet = page.slice(start, page.indexOf('</section>', start));
  for (const part of ['<h1 id="pg-h"', 'id="toolbar"', 'id="countbar"', 'class="pg-bit"']) {
    assert.ok(sheet.includes(part), part);
  }
  // Both fill in by script and hold their place until then, so the page does not jump.
  assert.match(rules('.toolbar[hidden], .countbar[hidden]'), /visibility: hidden/);
});

test('a tag is words beside the author: no plate, and no kicker over the name', () => {
  for (const sel of ['.drop-badge', '.drop-badge.lim, .drop-badge.gold', '.drop-badge.sold']) {
    assert.doesNotMatch(rules(sel), /background|border|padding/, sel);
  }
  assert.ok(page.indexOf('meta.appendChild(badges)') > page.indexOf("el('h3', 'drop-name')"));
  assert.doesNotMatch(rules('.khead .kcnt, .sup-head .kcnt'), /border/);
});

test('the cards are flat, and nothing draws an emoji or a row of dots', () => {
  for (const sel of ['.cat-card', '.spot-card']) {
    assert.match(rules(sel), /background: var\(--g-1\)/, sel);
    assert.doesNotMatch(rules(sel), /border:/, sel);
  }
  assert.doesNotMatch(css, /\.cat-dots|\.drop-pal/);
  assert.doesNotMatch(page, /' ⭐'/);
  assert.match(page, /cico\('star', ?'by-star'\)/);
});

test('the Supporters block is the home\'s yellow sheet, with one fill', () => {
  assert.match(page, /s\.setAttribute\('data-sheet', 'yellow'\)/);
  assert.match(rules('.sup-strip::before'), /inset: 0 calc\(50% - 50vw\); background: var\(--sheet\)/);
  assert.match(rules('.sup-strip .plan'), /background: var\(--sheet-ink\)/);
  assert.match(rules('.sup-strip .plan-join'), /background: var\(--sheet\)/);
  assert.match(rules('.sup-strip :is(.cat-copy, .drop-foot .sjoin)'), /background: none/);
});

test('a locked card has one key: joining; the code is words for those who hold one', () => {
  const words = rules('.drop-foot .cat-unlock, .spot-foot .cat-unlock');
  assert.match(words, /background: none/);
  assert.match(words, /box-shadow: none/);
  assert.match(words, /text-decoration: underline/);
  assert.match(words, /min-height: 44px/);
  assert.equal(page.match(/if \(entry\.locked\) foot\.appendChild\(joinKey\(\)\);/g).length, 2, 'main and side cards');
  assert.match(rules('.spot-foot .sjoin'), /min-height: 44px/);
});

test('a date that has gone by is not announced as a deadline', () => {
  const from = page.indexOf('function untilEl');
  assert.match(page.slice(from, page.indexOf('let d;', from)), /ts < Date\.now\(\)/);
});

test('Italian says sostenitore, the word of the home and the app', () => {
  const it = page.slice(page.indexOf("'card.until': \"Disponibile fino al"), page.indexOf("'card.until': \"Disponible hasta"));
  assert.doesNotMatch(it.replace('Ruolo Supporter su Discord', ''), /\bSupporters?\b|\bsupporter\b/);
  assert.match(it, /'sec\.supporters_join': 'Diventa sostenitore'/);
});

test('a featured picture keeps its own shape, and in a rail it leads in the grid\'s box', () => {
  assert.match(rules('.drop-media .cat-shots'), /aspect-ratio: var\(--shot-ratio, 16 \/ 9\)/);
  assert.match(page, /strip\.style\.setProperty\('--shot-ratio', String\(ratio\)\)/);
  assert.match(page, /card\.classList\.toggle\('wide-shot', ratio > 2\.2\)/);
  assert.match(rules('.drop-card.wide-shot'), /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(rules('.drops.cat-rail .drop-card'), /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(rules('.drops.cat-rail .drop-media .cat-shots'), /aspect-ratio: 16 \/ 9/);
  // The arrows sit on the picture, not on the words under it.
  assert.match(rules('.rail-arw'), /top: calc\(25% - 22px\)/);
  // The site clears the transform of a hovered button: placed by one, it fell on hover.
  assert.doesNotMatch(rules('.rail-arw'), /transform/);
});

test('a card reached by a link clears the header and the strip', () => {
  for (const card of ['.cat-card', '.drop-card', '.spot-card']) {
    assert.match(rules(card), /scroll-margin-top: calc\(90px \+ var\(--strip-h, 0px\)\)/, card);
  }
});

test('on touch the row is swiped, so no arrow sits on the picture', () => {
  assert.match(page, /@media \(hover: none\) \{ \.rail-arw \{ display: none; \} \}/);
});

test('no glass over the pictures', () => {
  for (const sel of ['.cat-kind', '.cat-badge', '.cat-new', '.rail-arw']) {
    assert.doesNotMatch(rules(sel), /backdrop-filter/, sel);
  }
});

test('an entry page opens on its own picture and says its facts once', () => {
  const seo = readFileSync(join(root, 'tools', 'build-seo.mjs'), 'utf8');
  const entry = readFileSync(join(root, 'docs', 'catalog', 'nitrato', 'index.html'), 'utf8');
  assert.match(entry, /<body data-sheet="yellow">/, 'a supporters item sits on the Supporters sheet');
  assert.match(entry, /<figure class="pg-pic ent-pic"><img [^>]*fetchpriority="high"/);
  assert.match(entry, /<aside class="ent-side"/);
  assert.equal((entry.match(/<li><b>Version<\/b>/g) || []).length, 1);
  for (const gone of ['class="chip"', 'class="tier', 'class="btn', 'class="crumb"', 'border-left']) {
    assert.ok(!seo.includes(gone), gone);
  }
  assert.doesNotMatch(seo, /<\/a> ?→|→<\/a>/, 'no arrow glued to a link');
});

test('the list under an entry never holds a card without a picture', () => {
  const entry = readFileSync(join(root, 'docs', 'catalog', 'nitrato', 'index.html'), 'utf8');
  const more = entry.slice(entry.indexOf('id="more-h"'));
  assert.ok((more.match(/class="cr-card"/g) || []).length >= 4);
  assert.doesNotMatch(more, /<span class="cr-shot"><\/span>/);
});

test('a creator page and an entry page share one card, with the name first', () => {
  const seo = readFileSync(join(root, 'tools', 'build-seo.mjs'), 'utf8');
  assert.equal((seo.match(/class="cr-card"/g) || []).length, 1);
  const card = seo.slice(seo.indexOf('class="cr-card"'));
  assert.ok(card.indexOf('cr-n') < card.indexOf('cr-k'), 'no kicker over the name');
  assert.doesNotMatch(seo, / · supporter/);
});

test('filters and the link button are big enough to tap', () => {
  assert.match(rules('.seg button'), /min-height: 48px/);
  assert.match(rules('.cat-link'), /width: 44px; height: 44px/);
  assert.match(rules('.cat-search'), /min-height: 52px/);
});

test('a phone shows the start of each shelf, and what it hides stays reachable', () => {
  assert.match(css, /\.kblock\.shelf \.grid > :nth-child\(n\+3\)/);
  assert.match(page, /const PHONE_PREVIEW = 2;/);
  assert.match(page, /items\.length > PHONE_PREVIEW/);
  // A link to a card a phone hides opens its detail view.
  assert.match(page, /if \(c && c\.offsetParent\)/);
});

test('nothing jumps while the catalog loads: the wait holds a screen, the phone links never rewrap', () => {
  assert.match(page, /<div id="state" class="state state-wait"/);
  assert.match(page, /\.state-wait \{ min-height: 100vh; \}/);
  // A message that stays on screen is not a wait: no empty screen above the index.
  for (const key of ['state.empty', 'state.none', 'state.error']) {
    assert.ok(page.includes(`sayState('${key}')`), key);
  }
  assert.doesNotMatch(page, /stateEl\.textContent = T\('state\.(empty|none|error)'\)/);
  assert.match(page, /@media \(max-width: 700px\) \{ \.cat-more \{ flex-direction: column; align-items: flex-start; \} \}/);
});

test('every filter keeps its word on a phone: the row wraps, nothing is squeezed or hidden', () => {
  assert.match(rules('.seg button'), /flex: 0 0 auto/);
  assert.match(page, /@media \(max-width: 700px\) \{\n\s*\.seg \{[^}]*flex-wrap: wrap/);
});

test('an entry and its pictures are native dialogs: the browser holds the focus and hands it back', () => {
  assert.match(page, /<dialog class="lb" id="lb"/);
  assert.match(page, /const detailEl = el\('dialog', 'dt'\)/);
  assert.match(page, /detailEl\.showModal\(\)/);
  assert.match(page, /lb\.showModal\(\)/);
  assert.doesNotMatch(page, /setAttribute\('aria-modal'/);
  assert.match(page, /setAttribute\('aria-labelledby', 'dt-name'\)/);
  // Esc belongs to the browser: only the last dialog closes, and the page cleans up after it.
  assert.match(page, /detailEl\.addEventListener\('close'/);
  assert.match(page, /lb\.addEventListener\('close'/);
  assert.doesNotMatch(page, /e\.key === 'Escape'[^\n]*detailEl/);
  // Everything outside a modal dialog is inert, so the copy fallback works inside it.
  assert.match(page, /const host = document\.querySelector\('dialog\[open\]'\) \|\| document\.body/);
  assert.match(page, /html:has\(dialog\[open\]\) \{ overflow: hidden; scrollbar-gutter: stable; background: #000; \}/);
});

test('behind a dialog the page goes flat and dark: no white wash, no blur, no floating shadow', () => {
  for (const sel of ['.dt', '.dt-modal', '.lb', '.lb img']) {
    assert.doesNotMatch(rules(sel), /backdrop-filter|box-shadow/, sel);
  }
  assert.match(rules('.dt::backdrop'), /background: rgb\(0 0 0 \/ \.\d+\)/);
  assert.match(rules('.lb::backdrop'), /background: rgb\(0 0 0 \/ \.\d+\)/);
});

test('the name shows once, as the title of the dialog', () => {
  assert.doesNotMatch(page, /'dt-title'/);
  assert.equal(page.match(/el\('h2', 'dt-name'/g).length, 1);
  assert.match(page, /name\.setAttribute\('autofocus', ''\)/);
});

test('the way to get an entry sits outside the scroll, with one filled key', () => {
  assert.match(page, /modal\.append\(head, body, detailFoot\(entry\)\)/);
  assert.match(rules('.dt-keys .cat-copy, .dt-keys .dt-support'), /background: var\(--main\)/);
  assert.doesNotMatch(rules('.dt-keys .cat-unlock, .dt-keys .cat-try'), /background: var\(--main\)/);
  assert.ok(page.indexOf("keys.appendChild(join)") < page.indexOf("keys.appendChild(btn)"), 'join leads a locked entry');
});

test('a locked entry says what the plan costs beside its key, in every language', () => {
  const lines = page.match(/'dt\.plan': '[^\n]*?'(?=,\n)/g);
  assert.equal(lines.length, 7);
  for (const line of lines) {
    for (const part of ['{usd}', 'USD', '{spark}', '{n}']) assert.ok(line.includes(part), line);
  }
  assert.equal(page.match(/'dt\.free': /g).length, 7);
  assert.match(page, /join\.setAttribute\('data-track-location', 'catalog_detail'\)/);
});

test('nothing sits on a picture, and every picture shows as a thumbnail', () => {
  assert.doesNotMatch(page, /dt-arrow|dt-count/);
  assert.match(rules('.dt-thumbs'), /flex-wrap: wrap/);
  assert.doesNotMatch(rules('.dt-thumbs'), /overflow/);
  assert.doesNotMatch(rules('.dt-thumb'), /opacity/);
  assert.match(rules('.dt-track'), /scroll-snap-type: x mandatory/);
  assert.doesNotMatch(rules('.dt-stage'), /border:/);
  // A control, not a picture with a click: a keyboard reaches it.
  assert.match(page, /const slide = el\('button', 'dt-slide'\)/);
  assert.match(page, /<button class="lb-btn lb-prev" id="lb-prev" type="button"[^>]*><svg/);
});

test('the dialog holds words a visitor can use: no colour codes, no tags, no plates', () => {
  assert.doesNotMatch(page, /dt-swatches|dt-sw\b|dt-chip|dt-tags/);
  assert.doesNotMatch(rules('.dt-tier'), /border|background|padding/);
  assert.doesNotMatch(page, /cico\('heart'\)|cico\('lock'\)/);
});

test('the catalog writes Xenon with its capital, whatever the entry says', () => {
  assert.match(page, /\/\^xenon\$\/i\.test\(entry\.author\) \? 'Xenon' : entry\.author/);
});
