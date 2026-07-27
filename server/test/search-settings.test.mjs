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
  // Signature-agnostic: the function grew a `defaultRoot` parameter (the
  // never-set default differs per platform and only the server knows which),
  // and pinning the old argument list here would have failed as "not found"
  // rather than as a behaviour change.
  const m = src.match(/function normalizeSearchSettings\([^)]*\) \{[\s\S]*?\n\}/);
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

  test(`${side}: a POSIX root survives, on both sides and whatever the machine is`, () => {
    // The gap this closes: separators were rewritten unconditionally and then
    // a drive letter was required, so "/Users/me" became "\Users\me" and was
    // dropped. indexRoots could hold nothing but the Windows default, the
    // Living Index never started, and search and the disk widget were both
    // dead on macOS and Linux with no value the user could type to fix it.
    const N = loadNormalizer(src);
    assert.deepEqual(N({ indexRoots: ['/Users/me'] }).indexRoots, ['/Users/me']);
    assert.deepEqual(N({ indexRoots: ['/home/me/Progetti'] }).indexRoots, ['/home/me/Progetti']);
    // A trailing separator goes; the root itself IS its separator and stays.
    assert.deepEqual(N({ indexRoots: ['/Volumes/Backup/'] }).indexRoots, ['/Volumes/Backup']);
    assert.deepEqual(N({ indexRoots: ['/'] }).indexRoots, ['/']);
    // A backslash is a legal filename character off Windows: a path holding
    // one must arrive intact, not be read as a directory separator.
    assert.deepEqual(N({ indexRoots: ['/home/me/we\\ird'] }).indexRoots, ['/home/me/we\\ird']);
    // The tests run on one machine but both branches must hold, so the two
    // shapes are asserted side by side.
    assert.deepEqual(N({ indexRoots: ['/Users/me', 'C:/Progetti'] }).indexRoots, ['/Users/me', 'C:\\Progetti']);
    // A UNC share has two leading slashes and is not a local root.
    assert.deepEqual(N({ indexRoots: ['//server/share'] }).indexRoots, []);
  });

  test(`${side}: the never-set default is supplied by the caller`, () => {
    // Only the server knows the machine, so it passes the default in. The
    // browser copy cannot compute a home directory and must not invent one.
    const N = loadNormalizer(src);
    assert.deepEqual(N({}, '/Users/me').indexRoots, ['/Users/me']);
    assert.deepEqual(N(null, '/Users/me').indexRoots, ['/Users/me']);
    // An emptied list still means "off" — the default applies to never-set only.
    assert.deepEqual(N({ indexRoots: [] }, '/Users/me').indexRoots, []);
  });

  test(`${side}: never-set without a default names no root at all`, () => {
    const N = loadNormalizer(src);
    // This used to answer ['C:\\']. It is the one guess neither copy is allowed
    // to make: the browser cannot know the host, so on every Mac and every
    // Linux box the first settings save wrote a Windows drive letter as the
    // search root. No POSIX walk can start there, so the index stayed off while
    // Settings displayed a configured folder — a dead end with nothing the user
    // could type to escape it. Absent means absent; the caller that knows the
    // machine supplies the default (see the test above).
    assert.equal(N({}).indexRoots, undefined);
    assert.equal(N(null).indexRoots, undefined);
    // An explicitly emptied list is a different statement — the user turned the
    // index off — and must survive as one.
    assert.deepEqual(N({ indexRoots: [] }).indexRoots, []);
    // Migration from the retired one-shot crawl is a set value, not a default.
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
