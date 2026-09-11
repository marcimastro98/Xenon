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
// pencil hung in mid-air over nothing. The option was not missing; it was
// half-finished.
//
// Removing it outright is not an option either: that bar is the only way into
// edit mode and the only profile switcher. It collapses to a strip instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../components/DeckPanel/DeckPanel.css', import.meta.url), 'utf8');
const JS = readFileSync(new URL('../js/deck.js', import.meta.url), 'utf8');

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

test('the "none" finish collapses its header instead of leaving it floating', () => {
  const collapsed = rule('.deck-root[data-plate="none"] .deck-bar {');
  assert.match(collapsed, /max-height:\s*10px/);
  assert.match(collapsed, /overflow:\s*hidden/);
  assert.match(collapsed, /opacity:\s*0/);
  // min-height:22px on the base rule would otherwise hold the bar open.
  assert.match(collapsed, /min-height:\s*0/);
});

test('it is a strip, not a removal — every way back in is still there', () => {
  const open = rule('.deck-root[data-plate="none"] .deck-bar:hover,');
  assert.match(open, /max-height:\s*64px/);
  assert.match(open, /opacity:\s*1/);
  const selectors = CSS.slice(CSS.indexOf('.deck-root[data-plate="none"] .deck-bar:hover,'),
    CSS.indexOf('{', CSS.indexOf('.deck-root[data-plate="none"] .deck-bar:hover,')));
  for (const trigger of [':hover', ':focus-within', '.bar-open', '.bar-peek']) {
    assert.ok(selectors.includes(trigger), `${trigger} no longer reveals the bar`);
  }
});

test('the strip is the trigger, never the whole deck', () => {
  // Revealing on any hover over the tile would slide the keys down every time
  // the pointer crossed it.
  assert.ok(!/\.deck-root\[data-plate="none"\] \.deck-device:hover/.test(CSS),
    'hovering the whole device reveals the bar again');
});

test('the bar comes back while it is being used', () => {
  // Edit mode: Done lives in it. Profile menu: it is portaled to <body> and
  // would otherwise float over a bar that collapsed underneath it.
  assert.match(JS, /root\.classList\.toggle\('bar-open', !!\(state\.editing \|\| state\.profileMenu\)\);/);
});

test('a touchscreen gets the bar by tapping, since it has no hover', () => {
  const at = JS.indexOf("bar.addEventListener('pointerdown'");
  assert.ok(at >= 0, 'the touch peek is gone — the Edge is a touchscreen with no way in');
  const body = JS.slice(at, JS.indexOf('});', at));
  assert.match(body, /pointerType === 'mouse'/, 'a mouse already has hover; this must not double up');
  assert.match(body, /e\.target !== bar/, 'a tap on the pencil or the profile is that control\'s, not a peek');
  assert.match(body, /setTimeout/, 'a peek that never ends is just the bar again');
  // Straight on the node: going through state would re-render the keys under a
  // finger already travelling towards the pencil.
  assert.ok(!/state\.barPeek/.test(JS));
});

test('the other finishes are untouched', () => {
  // Graphite, carbon, steel and midnight all HAVE a faceplate, so they keep its
  // header. Only the finish that removes the chassis removes the header.
  for (const plate of ['graphite', 'carbon', 'steel', 'midnight']) {
    assert.ok(!new RegExp(`\\[data-plate="${plate}"\\][^{]*\\.deck-bar`).test(CSS),
      `${plate} now hides its header too`);
  }
});
