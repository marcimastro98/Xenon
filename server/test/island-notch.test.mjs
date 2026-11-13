import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const N = require('../js/island-notch.js');

// A 600px-wide tile item with a 7px gutter and 18px corners; the pill sits in
// its middle, 44px tall, ending 46px below the item's top.
const base = { width: 600, margin: 7, radius: 18, pill: { left: 200, right: 400, bottom: 46, height: 44 } };

test('geometry cuts one ring wider than the island and starts the content under it', () => {
  const g = N.geometry(base);
  assert.equal(g.left, 200 - N.GAP);
  assert.equal(g.right, 400 + N.GAP);
  assert.equal(g.bottom, 46 + N.GAP);
  assert.equal(g.inset, 46 + N.GAP - 7);
  assert.equal(g.openLeft, false);
  assert.equal(g.openRight, false);
  assert.equal(g.cornerR, 44 / 2 + N.GAP);
});

test('geometry is null when the island does not sit on the tile', () => {
  assert.equal(N.geometry({ ...base, pill: { ...base.pill, left: 700, right: 900 } }), null);
  assert.equal(N.geometry({ ...base, pill: { ...base.pill, bottom: -10 } }), null);
  assert.equal(N.geometry({ ...base, pill: { left: 590, right: 700, bottom: 46, height: 44 } }), null); // under 12px of overlap
  assert.equal(N.geometry(null), null);
});

test('a cutout that reaches the tile corner takes the whole corner', () => {
  const g = N.geometry({ ...base, pill: { ...base.pill, left: 10 } });
  assert.equal(g.openLeft, true);
  assert.equal(g.shoulderL, 0);
  assert.ok(g.left < 0);
  assert.equal(g.openRight, false);
});

test('clipPath keeps one command list, so cutouts can animate into each other', () => {
  const shape = (p) => p.replace(/-?\d+(\.\d+)?/g, '#');
  const g = N.geometry(base);
  const open = N.geometry({ ...base, pill: { ...base.pill, left: 10, right: 595 } });
  assert.equal(shape(N.clipPath(g)), shape(N.clipPath(N.collapsed(g))));
  assert.equal(shape(N.clipPath(g)), shape(N.clipPath(open)));
});

test('collapsed shrinks the cutout to its centre at the tile top', () => {
  const g = N.geometry(base);
  const c = N.collapsed(g);
  assert.equal(c.left, c.right);
  assert.equal(c.left, (g.left + g.right) / 2);
  assert.equal(c.bottom, base.margin);
  assert.equal(N.edgePath(c, 1).split(' ').length, N.edgePath(g, 1).split(' ').length);
});

test('flat keeps the cutout full width with no depth, so a soft opening shapes every tile at once', () => {
  const g = N.geometry(base);
  const f = N.flat(g);
  assert.equal(f.left, g.left);
  assert.equal(f.right, g.right);
  assert.equal(f.bottom, base.margin);
  assert.deepEqual([f.cornerR, f.shoulderL, f.shoulderR], [0, 0, 0]);
  const shape = (p) => p.replace(/-?\d+(\.\d+)?/g, '#');
  assert.equal(shape(N.clipPath(f)), shape(N.clipPath(g)));
  assert.equal(N.edgePath(f, 1).split(' ').length, N.edgePath(g, 1).split(' ').length);
  assert.equal(N.flat(null), null);
});

// A glass tile under the island takes the cutout on its surfaces, not on the
// item (an ancestor clip-path is the backdrop root and the blur saw nothing).
// The surfaces live in the content box, which starts `margin` inside the item,
// so the same cutout has to come out shifted by exactly that much.
test('surfaceClipPath is the item cutout moved into the content box', () => {
  const nums = (p) => p.match(/-?\d+(\.\d+)?/g).map(Number);
  const g = N.geometry(base);
  const item = nums(N.clipPath(g));
  const surface = nums(N.surfaceClipPath(g));
  assert.equal(surface.length, item.length);
  // The tile's top edge: item y = margin, surface y = 0.
  assert.match(N.surfaceClipPath(g), / V 0 A /);
  // The cutout's left wall and floor move by the gutter on both axes.
  assert.ok(N.surfaceClipPath(g).includes(`V ${g.bottom - base.margin - g.cornerR} `));
  assert.ok(N.surfaceClipPath(g).includes(` ${g.left - base.margin} ${base.margin - base.margin + g.shoulderL}`));
});

test('the item clip is unchanged by the surface variant', () => {
  const g = N.geometry(base);
  assert.equal(N.clipPath(g), N.clipPath(g, 0));
  assert.match(N.clipPath(g), /^path\("M -48 -48 H /);
  assert.equal(N.surfaceClipPath(null), '');
});

// Chromium sizes a glass tile's clip mask to the whole path: a bottom 10000px
// down cost 36 MB per tile under the island. The clip ends one spill under the tile.
test('the clip ends just under the tile when its height is known', () => {
  const last = (p) => Number(p.match(/V (-?[\d.]+) H -?[\d.]+ Z"\)$/)[1]);
  const g = N.geometry({ ...base, height: 652 });
  assert.equal(g.height, 652);
  assert.equal(last(N.clipPath(g)), 652 + 48);
  assert.equal(last(N.surfaceClipPath(g)), 652 + 48 - base.margin);
  assert.equal(last(N.clipPath(N.collapsed(g))), 652 + 48); // the closing shape keeps it
  assert.equal(last(N.clipPath(N.geometry(base))), 10000);  // unknown height: the old reach
});

test('the line along the cutout carries on the tile border, and a tile without one gets none', () => {
  assert.deepEqual(N.edgeLine({ borderLeftWidth: '1px', borderLeftColor: 'rgb(60, 60, 60)' }), { width: 1, color: 'rgb(60, 60, 60)' });
  assert.deepEqual(N.edgeLine({ borderLeftWidth: '0.667px', borderLeftColor: 'rgb(60, 60, 60)' }), { width: 1, color: 'rgb(60, 60, 60)' });
  // The Deck's bare frame: border 0, and its computed colour is the white of the text.
  assert.deepEqual(N.edgeLine({ borderLeftWidth: '0px', borderLeftColor: 'rgb(255, 255, 255)' }), { width: 0, color: 'transparent' });
});

// A tab strip beside the cutout. The strip in base's tile: 16px in from the item's
// left, at most to 584, and the content under it starting 53px down.
const strip = { left: 16, right: 584, need: 120, under: 53 };

test('a strip that fits beside the cutout stays where it is, one ring from the wall', () => {
  // The island takes the tile's right corner: the room is on the left.
  const g = N.geometry({ ...base, pill: { left: 400, right: 700, bottom: 46, height: 44 } });
  assert.equal(g.openRight, true);
  const b = N.besideBar(g, strip);
  assert.equal(b.shift, 0);
  assert.equal(b.max, g.left - N.GAP - strip.left);
  // Exactly the room fits; a pixel more does not, and the content then starts under the cutout.
  assert.ok(N.besideBar(g, { ...strip, need: g.left - N.GAP - strip.left }));
  assert.equal(N.besideBar(g, { ...strip, need: g.left - N.GAP - strip.left + 1 }), null);
});

test('a strip moves past a cutout that takes the tile corner it starts at', () => {
  const g = N.geometry({ ...base, pill: { left: -100, right: 150, bottom: 46, height: 44 } });
  assert.equal(g.openLeft, true);
  const b = N.besideBar(g, strip);
  assert.equal(b.shift, g.right + N.GAP - strip.left);
  assert.equal(b.max, strip.right - (g.right + N.GAP));
});

test('a cutout in the middle: the left side first, else the right, else none', () => {
  const g = N.geometry(base); // walls at 192 and 408: 168px of room on each side
  assert.equal(N.besideBar(g, strip).shift, 0);
  const narrowLeft = N.geometry({ ...base, pill: { left: 120, right: 300, bottom: 46, height: 44 } });
  assert.equal(N.besideBar(narrowLeft, { ...strip, need: 150 }).shift, narrowLeft.right + N.GAP - strip.left);
  assert.equal(N.besideBar(g, { ...strip, need: 200 }), null);
});

test('the content moves down only as far as the cutout reaches', () => {
  const g = N.geometry({ ...base, pill: { left: 400, right: 700, bottom: 46, height: 44 } });
  assert.equal(N.besideBar(g, strip).under, Math.ceil(g.bottom - strip.under));
  assert.equal(N.besideBar(g, { ...strip, under: g.bottom + 30 }).under, 0);
});

test('no strip beside an island that covers the whole tile top, or without a strip', () => {
  const g = N.geometry({ ...base, pill: { left: -50, right: 700, bottom: 46, height: 44 } });
  assert.equal(N.besideBar(g, strip), null);
  assert.equal(N.besideBar(N.geometry(base), null), null);
  assert.equal(N.besideBar(null, strip), null);
  assert.equal(N.besideBar(N.geometry(base), { ...strip, need: 0 }), null);
});

// The wiring the browser check (tools/island-tabs-check) exercises on the demo.
const { readFileSync } = await import('./browser-source.mjs');
const TOPBAR_JS = readFileSync(new URL('../js/topbar-minimal.js', import.meta.url), 'utf8');
const TOPBAR_CSS = readFileSync(new URL('../components/TopbarMinimal/TopbarMinimal.css', import.meta.url), 'utf8');

test('strips are read only on a shown page outside editing, and their place is part of the cutout key', () => {
  assert.match(TOPBAR_JS, /const readable = !editing && !grid\.closest\('\.pager-page\.is-parked'\);/);
  assert.match(TOPBAR_JS, /if \(!readable\) return barRooms\.get\(item\) \|\| null;/);
  assert.match(TOPBAR_JS, /const inset = bar \? parseFloat\(cs\.borderLeftWidth\) \|\| 0 : geo\.inset;/);
  assert.match(TOPBAR_JS, /\+ '\|' \+ clearance \+ '\|' \+ beside;/);
});

test('a tile the island leaves gives its strip back', () => {
  const body = (name) => TOPBAR_JS.slice(TOPBAR_JS.indexOf(`function ${name}(`), TOPBAR_JS.indexOf('\n  }\n', TOPBAR_JS.indexOf(`function ${name}(`)));
  assert.match(body('dropNotch'), /setBar\(item, null\);/);
  assert.match(body('releaseNotch'), /setBar\(item, null\);/);
});

test('the strip moves and the content under it moves down, on the content clock', () => {
  assert.match(TOPBAR_CSS, /\.island-clear > \.grid-stack-item-content > \.tabgroup > \.tabgroup-bar \{\s*translate: var\(--island-bar-shift, none\);\s*transition: translate var\(--island-content-ms, 360ms\)/);
  assert.match(TOPBAR_CSS, /\.island-beside > \.grid-stack-item-content > \.tabgroup > \.tabgroup-bar \{\s*max-width: var\(--island-bar-max, none\);/);
  assert.match(TOPBAR_CSS, /\.tabgroup > \.tabgroup-body \{\s*padding-top: var\(--island-under, 0px\);\s*transition: padding-top var\(--island-content-ms, 360ms\)/);
  assert.match(TOPBAR_CSS, /@media \(prefers-reduced-motion: reduce\) \{\s*body\.topbar-minimal \{ --island-notch-ms: 0ms; --island-content-ms: 0ms; \}/);
});

test('the island is measured on the page in view, whichever page the grid was read on', () => {
  // The pager shows its fourth page (scrolled 3 x 2532px); the grid read is the first.
  const pager = { left: 14, top: 0, width: 2532, height: 720 };
  const firstPage = { left: 14 - 3 * 2532, top: 0 };
  const grid = { left: firstPage.left + 0, top: 12, width: 2532, height: 666 };
  assert.deepEqual(N.gridInView(grid, firstPage, pager), { left: 14, top: 12, width: 2532, height: 666 });
  // The page in view itself, or no pager: the grid as it is.
  assert.deepEqual(N.gridInView({ ...grid, left: 14 }, { left: 14 }, pager), { left: 14, top: 12, width: 2532, height: 666 });
  assert.equal(N.gridInView(grid, null, pager), grid);
});

test('the notch pass places the island from the grid in view, not from the first unparked page', () => {
  assert.match(TOPBAR_JS, /N\.gridInView\(ref\.getBoundingClientRect\(\), home && home\.getBoundingClientRect\(\), pagerEl && pagerEl\.getBoundingClientRect\(\)\)/);
});

test('the island arrives from a dot after the boot splash, and nothing is cut before it', () => {
  assert.match(TOPBAR_JS, /if \(!arrive\(\)\) \{ clearIslandTags\(\); return; \}/);
  assert.match(TOPBAR_JS, /if \(behindSplash\(\)\) return false;/);
  assert.match(TOPBAR_JS, /window\.BootSplash\.whenGone\(\(\) => \{ splashWait = false; scheduleReflow\(\); \}\)/);
  assert.match(TOPBAR_JS, /arrived = true;\s*ui\.pill\.classList\.remove\('island-waiting'\);/);
  assert.match(TOPBAR_CSS, /\.topbar-mini\.island-waiting \{ opacity: 0; \}/);
  assert.match(TOPBAR_CSS, /\.topbar-mini\.island-arriving \{\s*animation: island-arrive 560ms/);
  assert.match(TOPBAR_JS, /const ARRIVE_HOLD_MS = 560;/);
});

test('the tile content slides on its own clock while the cut follows the island frame by frame', () => {
  assert.match(TOPBAR_CSS, /body\.island-following \{ --island-notch-ms: 0ms; \}/);
  assert.match(TOPBAR_CSS, /transition: border-top-width var\(--island-content-ms, 360ms\)/);
  assert.doesNotMatch(TOPBAR_CSS, /body\.island-following \{[^}]*--island-content-ms/);
});

test('an expanded SDK widget leaves its glass panel, so it covers the whole screen and the island', () => {
  const css = readFileSync(new URL('../components/CustomWidget/CustomWidget.css', import.meta.url), 'utf8');
  const rule = css.match(/\.custom-panel:has\(\.cw-wrap\.cw-expanded\) \{([^}]*)\}/);
  assert.ok(rule, 'the expanded rule exists');
  for (const prop of ['backdrop-filter: none', 'filter: none', 'transform: none', 'clip-path: none']) assert.ok(rule[1].includes(prop), prop);
});

test('a sliding page holds still, and its tiles open softly once a page is in place', () => {
  const has = (src, text) => assert.ok(src.includes(text), text);
  has(TOPBAR_JS, "el.addEventListener('scroll', onPagerScroll, { passive: true });");
  has(TOPBAR_JS, 'pageRestTimer = setTimeout(pageRest, PAGE_REST_MS);');
  has(TOPBAR_JS, 'if (paging) return; // the tiles hold still while a page slides; pageRest catches up');
  // Measured on screen, not from offsetLeft (its offset parent sits off the pager edge).
  has(TOPBAR_JS, 'const shift = page && pagerEl ? page.getBoundingClientRect().left - pagerLeft : 0;');
  has(TOPBAR_JS, 'if (span && Math.abs(shift) > HOME_SLACK) return;');
  has(TOPBAR_JS, 'const left = (n.x || 0) * colWidth + shift;');
  // A finger held mid-swipe: no page in place, nothing changes.
  has(TOPBAR_JS, 'if (!inPlace) return;');
  has(TOPBAR_JS, 'if (fresh && animate && !folded) {\n          startSoftOpen(item, st);');
  // The closed shape and the content at the top must be styled before the open
  // ones are written: two frames, then inset, strip and cut together.
  assert.match(TOPBAR_JS, /softOpen\(item\);\s*shutContent\(item, st\.line, st\.bar\);\s*item\.classList\.add\('island-clear'\);\s*drawNotch\(item, N\.flat\(st\.geo\), st\.line\);\s*requestAnimationFrame\(\(\) => requestAnimationFrame\(/);
  assert.match(TOPBAR_JS, /st\.started = true;\s*openContent\(item, st\);\s*openSoftly\(item, st, N\.flat\(st\.geo\)\);/);
  has(TOPBAR_JS, "item.style.setProperty('--island-inset', line.width + 'px');\n    setBar(item, bar ? { shift: 0, max: bar.max, under: 0 } : null);");
});

test('an opening cut heads for the island\'s new shape instead of snapping to it', () => {
  // Measured on screen: Meter Reading woke with its page, rewrote its island line,
  // the pill grew, and a direct draw replaced the opening with the whole cut.
  const has = (text) => assert.ok(TOPBAR_JS.includes(text), text);
  has("if (prev && prev.opening && !folded && item.classList.contains('island-clear')) {\n          retargetOpening(item, prev, { geo, line, key, inset, bar });\n          return;");
  has('Object.assign(st, next);\n    if (st.started) openContent(item, st);');
  // Each frame reads the shape as it is now, so a retarget is followed smoothly.
  has('drawNotch(item, N.between(from, st.geo, softEase(t)), st.line);');
  has('if (t < 1) requestAnimationFrame(step);\n      else st.opening = false;');
});

test('a glass tile slides its content too, not only its cut', () => {
  // Its surface rule outranks the content inset's, and one `transition` replaces
  // the other: measured on the Lyrics tile, the content dropped in one frame.
  const rule = TOPBAR_CSS.slice(TOPBAR_CSS.indexOf('clip-path: var(--island-notch-surface, none);'));
  const transition = rule.slice(0, rule.indexOf('}'));
  assert.ok(transition.includes('border-top-width var(--island-content-ms, 360ms)'), transition);
});

test('a soft opening draws the cut frame by frame, on the content\'s own curve', () => {
  // The cut is written each frame (a CSS transition cannot change target
  // mid-way without restarting), so its own transition is off meanwhile.
  assert.ok(TOPBAR_JS.includes("item.style.setProperty('--island-notch-ms', '0ms');"));
  // It stops once the tile is redrawn, released or dropped.
  assert.ok(TOPBAR_JS.includes('if (notchState.get(item) !== st || !st.key) { st.opening = false; return; }'));
  const src = TOPBAR_JS.match(/function softEase[\s\S]*?\n {2}\}\n/)[0];
  const ease = new Function(src + 'return softEase;')();
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  // cubic-bezier(.4, 0, .2, 1): slow start, most travel mid-way, gentle landing.
  assert.ok(Math.abs(ease(0.5) - 0.776) < 0.01, String(ease(0.5)));
  for (let t = 0.05; t <= 1; t += 0.05) assert.ok(ease(t) >= ease(t - 0.05));
});

test('between blends two cutouts and clamps', () => {
  const g = N.geometry(base);
  const f = N.flat(g);
  const half = N.between(f, g, 0.5);
  assert.equal(half.bottom, Math.round(((f.bottom + g.bottom) / 2) * 2) / 2);
  assert.equal(half.left, g.left);
  assert.deepEqual(N.between(f, g, 2), { ...g });
  assert.deepEqual(N.between(f, g, -1), { ...g, bottom: f.bottom, cornerR: 0, shoulderL: 0, shoulderR: 0 });
  assert.equal(N.between(null, g, 0.5), g);
});

test('a cutout that appears opens on a slower, even clock, and every island transition reads it', () => {
  assert.match(TOPBAR_JS, /const SOFT_OPEN = \{ ms: \d+, ease: 'cubic-bezier\(\.4, 0, \.2, 1\)' \};/);
  assert.ok(TOPBAR_JS.includes("const SOFT_PROPS = ['--island-notch-ms', '--island-content-ms', '--island-ease'];"));
  const curves = TOPBAR_CSS.match(/var\(--island-(notch|content)-ms, 360ms\) [^;]+;/g) || [];
  assert.ok(curves.length >= 6, 'every island transition found');
  for (const c of curves) assert.ok(c.includes('var(--island-ease, cubic-bezier(.32, .72, 0, 1))'), c);
});

test('performance mode and games skip the island motion', () => {
  assert.ok(TOPBAR_JS.includes("const MOTION_HOLD = ['perf-mode', 'game-mode'];"));
  assert.ok(TOPBAR_CSS.includes('body.topbar-minimal:is(.perf-mode, .game-mode) { --island-notch-ms: 0ms; --island-content-ms: 0ms; }'));
});
