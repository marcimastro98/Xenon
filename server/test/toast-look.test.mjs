// The toast card's geometry and motion (Toast.css, toast.js, toast-island.js).
// Pinned: the app tile, the first lines of text and the close button share
// one line; the island morphs to the card's real radius; the stack arrives on
// the island's own spring; reduced motion stops every flourish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../components/Toast/Toast.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const TOAST = readFileSync(new URL('../js/toast.js', import.meta.url), 'utf8');
const ISLAND = readFileSync(new URL('../js/toast-island.js', import.meta.url), 'utf8');

function rule(selector) {
  const at = CSS.indexOf('\n' + selector + ' {');
  assert.ok(at >= 0, selector + ' not found');
  return CSS.slice(at, CSS.indexOf('}', at));
}
const px = (block, prop) => Number(block.match(new RegExp(`\\n\\s*${prop}: (\\d+)px;`))?.[1]);

test('tile, text and close sit on one line', () => {
  const card = rule('.xtoast');
  const icon = rule('.xtoast-icon');
  const close = rule('.xtoast-close');
  const tile = px(icon, 'width');
  assert.equal(px(icon, 'height'), tile);
  assert.match(card, new RegExp(`grid-template-columns: ${tile}px minmax\\(0, 1fr\\) auto;`));
  assert.equal(px(rule('.xtoast-body'), 'min-height'), tile, 'a lone title is centred on the tile');
  assert.match(rule('.xtoast-body'), /justify-content: center;/);
  const button = px(rule('.xtoast-close,\n.xisland-more'), 'height');
  assert.equal(px(close, 'margin-top'), (tile - button) / 2, 'the close is centred on the tile');
});

test('the corners are concentric, and the island morphs to the same radius', () => {
  const card = rule('.xtoast');
  const radius = px(card, 'border-radius');
  assert.equal(radius, px(rule('.xtoast-icon'), 'border-radius') + px(card, 'padding'));
  assert.match(ISLAND, new RegExp(`const CARD_RADIUS = ${radius};`));
  assert.equal(px(rule('.xisland-bg'), 'border-radius'), radius);
});

test('the stack settles on the island spring, in CSS and in the glide', () => {
  const zeta = 0.8, w = 8.6, wd = w * Math.sqrt(1 - zeta * zeta);
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    pts.push(Number((1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + (zeta * w / wd) * Math.sin(wd * t))).toFixed(4)));
  }
  pts[40] = 1;
  assert.ok(CSS.includes(`--xt-settle: linear(${pts.join(', ')});`), 'Toast.css curve differs from springEasing()');
  assert.match(ISLAND, /const zeta = 0\.8, w = 8\.6,/);
  assert.match(CSS, /--xt-settle: cubic-bezier\(/, 'engines without linear() need a fallback');
  assert.match(rule('.xtoast'), /transform 0\.56s var\(--xt-settle\)/);
  assert.match(TOAST, /getPropertyValue\('--xt-settle'\)/);
});

test('the glass is denser on light paper, where bright tiles show through most', () => {
  const dark = Number(CSS.match(/--xt-fill: ([\d.]+);\n\}/)[1]);
  const light = Number(CSS.match(/:root\[data-appearance="light"\] :is\(\.xtoast-stack, \.xisland\) \{ --xt-fill: ([\d.]+); \}/)[1]);
  assert.ok(light > dark);
  assert.match(rule('.xtoast'), /rgba\(var\(--panel-rgb\), var\(--xt-fill\)\)/);
  assert.match(rule('.xisland-skin--card'), /rgba\(var\(--panel-rgb\), var\(--xt-fill\)\)/);
});

test('a success draws its tick, and reduced motion turns it off', () => {
  assert.match(TOAST, /d: 'M8 12\.5l2\.6 2\.6L16 9', class: 'xtoast-tick', pathLength: 1/);
  assert.match(CSS, /\.xtoast-in > \.xtoast-icon \.xtoast-tick \{\n\s*stroke-dasharray: 1;/);
  const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.xtoast-in > \.xtoast-icon \.xtoast-tick \{ animation: none; \}/);
});

test('a title gets two lines before it is cut, a list row keeps one', () => {
  assert.match(rule('.xtoast-title'), /-webkit-line-clamp: 2;/);
  assert.match(CSS, /\.xisland-row \.xtoast-title \{[^}]*display: block; white-space: nowrap;/);
});

test('"+N" sits on the tile line before the close, so a one-line card stays one line', () => {
  assert.match(rule('.xtoast.has-more'), /grid-template-columns: 36px minmax\(0, 1fr\) auto auto;/);
  assert.match(rule('.xtoast.has-more > .xtoast-close'), /grid-column: 4; grid-row: 1;/);
  const chip = rule('.xisland-more');
  assert.match(chip, /grid-column: 3;\n\s*grid-row: 1;/);
  assert.doesNotMatch(CSS, /\.xtoast\.has-more[^{]*\{[^}]*grid-template-rows/, 'no second row for the chip');
  assert.match(CSS, /\.xisland-more::after \{ right: 0; \}/, 'the chip target never covers the close');
});

// Slice one `function <name>(…) { … }` out of toast-island.js.
function islandFn(signature) {
  const start = ISLAND.indexOf(signature);
  assert.ok(start >= 0, signature + ' not found');
  let depth = 0;
  for (let i = ISLAND.indexOf('{', start); i < ISLAND.length; i++) {
    if (ISLAND[i] === '{') depth++;
    else if (ISLAND[i] === '}' && --depth === 0) return ISLAND.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + signature);
}

test('the island content is clipped to the glass while it morphs', async () => {
  const vm = await import('node:vm');
  const clipTo = vm.runInNewContext('(' + islandFn('function clipTo(g, s)') + ')');
  const slot = { left: 100, top: 10, width: 400, height: 90 };
  // The glass still the clock pill: the content shows only through it.
  assert.equal(clipTo({ left: 260, top: 10, width: 80, height: 32, radius: 16 }, slot), 'inset(0px 160px 58px 160px round 16px)');
  // The glass as large as the slot, or larger: nothing is cut.
  assert.equal(clipTo({ left: 90, top: 0, width: 420, height: 110, radius: 22 }, slot), 'inset(0px 0px 0px 0px round 22px)');
  const morph = islandFn('function morphBox(');
  assert.match(morph, /a\.id === 'xisland-clip'\) a\.cancel\(\)/, 'a new morph replaces the old clip');
  assert.match(morph, /clipPath: clipTo\(from, box\) \}, \{ clipPath: clipTo\(to, box\)/);
});

test('a swap fades the next card in at once; only an opening waits for the glass', () => {
  assert.match(ISLAND, /const at = opening \? ms \* CONTENT_IN_AT : 0;/);
  assert.match(ISLAND, /await fade\(next, 1, CONTENT_IN_MS, at, CONTENT_RISE\);/);
});
