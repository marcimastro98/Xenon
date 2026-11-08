// The Xenon menu's look (components/XenonMenu): the rail and page of Settings and the Store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

const MENU = read('components/XenonMenu/XenonMenu.css');
const WIDGETS = read('components/XenonMenu/XenonMenuWidgets.css');
const GUIDE = read('components/XenonMenu/XenonMenuGuide.css');
const TOKENS = read('styles/page-tokens.css');
const SHEETS = read('styles/liquid-sheets.css');

test('the menu, Settings and the Store read the same colours, in both pages', () => {
  assert.match(TOKENS, /\.cst-overlay,\n\.settings-overlay,\n\.xm-frame \{/);
  assert.match(TOKENS, /:root\[data-appearance="light"\] \.xm-frame \{/);
  for (const page of ['index.html', 'menu.html']) {
    const html = read(page);
    const tokens = html.indexOf('styles/page-tokens.css');
    assert.ok(tokens > 0, page + ' loads the colours');
    const first = page === 'menu.html' ? 'components/XenonMenu/XenonMenu.css' : 'components/CommunityStore/CommunityStore.css';
    assert.ok(tokens < html.indexOf(first), page + ' loads them before the page that reads them');
  }
});

test('colour is left to state: what is chosen is neutral, under every skin', () => {
  assert.match(MENU, /\.xm-choice\[aria-pressed="true"\] \{ color: var\(--cst-text\); background: var\(--cst-on\); \}/);
  assert.match(MENU, /\.xm-mode:hover, \.xm-mode\[aria-pressed="true"\] \{ background: var\(--cst-on\); \}/);
  assert.doesNotMatch(MENU.slice(0, MENU.indexOf('The "Main screen" tile')), /border(-color)?: [^;]*var\(--accent\)/);
});

test('a switch that is on shows it on a light theme too', () => {
  // The light rule for "off" outweighed "on": every switch read as off.
  assert.match(MENU, /data-appearance="light"\] #xm-root \.xm-switch input:not\(:checked\) \+ \.ui-toggle-track/);
  assert.doesNotMatch(MENU, /data-appearance="light"\] #xm-root \.xm-switch \.ui-toggle-track \{/);
});

test('the menu\'s own window is solid, the panel on the dashboard is a sheet', () => {
  assert.match(MENU, /\.xm-page \.xm-frame \{[^}]*backdrop-filter: none/);
  assert.match(SHEETS, /\.ask-overlay, \.xm-scrim, /);
  assert.match(SHEETS, /\.ask-sheet, \.xm-frame, /);
});

test('a key the menu cannot record still does something', () => {
  const draw = read('js/xenon-menu.js');
  const body = draw.slice(draw.indexOf('function drawKey(r)'), draw.indexOf('const drawTuneHead'));
  assert.match(body, /else if \(r\.goes\)/);
  assert.doesNotMatch(body, /b\.disabled = true/);
});

test('the three ways of using Xenon stand apart from the list under them', () => {
  assert.match(read('js/xenon-menu.js'), /mode: 'xm-modeblock'/);
  assert.doesNotMatch(MENU, /\.xm-list:has\(/);
});

test('on a phone the X stays in the corner, it never takes a row of its own', () => {
  const phone = MENU.slice(MENU.indexOf('@media (max-width: 720px)'), MENU.indexOf('@media (pointer: coarse)'));
  assert.match(phone, /\.xm-close \{ position: absolute;/);
  assert.match(phone, /\.xm-head \{ position: relative;/);
});

test('the line a widget snaps to and the guide\'s cards do not share a class', () => {
  // They did: the cards took the line's absolute green box and covered the Widgets page.
  assert.match(GUIDE, /^\.xm-guide \{/m);
  assert.doesNotMatch(WIDGETS, /\.xm-guide\b/);
  assert.doesNotMatch(read('js/xenon-menu-map.js'), /xm-guide/);
});
