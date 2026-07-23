// Local search settings (searchSettings) must normalize identically on both
// sides — server.js owns the persisted shape, js/settings.js rebuilds it in the
// browser, and a divergence means a save from one surface quietly rewrites what
// the other chose (the settings invariant).
//
// The separator rule is pinned here because it failed silently: a root saved as
// "C:/Progetti" passed validation and then matched nothing downstream. Every
// consumer — the disk overview's root prefix test, registerBrowsePath, the
// deletion guard — compares backslash paths, so the treemap came back empty
// with no error to explain it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = readFileSync(join(ROOT, 'server.js'), 'utf8');
const CLIENT = readFileSync(join(ROOT, 'js', 'settings.js'), 'utf8');

// Run the real source rather than asserting on its text.
function loadNormalizer(src) {
  const m = src.match(/function normalizeSearchSettings\(value\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'normalizeSearchSettings not found');
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '; return normalizeSearchSettings;')();
}

for (const [side, src] of [['server', SERVER], ['client', CLIENT]]) {
  test(`${side}: index roots normalize to backslashes`, () => {
    const N = loadNormalizer(src);
    assert.deepEqual(N({ indexRoots: ['C:/Progetti'] }).indexRoots, ['C:\\Progetti']);
    assert.deepEqual(N({ indexRoots: ['D:/'] }).indexRoots, ['D:\\']);
    assert.deepEqual(N({ indexRoots: ['E:'] }).indexRoots, ['E:\\']);
    assert.deepEqual(N({ indexRoots: ['C:/a/b/c'] }).indexRoots, ['C:\\a\\b\\c']);
    // Already-correct input is untouched.
    assert.deepEqual(N({ indexRoots: ['C:\\Progetti'] }).indexRoots, ['C:\\Progetti']);
  });

  test(`${side}: index roots reject what is not a local absolute path`, () => {
    const N = loadNormalizer(src);
    assert.deepEqual(N({ indexRoots: ['', '  ', 'Progetti', '\\\\server\\share', 'http://x/y'] }).indexRoots, []);
    // Bounded: no more than eight roots survive.
    const many = Array.from({ length: 12 }, (_, i) => 'C:\\r' + i);
    assert.equal(N({ indexRoots: many }).indexRoots.length, 8);
  });

  test(`${side}: never-set defaults to the system drive, emptied stays empty`, () => {
    const N = loadNormalizer(src);
    assert.deepEqual(N({}).indexRoots, ['C:\\']);
    assert.deepEqual(N(null).indexRoots, ['C:\\']);
    // An explicitly emptied list means the user turned the index off.
    assert.deepEqual(N({ indexRoots: [] }).indexRoots, []);
    // Migration from the retired one-shot crawl.
    assert.deepEqual(N({ extraFolders: ['C:/Vecchia'] }).indexRoots, ['C:\\Vecchia']);
  });

  test(`${side}: the hotkey combo falls back instead of passing junk through`, () => {
    const N = loadNormalizer(src);
    assert.equal(N({}).hotkeyCombo, 'alt+space');
    assert.equal(N({ hotkeyCombo: 'CTRL+Shift+K' }).hotkeyCombo, 'ctrl+shift+k');
    assert.equal(N({ hotkeyCombo: 'alt+<script>' }).hotkeyCombo, 'alt+space');
    // Both opt-ins are strict booleans, off unless literally true.
    assert.equal(N({ hotkeyEnabled: 'yes' }).hotkeyEnabled, false);
    assert.equal(N({ aiFullContext: 1 }).aiFullContext, false);
    assert.equal(N({ aiFullContext: true }).aiFullContext, true);
  });
}
