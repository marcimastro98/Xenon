// The dashboard side of xenon-mcp (js/mcp-dev-client.js).
// The pairing dialog must be the top layer: a coding assistant is waiting on
// the tap, and on a fresh install the first-run screen question (z 4100) used to
// cover it, so Allow could not be pressed until that was answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function zIndexOf(css, selector) {
  const at = css.indexOf(selector + ' {');
  assert.ok(at >= 0, `${selector} not found`);
  const m = /z-index:\s*(\d+)/.exec(css.slice(at, css.indexOf('}', at)));
  assert.ok(m, `${selector} has no z-index`);
  return Number(m[1]);
}

test('the pairing dialog sits above the first-run, tour and update overlays', () => {
  const pair = zIndexOf(read('../components/CustomWidget/CustomWidget.css'), '.cw-perm-backdrop.cw-perm-backdrop--pair');
  const others = [
    zIndexOf(read('../components/SurfacePicker/SurfacePicker.css'), '.sp-overlay'),
    zIndexOf(read('../components/Onboarding/Onboarding.css'), '.onb-overlay'),
    zIndexOf(read('../components/UpdateModal/UpdateModal.css'), '.upd-overlay'),
  ];
  for (const z of others) assert.ok(pair > z, `pair ${pair} must be above ${z}`);
});

test('the dashboard builds the pairing dialog with that class', () => {
  assert.match(read('../js/mcp-dev-client.js'), /el\('div', 'cw-perm-backdrop cw-perm-backdrop--pair'\)/);
});

// Found on the real run: on a full page the widget lands on a new page the
// person is not looking at, so they never saw it and the tools reported it off
// screen. The dashboard that placed it now goes to that page.
test('after placing, the dashboard shows the page the widget sits on', () => {
  const client = read('../js/mcp-dev-client.js');
  const place = client.slice(client.indexOf('async function place('), client.indexOf('function issues('));
  assert.ok(place.indexOf('placeCreated') < place.indexOf('devShow'), 'shows it after placing it');
  assert.match(place, /CW\.devShow\(String\(q\.id\), typeof placed === 'string' \? placed : null\)/);
  const cw = read('../js/custom-widget.js');
  assert.match(cw, /function devShow\(pkgId, instId\)/);
  assert.match(cw, /devLookup, devShow,/);
  assert.match(cw.slice(cw.indexOf('function devShow(')), /goToPageOf\(tile\)/);
});

test('a pairing dialog closes itself when the server forgets the pairing', () => {
  const client = read('../js/mcp-dev-client.js');
  assert.match(client, /expiry\.set\(p\.id, setTimeout\(\(\) => closePair\(p\.id\), left\)\)/);
  assert.match(client, /clearTimeout\(expiry\.get\(id\)\)/);
});

// Found on the real run: errors from code the author had already replaced still
// came back from widget_issues, so the assistant would chase fixed bugs. A
// reload of the files (install, Rescan, the tile's Reload) starts both lists over.
test('reloading widget files clears what the old code reported', () => {
  const cw = read('../js/custom-widget.js');
  const bump = cw.slice(cw.indexOf('function bumpAssets()'), cw.indexOf('async function fetchPackages('));
  assert.match(bump, /assetVersion\+\+;/);
  assert.match(bump, /blockedByPkg\.clear\(\);/);
  assert.match(bump, /errorsByPkg\.clear\(\);/);
  assert.match(cw, /if \(force\) bumpAssets\(\);/);
  assert.equal((cw.match(/assetVersion\+\+/g) || []).length, 1, 'every bump goes through bumpAssets');
});
