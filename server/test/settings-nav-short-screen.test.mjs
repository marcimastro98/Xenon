// Picking a settings category on a Xeneon Edge.
//
// The settings sidebar is a scrolling list of categories with a pinned block
// under it: the support links, "Check for updates", the platform-beta card and
// the version. That split is right on a tall screen and upside down on a short
// one, because the pinned half never shrinks.
//
// Measured in the running dashboard at 2560x720 — the Edge — the pane is 549px,
// the pinned block takes 337px of it, and the 27 categories are left scrolling
// through a 206px window: four and a half rows. Reported from an Edge, where
// picking a category meant dragging a strip up and down.
//
// A 1366x768 laptop has the same squeeze and nobody had reported it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(
  new URL('../components/SettingsModal/SettingsModal.css', import.meta.url), 'utf8');

/** The body of the first @media block whose condition contains `needle`. */
function mediaBlock(needle) {
  const at = CSS.indexOf(`@media ${needle}`);
  assert.ok(at >= 0, `no @media ${needle}`);
  const from = CSS.indexOf('{', at);
  let depth = 0;
  for (let i = from; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) return CSS.slice(from + 1, i);
  }
  assert.fail('unbalanced media block');
}

test('a short pane scrolls as one column instead of pinning its footer', () => {
  const block = mediaBlock('(max-height: 820px)');
  assert.match(block, /\.settings-nav \{ overflow-y: auto; \}/,
    'the pane itself has to become the scroller');
  // flex:1 would keep the list inside its own window inside the new scroller,
  // and nothing on screen would change.
  assert.match(block, /\.settings-nav-scroll \{[\s\S]*?flex: 0 0 auto;[\s\S]*?overflow: visible;/);
});

test('the threshold covers every screen with the squeeze, not just the Edge', () => {
  // The Edge is 720 tall and reports 576 under its zoom; a 1366x768 laptop is
  // 768. A limit tuned to one of those numbers leaves the others broken.
  const m = CSS.match(/@media \(max-height: (\d+)px\) \{\s*\n\s*\.settings-nav \{ overflow-y: auto/);
  assert.ok(m, 'the short-pane rule is gone or no longer keyed on height alone');
  const limit = Number(m[1]);
  for (const h of [576, 720, 768]) {
    assert.ok(h <= limit, `${h}px-tall screens are left out at max-height:${limit}px`);
  }
  // And it must not fire on an ordinary desktop, where the pinned footer is right.
  assert.ok(limit < 900, `max-height:${limit}px would change 900px+ screens too`);
});

test('the base layout is unchanged — this is an override, not a rewrite', () => {
  assert.match(CSS, /\.settings-nav \{[\s\S]*?overflow: hidden;\s*\n\}/,
    'the tall-screen pane still clips and lets the list scroll inside it');
  assert.match(CSS, /\.settings-nav-scroll \{[\s\S]*?flex: 1 1 auto;[\s\S]*?overflow-y: auto;/);
  assert.match(CSS, /\.settings-nav-footer \{[\s\S]*?flex: 0 0 auto;/);
});

test('the phone breakpoint still has the last word', () => {
  // It makes the nav a collapsed picker and hides the footer until it is opened.
  // Cascade order is what keeps that true, so it has to stay BELOW this rule.
  const short = CSS.indexOf('@media (max-height: 820px)');
  const phone = CSS.indexOf('@media (max-width: 720px)');
  assert.ok(phone > short, 'the phone block moved above the short-screen block and lost the cascade');
  assert.match(CSS, /\.settings-nav:not\(\.is-open\) \.settings-nav-footer \{ display: none; \}/);
});
