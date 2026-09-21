import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// A Deck profile has to look like itself on every screen it lands on. It did
// not: the cap grows to fill the well (.deck-grid sizes the tracks from
// container-query units, with no maximum), but every glyph-style icon and the
// cap label were clamp()ed to a pixel ceiling tuned for the largest key-size
// preset — roughly a 104px cap. Past that the cap kept growing and the contents
// did not.
//
// Measured from the report ("icon scaling is inconsistent between the web app
// and the macOS app", a Xeneon Edge next to a desktop browser): caps of ~86px on
// the Edge and ~178px on the desktop. At 86px every icon sat in the linear part
// of the clamp and read at 40% of the cap; at 178px the same icon was pinned at
// its 42px ceiling and read at 24%. Full-bleed picture keys — sized 100% of the
// cap, no ceiling to hit — were unaffected, which is why only SOME keys looked
// wrong and the difference read as random.
//
// So the property under test is not a number, it is a ratio: icon-to-cap and
// label-to-cap must come out the same at both cap sizes.

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(__dirname, '..', 'components', 'DeckPanel', 'DeckPanel.css'), 'utf8');

const EDGE_CAP = 86;     // a Xeneon Edge deck tile
const DESKTOP_CAP = 178; // the same deck given a large desktop display

// Every sizing rule this is about, by the declaration that carries it.
const SIZED = [
  { what: 'cap label', re: /\.deck-key \{[\s\S]*?font-size: ([^;]+);/ },
  { what: 'emoji glyph', re: /\.deck-key \.deck-ico \{\s*font-size: ([^;]+);/ },
  { what: 'image icon', re: /\.deck-key \.deck-ico img \{\s*width: ([^;]+);/ },
  { what: 'built-in vector icon', re: /\.deck-key \.deck-ico\.is-builtin svg \{\s*width: ([^;]+);/ },
  { what: 'small image icon', re: /\.deck-key \.deck-ico\.is-img-small img \{\s*width: ([^;]+);/ },
];

function decl(entry) {
  const m = entry.re.exec(CSS);
  assert.ok(m, `the ${entry.what} sizing rule is gone`);
  return m[1];
}

// Evaluate one of these declarations for a given cap size. They are all the same
// shape — max(<floor>px, calc(<cap> * <fraction>)) optionally multiplied by the
// per-key --ico-scale preset — so a tiny evaluator is enough, and it fails loudly
// rather than guessing if the shape ever changes.
function sizeAt(declaration, cap, icoScale = 1) {
  const m = /^(?:calc\()?max\((\d+(?:\.\d+)?)px,\s*calc\(var\(--deck-cell, var\(--deck-key-min, 76px\)\) \* (\.\d+)\)\)(?: \* var\(--ico-scale, 1\))?\)?$/
    .exec(declaration.trim());
  assert.ok(m, `unrecognised sizing shape: ${declaration}`);
  return Math.max(Number(m[1]), cap * Number(m[2])) * icoScale;
}

test('icon and label are the same fraction of the cap on a small and a large deck', () => {
  for (const entry of SIZED) {
    const d = decl(entry);
    const small = sizeAt(d, EDGE_CAP) / EDGE_CAP;
    const large = sizeAt(d, DESKTOP_CAP) / DESKTOP_CAP;
    assert.equal(
      large.toFixed(4), small.toFixed(4),
      `${entry.what}: ${(small * 100).toFixed(1)}% of an ${EDGE_CAP}px cap but ` +
      `${(large * 100).toFixed(1)}% of a ${DESKTOP_CAP}px one`,
    );
  }
});

test('no glyph size carries a pixel ceiling any more', () => {
  for (const entry of SIZED) {
    const d = decl(entry);
    assert.ok(!/clamp\(/.test(d), `${entry.what} is back on a clamp(): ${d}`);
  }
});

test('the floor still protects a tiny cap', () => {
  // A 56px cap is the smallest key-size preset; well under it the floors are what
  // keep a glyph from vanishing, so they must stay.
  for (const entry of SIZED) {
    const d = decl(entry);
    const floor = Number(/max\((\d+(?:\.\d+)?)px/.exec(d)?.[1]);
    assert.ok(floor > 0, `${entry.what} lost its floor: ${d}`);
    // Well below the smallest preset the floor, not the fraction, is what is left.
    assert.equal(sizeAt(d, 20), floor, `${entry.what} shrinks away on a tiny cap`);
  }
});

test('the per-key S/M/L preset still multiplies the icon, and only the icon', () => {
  const svg = decl(SIZED.find((s) => s.what === 'built-in vector icon'));
  assert.equal(sizeAt(svg, DESKTOP_CAP, 1.35) / sizeAt(svg, DESKTOP_CAP, 1), 1.35);
  // The label is not an icon: --ico-scale must not reach it.
  assert.ok(!/ico-scale/.test(decl(SIZED.find((s) => s.what === 'cap label'))));
});

test('a full-bleed picture key still fills the cap at every size', () => {
  // This is the one that was already right, and the reason the bug looked
  // arbitrary. It must stay a percentage of the cap, never a pixel size.
  const m = /\.deck-key\.has-image \.deck-ico img \{([\s\S]*?)\}/.exec(CSS);
  assert.ok(m, 'the full-bleed image rule is gone');
  assert.match(m[1], /width: 100%;/);
  assert.match(m[1], /height: 100%;/);
});

test('the live badge and the strip it reserves grow with the cap together', () => {
  const badge = /\.deck-key-live \{[\s\S]*?font-size: ([^;]+);/.exec(CSS);
  assert.ok(badge, 'the live badge rule is gone');
  assert.match(badge[1], /max\(12px/);
  // The cap reserves room for the badge by padding; if the badge grows and the
  // padding does not, the glyph is back under the badge it was moved out from.
  const pad = /\.deck-key\.has-live:not\(\.is-slider\) \{ padding-top: ([^;]+); \}/.exec(CSS);
  assert.ok(pad, 'the reserved badge strip is gone');
  assert.match(pad[1], /max\(22px/);
  const grow = (s) => Number(/\* (\.\d+)\)/.exec(s)[1]);
  assert.ok(grow(pad[1]) > grow(badge[1]), 'the reserved strip must outgrow the text in it');
});

test('the comic cap style scales its icon bubble too', () => {
  const comic = readFileSync(join(__dirname, '..', 'styles', 'themes-comic.css'), 'utf8');
  const m = /\.deck-root\[data-capstyle="vivid"\] \.deck-key:not\(\.has-image\):not\(\.is-slider\) \.deck-ico \{([\s\S]*?)\}/.exec(comic);
  assert.ok(m, 'the comic icon bubble rule is gone');
  assert.match(m[1], /width: max\(34px, 46%\);/);
  assert.ok(!/clamp\(34px/.test(m[1]), 'the comic bubble is back on a ceiling');
});

// ── The other half of the same story ────────────────────────────────────────
// Letting the icon grow with the cap (above) is only safe if something else
// gives when the cap runs out of room. It did not. The cap is a flex column —
// icon, then title — and the title is one nowrap line that flex-shrink will
// happily hand a box shorter than that line, at which point `overflow: hidden`
// slices the text. The icon, sized in pixels, is its own min-content height and
// refuses to give up anything, so the title was the only thing that could yield
// and it yielded all of it.
//
// Reported from a Xeneon Edge at 150% browser zoom: "Fill or Fit: the key label
// is visible. Icon: the key label is not visible. I tried S, M and L for the
// label and it makes no difference." Fill and Fit escape it because their title
// is an absolutely-positioned scrim (.has-image), not a row in the column.
//
// Measured in Chromium across cap sizes 68–430px, icon presets S/M/L, label
// presets M/L and zooms 100/125/150%: before, 125 of 360 cap layouts clipped the
// title and 31 of them lost it entirely; after, none of the image or vector ones
// do.

function ruleBody(selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\}');
  const m = re.exec(CSS);
  assert.ok(m, `the rule for ${selector} is gone`);
  return m[1];
}

test('the title keeps its line: flex may not shrink it', () => {
  // The single declaration the whole fix rests on. Without it the title is a
  // shrinkable box around an unshrinkable line of text.
  assert.match(ruleBody('.deck-key .deck-label'), /flex: 0 0 auto;/);
});

test('an icon gives its room back rather than taking the title with it', () => {
  // min-height:0 is what lets the flex column reclaim the icon's room; the
  // max-height is what makes the artwork follow the box down instead of
  // overflowing it.
  for (const [box, art] of [
    ['.deck-key .deck-ico.is-img-small', '.deck-key .deck-ico.is-img-small img'],
    ['.deck-key .deck-ico.is-builtin', '.deck-key .deck-ico.is-builtin svg'],
  ]) {
    assert.match(ruleBody(box), /min-height: 0;/, `${box} cannot be shrunk`);
    assert.match(ruleBody(art), /max-height: 100%;/, `${art} does not follow its box`);
  }
});

test('the Image Fit = Icon picture is not laid out on a baseline', () => {
  // As an inline box it sits on the baseline of .deck-ico, whose font-size is
  // the ICON size — so it dragged a descent as tall as a sixth of the icon
  // along underneath it, out of the title's room, for nothing.
  assert.match(ruleBody('.deck-key .deck-ico.is-img-small'), /display: flex;/);
});

test('at icon size L the Image Fit = Icon cap really does run out of room', () => {
  // The arithmetic behind the report, so the tests above are pinned to a reason
  // and not to a diff. .deck-key is `gap: 5px; padding: 6px`, the title is one
  // line of the cap font (13.5% of the cap, ×1.24 at label size L, ×~1.2 for the
  // line box) and --ico-scale is 1.35 at icon size L. That is 87.6% of the cap
  // plus 17 fixed pixels, so it stops fitting somewhere around a 137px cap — and
  // larger caps overflowed too, on the inline descent band that this fix removed
  // and that this sum therefore no longer counts.
  const icon = decl(SIZED.find((s) => s.what === 'small image icon'));
  const capFont = decl(SIZED.find((s) => s.what === 'cap label'));
  for (const cap of [EDGE_CAP, 96, 132]) {
    const wanted = sizeAt(icon, cap, 1.35) + sizeAt(capFont, cap) * 1.24 * 1.2 + 5 + 12;
    assert.ok(
      wanted > cap,
      `a ${cap}px cap would fit icon+title in ${wanted.toFixed(1)}px — the premise of ` +
      'these tests no longer holds, so re-measure before relaxing them',
    );
  }
});
