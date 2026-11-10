// GitHub #149: a Browser tile used for one page on its own (a local web
// interface, a Home Assistant dashboard) hides its toolbar, and still needs
// to reload that page and to go full screen. With the toolbar hidden the tile
// used to offer one button only, "Show toolbar".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const JS = read('../js/browser-tile.js');
const CSS = read('../components/BrowserPanel/BrowserPanel.css');

test('with the toolbar hidden, Reload, Full screen and Show toolbar stay', () => {
  const at = JS.indexOf("const floatReload = mkBtn('browser-float-reload'");
  assert.ok(at > 0, 'a reload button in the floating group');
  const block = JS.slice(at, JS.indexOf('stage.append(loading, float);', at));
  assert.match(block, /relaySend\(\{ type: 'reload', tile: tb\.tileId \}\)/, 'the same reload the toolbar sends');
  assert.match(block, /mkBtn\('browser-float-expand', ICONS\.expand, 'browser_expand', 'Expand', \(\) => toggleExpand\(group\)\)/);
  assert.match(block, /mkBtn\('browser-reveal', ICONS\.showBar, 'browser_show_ui', 'Show toolbar'/);
  assert.match(block, /float\.append\(floatReload, floatExpand, reveal\)/);
  // Back, Forward and the address are not in it: a page shown on its own
  // should not wander off by a stray tap.
  assert.doesNotMatch(block, /history|browser-url/);
});

test('the group shows exactly while the toolbar is hidden', () => {
  assert.match(JS, /if \(group\.floatBar\) group\.floatBar\.hidden = !group\.chromeHidden;/);
  assert.match(JS, /group\.chromeHidden = !!cfg\.chromeHidden;/, 'remembered per tile, as before');
});

test('both full-screen buttons follow the same state', () => {
  const fn = JS.slice(JS.indexOf('function setExpandIcon('), JS.indexOf('function expand('));
  assert.match(fn, /\[group\.expandBtn, group\.floatExpandBtn\]/);
  assert.match(JS, /setExpandIcon\(group, true\);/);
  assert.match(JS, /setExpandIcon\(group, false\);/);
});

test('the group is quiet over the page and clear under a pointer or the keyboard', () => {
  assert.match(CSS, /\.browser-float \{[^}]*opacity: 0\.55;/);
  assert.match(CSS, /\.browser-float:hover,\s*\n\.browser-float:focus-within \{ opacity: 1;/);
  assert.match(CSS, /\.browser-float\[hidden\] \{ display: none; \}/);
});
