// How a notification leaves the island (js/toast-island.js). Reported 25 Oct
// 2026: as a card closed, the glass always shrank into the clock pill's shape,
// even when the pill was under Settings, so an empty capsule floated over the
// overlay and blinked out; with the pill on screen the glass still landed empty
// and the clock faded in after. Now the glass lands only on a pill that is on
// screen, carrying a copy of its face, and otherwise settles out in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../js/toast-island.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../components/Toast/Toast.css', import.meta.url), 'utf8');
const PILL_CSS = readFileSync(new URL('../components/TopbarMinimal/TopbarMinimal.css', import.meta.url), 'utf8');

// Slice one `function <name>(…) { … }` out of the source.
function fnSource(signature) {
  const start = SRC.indexOf(signature);
  assert.ok(start >= 0, signature + ' not found');
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + signature);
}

// A tiny element tree: each node has a parent, a position and a z-index.
function el(position, zIndex, parent) { return { position, zIndex: String(zIndex), parentElement: parent || null }; }

function homeOnScreen(home, hits, islandEls = []) {
  const body = el('static', 'auto');
  const fixParent = (n) => { if (n && !n.parentElement) n.parentElement = body; return n; };
  hits.forEach(fixParent);
  const ctx = {
    HOME_Z: Number(SRC.match(/const HOME_Z = (\d+);/)[1]),
    root: { contains: (n) => islandEls.includes(n) },
    document: { body, elementsFromPoint: () => hits },
    getComputedStyle: (n) => ({ position: n.position, zIndex: n.zIndex }),
    home,
  };
  return vm.runInNewContext(fnSource('function homeOnScreen(home)') + '; homeOnScreen(home);', ctx);
}

const PILL = { left: 600, top: 9, width: 680, height: 48, radius: 24, pill: true };

test('HOME_Z matches the pill z-index in TopbarMinimal.css', () => {
  const z = SRC.match(/const HOME_Z = (\d+);/)[1];
  assert.match(PILL_CSS, new RegExp(`z-index: ${z};\\s*/\\* above tiles`));
});

test('a pill with only tiles around it is a place to land', () => {
  const tile = el('relative', 2);
  assert.equal(homeOnScreen(PILL, [tile]), true);
  assert.equal(homeOnScreen(PILL, []), true, 'nothing at all on the spot is not a cover');
});

test('a pill under Settings (or any overlay above its band) is not', () => {
  const overlay = el('fixed', 220);
  const button = el('static', 'auto', el('relative', 'auto', overlay));
  assert.equal(homeOnScreen(PILL, [button]), false);
});

test('the island itself never counts as a cover', () => {
  const card = el('absolute', 5200);
  const tile = el('relative', 2);
  assert.equal(homeOnScreen(PILL, [card, tile], [card]), true);
});

test('no pill (the fallback capsule, or none measured) means settle out in place', () => {
  assert.equal(homeOnScreen(null, []), false);
  assert.equal(homeOnScreen({ ...PILL, pill: false, none: true }, []), false);
});

test('close checks the home before choosing to land, and the text leaves as the glass moves', () => {
  const close = fnSource('async function close(g)');
  assert.match(close, /homeOnScreen\(home\)/);
  assert.match(close, /if \(landing\)[\s\S]*carryHome\(home\)[\s\S]*morphBox\(home, BOX_MS\.close\)[\s\S]*else[\s\S]*vanish\(\)/);
  assert.doesNotMatch(close, /await fade\(cur/, 'the glass must not wait for the text to fade');
});

test('settling out fades the skins, never the glass parent (that would drop the blur)', () => {
  const vanish = fnSource('function vanish()');
  assert.match(vanish, /Array\.from\(bg\.children\)\.forEach\(s => fade\(s, 0/);
  assert.doesNotMatch(vanish, /fade\(bg\b|bg\.style\.opacity/);
});

test('the pill copy is inert, unannounced and carries no duplicate ids', () => {
  const carry = fnSource('function carryHome(home)');
  assert.match(carry, /ghost\.removeAttribute\('id'\)/);
  assert.match(carry, /querySelectorAll\('\[id\]'\)\.forEach\(el => el\.removeAttribute\('id'\)\)/);
  assert.match(carry, /ghost\.inert = true/);
  assert.match(carry, /setAttribute\('aria-hidden', 'true'\)/);
  assert.match(carry, /classList\.remove\('mini-yield'/, 'the copy must not inherit the hidden contents');
  assert.match(carry, /if \(!pill \|\| reduced\(\)\) return;/, 'no copy under reduced motion');
});

test('the copy is dropped when news catches the glass on its way home, and goes with the layer', () => {
  assert.match(SRC, /if \(homing\) \{ homing = false; dropGhost\(\);/);
  assert.match(fnSource('function release(fromFling)'), /root = bg = slot = pillSkin = ghost = target = null/);
});

test('the copy is shown over body.xtoast-island, faces only, never clickable', () => {
  const rule = CSS.slice(CSS.indexOf('.xisland > .xisland-ghost {'));
  const body = rule.slice(0, rule.indexOf('}'));
  for (const decl of ['visibility: visible', 'background: none', 'pointer-events: none', 'backdrop-filter: none']) {
    assert.ok(body.includes(decl), decl);
  }
});
