// Bit at a size that is not a whole number of device pixels per cell (a 20 px
// icon on a 150% screen is 2.5): with crispEdges each cell snapped on its own
// and one eye came out wider than the other. So Bit is painted as anti-aliased
// paths, one per colour, and the icon box sits on whole cells.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bit = require('../../packages/core/src/bit.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('rects of one colour become one path, in paint order', () => {
  const body = { x: 2, y: 3, w: 8, h: 6, fill: '#0f0', o: 1 };
  const top = { x: 3, y: 2, w: 6, h: 1, fill: '#0f0', o: 1 };
  const eye = { x: 4, y: 4, w: 1, h: 2, fill: '#000', o: 1 };
  const glow = { x: 0, y: 0, w: 1, h: 1, fill: '#000', o: 0.5 };
  const out = bit.paths([body, top, eye, glow]);
  assert.deepEqual(out.map((p) => [p.fill, p.o]), [['#0f0', 1], ['#000', 1], ['#000', 0.5]]);
  assert.equal(out[0].d, 'M2 3h8v6h-8zM3 2h6v1h-6z');
});

test('a still Bit has no snapped cells and no seams between them', () => {
  const svg = bit.frameSvg('idle', 0, { size: 18 });
  assert.doesNotMatch(svg, /crispEdges/);
  assert.doesNotMatch(svg.replace(/<defs>.*?<\/defs>/, ''), /<rect /, 'paths, not one rect per cell');
  assert.match(svg, /<path d="M/);
});

test('the player paints the same paths', () => {
  const player = read('../../packages/core/src/bit-player.js');
  assert.doesNotMatch(player, /crispEdges/);
  assert.match(player, /bit\.paths\(l\.rects\)/);
});

test('the fixed faces drawn by hand are not snapped either', () => {
  const html = read('../index.html');
  const faces = html.match(/<svg class="bit-nav-sprite".*?<\/svg>/s)[0];
  assert.doesNotMatch(faces, /crispEdges/);
  assert.doesNotMatch(read('../js/bit-message-card.js'), /crispEdges/);
});
