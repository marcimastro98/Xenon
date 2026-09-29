// The Deck's title bar, and the finish that was supposed to have removed it.
//
// Calendar, Player and Timer are a border and their content. The Deck carries a
// header — profile name, page readout, pencil — and on a Xeneon Edge, where the
// tile is short, that is 26px of chrome where a row of keys could be. Reported
// as looking out of place next to the other widgets.
//
// A minimal finish already existed: Personalizzazione → Base → Nessuna, which
// takes away the chassis, the shadow and the key well ("bare keys floating on
// the dashboard", says the CSS). It left the header behind — the FACEPLATE's
// header, on the one finish with no faceplate — so a profile name, a badge and a
// pencil hung in mid-air over nothing.
//
// The first fix collapsed the header to an invisible strip that came back on
// hover or on a tap. It looked right and lost the controls: that bar is the only
// way into edit mode and the only profile switcher, and on a transparent deck
// nobody found either ("the pencil and the profile switch are gone", Discord).
// The header is now drawn quietly and always: a slim ghost row, full strength
// when touched, focused or in use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// LF only, so the slices below find their ends on a CRLF (Windows) checkout too.
const CSS = readFileSync(new URL('../components/DeckPanel/DeckPanel.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const JS = readFileSync(new URL('../js/deck.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** The declarations of the first rule whose selector list contains `needle`. */
function rule(needle) {
  const at = CSS.indexOf(needle);
  assert.ok(at >= 0, `no rule for ${needle}`);
  const open = CSS.indexOf('{', at);
  return CSS.slice(open + 1, CSS.indexOf('}', open));
}

test('the page readout appears only when there is a page to go to', () => {
  // The footer already grows arrows and dots the moment a second page exists,
  // so this was a duplicate then — and "1 / 1" on a single-page deck is a badge
  // that says nothing while taking a control's worth of height.
  assert.match(JS, /if \(view\.pageCount > 1\) \{\s*\n\s*bar\.appendChild\(el\('span', 'deck-index'/);
  assert.match(JS, /if \(view\.pageCount > 1 \|\| state\.editing\) \{/,
    'the footer no longer appears on multi-page decks — the readout would be the only pager left');
});

test('the "none" finish keeps its header on screen, quietly', () => {
  const ghost = rule('.deck-root[data-plate="none"] .deck-bar {');
  // Visible at rest: the pencil and the profile switcher must never be hidden.
  assert.match(ghost, /opacity:\s*\.55/, 'a ghost, not gone');
  assert.doesNotMatch(ghost, /opacity:\s*0[;\s]/, 'the bar is invisible at rest again');
  assert.doesNotMatch(ghost, /max-height:\s*10px/, 'the bar is a collapsed strip again');
  assert.doesNotMatch(ghost, /overflow:\s*hidden/, 'the bar clips its own controls again');
  assert.doesNotMatch(ghost, /display:\s*none|visibility:\s*hidden/);
  // Slimmer than the 26px faceplate header, and readable on any wallpaper.
  assert.match(ghost, /height:\s*20px/);
  assert.match(ghost, /text-shadow:/);
});

test('the pencil and the profile switcher are never hidden by this finish', () => {
  const noneRules = [...CSS.matchAll(/\.deck-root\[data-plate="none"\][^{]*\.deck-bar[^{]*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
  assert.ok(noneRules.length > 0);
  assert.doesNotMatch(noneRules, /display:\s*none/);
  assert.doesNotMatch(noneRules, /visibility:\s*hidden/);
  assert.doesNotMatch(noneRules, /pointer-events:\s*none/);
  for (const sel of ['.deck-edit', '.deck-crumb-btn']) {
    assert.ok(!new RegExp(`\\[data-plate="none"\\][^{]*${sel.replace('.', '\\.')}[^{]*\\{[^}]*(display:\\s*none|opacity:\\s*0[;\\s])`).test(CSS),
      `${sel} is hidden under the none finish`);
  }
});

test('the cap chrome goes, but the lit "Done" pencil of edit mode stays lit', () => {
  const at = CSS.indexOf('.deck-root[data-plate="none"]:not(.is-editing) .deck-bar :is(.deck-edit, .deck-back)');
  assert.ok(at >= 0, 'the key-cap chrome around the pencil is back, or it now overrides the edit state');
  const body = CSS.slice(CSS.indexOf('{', at) + 1, CSS.indexOf('}', at));
  assert.match(body, /background:\s*none/);
  assert.match(body, /box-shadow:\s*none/);
  // The edit-mode fill is declared once, for every finish, and is not overridden.
  assert.match(CSS, /\.deck-root\.is-editing \.deck-bar \.deck-edit \{\s*\n\s*background: linear-gradient/);
});

test('it comes to full strength when it is touched, focused or in use', () => {
  const open = rule('.deck-root[data-plate="none"] .deck-bar:hover,');
  assert.match(open, /opacity:\s*1/);
  const selectors = CSS.slice(CSS.indexOf('.deck-root[data-plate="none"] .deck-bar:hover,'),
    CSS.indexOf('{', CSS.indexOf('.deck-root[data-plate="none"] .deck-bar:hover,')));
  for (const trigger of [':hover', ':focus-within', '.bar-open', '.bar-peek']) {
    assert.ok(selectors.includes(trigger), `${trigger} no longer brings the bar to full strength`);
  }
});

test('the bar is the trigger, never the whole deck', () => {
  // Brightening on any hover over the tile would flicker every time the pointer
  // crossed it.
  assert.ok(!/\.deck-root\[data-plate="none"\] \.deck-device:hover/.test(CSS),
    'hovering the whole device brightens the bar again');
});

test('the bar is at full strength while it is being used', () => {
  // Edit mode: Done lives in it. Profile menu: it is portaled to <body> and
  // would otherwise float over a bar that was still faded.
  assert.match(JS, /root\.classList\.toggle\('bar-open', !!\(state\.editing \|\| state\.profileMenu\)\);/);
});

test('a touchscreen can bring it to full strength by tapping, since it has no hover', () => {
  const at = JS.indexOf("bar.addEventListener('pointerdown'");
  assert.ok(at >= 0, 'the touch peek is gone');
  const body = JS.slice(at, JS.indexOf('});', at));
  assert.match(body, /pointerType === 'mouse'/, 'a mouse already has hover; this must not double up');
  assert.match(body, /e\.target !== bar/, 'a tap on the pencil or the profile is that control\'s, not a peek');
  assert.match(body, /setTimeout/, 'a peek that never ends is just the bar at full strength');
  // Straight on the node: going through state would re-render the keys under a
  // finger already travelling towards the pencil.
  assert.ok(!/state\.barPeek/.test(JS));
});

test('the other finishes are untouched', () => {
  // Graphite, carbon, steel and midnight all HAVE a faceplate, so they keep its
  // header exactly as it was. Only the finish that removes the chassis changes it.
  for (const plate of ['graphite', 'carbon', 'steel', 'midnight']) {
    assert.ok(!new RegExp(`\\[data-plate="${plate}"\\][^{]*\\.deck-bar`).test(CSS),
      `${plate} now restyles its header too`);
  }
});
