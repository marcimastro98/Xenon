// The mixer opened from a Deck key alone in the Xenon menu's window fills it,
// and an app's sound row has a readable name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('in the menu window the mixer is the page, not a card in an empty window', () => {
  const css = read('../components/SheetPage/SheetPage.css');
  const rule = /body\[data-panel="sheet"\] \.deck-mix-modal \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the sheet has a rule for the mixer');
  assert.match(rule[1], /width: 100%/);
  assert.match(rule[1], /border-radius: 0/);
  assert.match(rule[1], /box-shadow: none/);
});

test('the sound of a web view has a name a person can read', () => {
  const src = read('../js/utils.js');
  const fn = /function prettyAppName[\s\S]*?\n\}/.exec(src)[0];
  const box = {};
  vm.runInNewContext(`${fn}; this.prettyAppName = prettyAppName;`, box);
  assert.equal(box.prettyAppName('msedgewebview2'), 'Edge WebView2');
  assert.equal(box.prettyAppName('spotify'), 'Spotify');
  assert.equal(box.prettyAppName('some app'), 'Some App');
  // The mixer passes the process name: no ".exe" on the strip.
  assert.equal(box.prettyAppName('Spotify.exe'), 'Spotify');
  assert.equal(box.prettyAppName('obs64.EXE'), 'OBS Studio');
  assert.equal(box.prettyAppName('.exe'), 'App');
});
