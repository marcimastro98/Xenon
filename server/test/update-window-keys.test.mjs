// The keys of the update window: the main one closes the row, as on every window of the app, and
// on a phone the two keys stay side by side instead of falling apart one under the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const JS = read('../js/update.js');
const CSS = read('../components/UpdateModal/UpdateModal.css');

test('Skip comes first and the main key last', () => {
  const skip = JS.indexOf('actions.appendChild(skipBtn)');
  const later = JS.indexOf('actions.appendChild(laterBtn)');
  const main = JS.indexOf("dlBtn.className = 'upd-btn primary'");
  assert.ok(skip > 0 && skip < later && later < main);
});

test('on a phone the quiet word has its own row and the keys share the next', () => {
  const phone = CSS.slice(CSS.indexOf('@media (max-width: 480px)'));
  assert.match(phone, /\.upd-btn\.ghost:has\(\+ \.upd-btn:not\(\.ghost\)\) \{ flex: 1 0 100%;/);
  assert.match(phone, /\.upd-actions > \.upd-btn:not\(\.ghost\) \{ flex: 1 1 0; \}/);
});
