// A tile that stops the sideways drag takes the page swipe away from the finger
// over it, and nothing on screen says why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { critiqueTileSwipe } = require('../ai-preset-critique-swipe.js');

test('what stops the sideways drag is named, with the fix', () => {
  for (const css of [
    '.list { overflow: auto; overscroll-behavior: contain; }',
    '.list { overscroll-behavior: none }',
    '.list { overscroll-behavior-x: contain; }',
    '.list { overscroll-behavior: contain auto; }',
  ]) {
    const [hit] = critiqueTileSwipe(css);
    assert.equal(hit.severity, 'fix', css);
    assert.match(hit.hint, /overscroll-behavior-y: contain/);
  }
});

test('a list that holds only its vertical scroll is fine', () => {
  for (const css of [
    '.list { overscroll-behavior-y: contain; }',
    '.list { overscroll-behavior: auto contain; }',
    '.list { overscroll-behavior: auto; }',
    '.list { overflow: auto; }',
  ]) assert.deepEqual(critiqueTileSwipe(css), [], css);
});

test('tiles are checked, full-screen Ambient scenes are not', () => {
  const source = readFileSync(new URL('../ai-preset-critique.js', import.meta.url), 'utf8');
  assert.match(source, /entry\.surface !== 'ambient'\) out\.push\(.*critiqueTileSwipe\(text\)/);
});
