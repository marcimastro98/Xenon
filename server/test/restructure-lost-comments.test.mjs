// The check for comments a step deleted (tools/restructure/lost-comments.mjs): a comment line
// that leaves a file must come back among the added lines, wherever they are. `verify` cannot
// see a deleted comment, and a require line taken out by the tool goes with the block above it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lostComments } from '../../tools/restructure/lost-comments.mjs';

const diff = (...lines) => lines.join('\n');

test('a header that went with the require line under it is reported', () => {
  const lost = lostComments(diff(
    '--- a/server/demo.js',
    '+++ b/server/demo.js',
    '@@ -1,4 +0,0 @@',
    '-// What this module never does: it never opens a shell.',
    '-// It never reads a key.',
    "-const os = require('os');",
    '+++ b/server/part/x.js',
    "+const os = require('node:os');",
  ));
  assert.deepEqual(lost, [
    '// What this module never does: it never opens a shell.',
    '// It never reads a key.',
  ]);
});

test('a comment that moved to another file with its code is not a loss', () => {
  const lost = lostComments(diff(
    '--- a/server/demo.js',
    '+++ b/server/demo.js',
    '-// The folder is made once per run.',
    '-function workDir() {}',
    '+++ b/server/part/x.js',
    '+// The folder is made once per run.',
    '+function workDir() {}',
  ));
  assert.deepEqual(lost, []);
});

test('another indent, or two lines joined into one, is still the same comment', () => {
  const lost = lostComments(diff(
    '-  // first half of the thought,',
    '-  // second half of it.',
    '-    // deep inside a factory',
    '+// first half of the thought, second half of it.',
    '+// deep inside a factory',
  ));
  assert.deepEqual(lost, []);
});

test('code that was removed is not the business of this check, nor is an empty comment', () => {
  const lost = lostComments(diff(
    '-const gone = 1;',
    '-//',
    '-// --',
  ));
  assert.deepEqual(lost, []);
});

test('a comment that only names a variable by its new name is the same comment', () => {
  const lost = lostComments(diff(
    '-  // No-op only when the session never armed (no _liveActive) at all.',
    '-  // This one says something else entirely and is gone for good.',
    '+  // No-op only when the session never armed (no liveVoice.active) at all.',
    '+  // A new line with as many words as the one that is gone.',
  ));
  assert.deepEqual(lost, ['  // This one says something else entirely and is gone for good.']);
});

test('a file with Windows line ends is read the same way', () => {
  const lost = lostComments('-// kept as it was\r\n+// kept as it was\r\n-// this one is gone\r\n');
  assert.deepEqual(lost, ['// this one is gone']);
});

test('the names of the files in the diff are never taken for lines', () => {
  const lost = lostComments(diff(
    '--- a/server/demo.js',
    '+++ b/server/demo.js',
    '-// a real comment that is gone',
  ));
  assert.deepEqual(lost, ['// a real comment that is gone']);
});

test('a comment that names a moved file comes back with the new path', () => {
  const diff = ['-    // wakes. See server/pulse-nag.js.', '+    // wakes. See server/pulse/pulse-nag.js.'].join('\n');
  assert.equal(lostComments(diff).length, 1, 'without the list of moves the line reads as taken out');
  assert.deepEqual(lostComments(diff, [{ from: 'server/pulse-nag.js', to: 'server/pulse/pulse-nag.js' }]), []);
});
