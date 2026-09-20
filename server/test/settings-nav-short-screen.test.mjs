// The block under the settings categories: Supporta, Discord, Segnala bug,
// Aggiorna, and the version.
//
// It is PINNED, on every screen height. Those four actions have to be in view
// the moment Settings opens, without scrolling to the end of a 27-row list to
// find them. 4.11.8 had unpinned the block on short screens, and for a reason:
// it was five stacked rows then, and measured on a Xeneon Edge (2560x720) it
// took 337px of the pane's 549px, leaving the categories a 206px window. The
// answer now is not to unpin it but to keep it SMALL: two rows of two, about
// 100px, so the Edge keeps ~420px for the categories with the block in place.
//
// So this file pins two things: that the block stays pinned, and that it stays
// two rows - a fifth stacked row is how the 337px came back last time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(
  new URL('../components/SettingsModal/SettingsModal.css', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

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

test('the category list scrolls inside the pane and the footer is pinned under it', () => {
  assert.match(CSS, /\.settings-nav \{[\s\S]*?overflow: hidden;\s*\n\}/,
    'the pane clips; the list scrolls inside it');
  assert.match(CSS, /\.settings-nav-scroll \{[\s\S]*?flex: 1 1 auto;[\s\S]*?overflow-y: auto;/,
    'the list is the scroller');
  assert.match(CSS, /\.settings-nav-footer \{[\s\S]*?flex: 0 0 auto;/,
    'the footer keeps its own height, outside the scroller');
});

test('a short screen does not unpin the footer any more', () => {
  const block = mediaBlock('(max-height: 820px)');
  assert.doesNotMatch(block, /\.settings-nav \{ overflow-y: auto/,
    'the pane became the scroller again, which sends the footer to the end of the list');
  assert.doesNotMatch(block, /\.settings-nav-scroll \{[\s\S]*?overflow: visible/,
    'the list stopped scrolling inside the pane, which is the same unpin');
});

test('the footer is two rows of two, not a stack', () => {
  const footer = HTML.slice(
    HTML.indexOf('<div class="settings-nav-footer">'),
    HTML.indexOf('</nav>', HTML.indexOf('<div class="settings-nav-footer">')));
  const rows = footer.match(/class="settings-nav-links/g) || [];
  assert.equal(rows.length, 2, 'exactly two .settings-nav-links rows');
  // Each row holds two controls, so the block is four actions plus the version.
  const controls = footer.match(/class="settings-(nav-support-btn|update-check)/g) || [];
  assert.equal(controls.length, 4, 'four actions in the block');
  assert.doesNotMatch(footer, /settings-nav-support"/, 'the old stacked .settings-nav-support container is gone');
  assert.match(CSS, /\.settings-nav-links > \* \{ flex: 1 1 0; min-width: 0; \}/,
    'a row splits its width evenly, and a hidden control lets its neighbour widen');
});

test('the Sostieni Xenon category is reached from the footer, not a list entry', () => {
  assert.doesNotMatch(HTML, /settings-nav-btn settings-nav-btn-support/,
    'the category button was removed from the list as a duplicate of the footer');
  assert.match(HTML, /settings-nav-support-btn is-featured is-donate" data-settings-cat="support" onclick="settingsSetCategory\('support'\)"/,
    'the footer Supporta button opens the category');
});

test('the phone breakpoint still has the last word', () => {
  // It makes the nav a collapsed picker and hides the footer until it is opened.
  // Cascade order is what keeps that true, so it has to stay BELOW the short-screen rule.
  const short = CSS.indexOf('@media (max-height: 820px)');
  const phone = CSS.indexOf('@media (max-width: 720px)');
  assert.ok(phone > short, 'the phone block moved above the short-screen block and lost the cascade');
  assert.match(CSS, /\.settings-nav:not\(\.is-open\) \.settings-nav-footer \{ display: none; \}/);
});
