// The Xenon Deck window (deck-popup.html) draws the Deck with deck.js but never
// loads the key editor (deck-editor.js): editing stays on the dashboard. Its
// pencil was still shown, so a user could enter edit mode, delete keys with the
// red X, and tap "+" to add one, which did nothing (Nov 2026, a new user's
// first Deck). A page that loads deck.js without the editor hides the pencil.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the Xenon Deck window has no editor, so it shows no pencil', () => {
  const html = read('../deck-popup.html');
  assert.match(html, /<script src="js\/deck\.js"><\/script>/);
  assert.doesNotMatch(html, /<script src="js\/deck-editor\.js">/);
  assert.match(html, /\.deck-edit\s*\{\s*display:\s*none\s*!important;\s*\}/);
});
