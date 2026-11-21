// The size button in a tile's corner (.gs-size-cycle) was named "Ridimensiona" in
// every language: screen readers and the hover hint said Italian in an English or
// Japanese dashboard. It takes the same words as the Layout size button now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const GRID = readFileSync(new URL('../js/grid/dashboard-grid.js', import.meta.url), 'utf8');
const I18N = new URL('../js/i18n/', import.meta.url);

test('the tile size button is named in the dashboard language', () => {
  const at = GRID.indexOf("btn.className = 'gs-size-cycle'");
  assert.ok(at > 0, 'the size button is built in dashboard-grid.js');
  const build = GRID.slice(at, GRID.indexOf('btn.addEventListener', at));
  assert.match(build, /\.t\?\.\('layout_resize'\)/,'its words come from the translations');
  assert.match(build, /setAttribute\('aria-label', btn\.title\)/, 'screen readers hear the same words');
  assert.doesNotMatch(build, /Ridimensiona/, 'no fixed Italian word');
});

test('every language has the words for the size button', () => {
  const files = readdirSync(I18N).filter((f) => /^[a-z]{2}\.js$/.test(f));
  assert.equal(files.length, 11);
  for (const f of files) {
    const src = readFileSync(new URL(f, I18N), 'utf8');
    assert.match(src, /\n\s+layout_resize: '[^']+'/, `${f} names the size button`);
  }
});
