// The search that says who names a browser script (tools/restructure/browser-consumers.mjs, `grepFor`):
// a search git could not finish is asked once more, and after that it fails with the reason. It must never
// read as "nobody names the script": a move would then leave a page or a test pointing at the old place.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { grepFor } from '../../tools/restructure/browser-consumers.mjs';

// git as a test wants it: each start gives the next answer of the list, and the starts are counted.
function gitThatSays(...answers) {
  const starts = [];
  const run = (command, argv, options) => { starts.push({ command, argv, options }); return answers[Math.min(starts.length, answers.length) - 1]; };
  return { run, starts };
}
const FOUND = { status: 0, stdout: 'server/index.html\0server/js/leaf.js\0', stderr: '' };
const NOTHING = { status: 1, stdout: '', stderr: '' };
const LOCKED = { status: 128, stdout: '', stderr: "fatal: Unable to create 'index.lock': File exists.\n" };
const KILLED = { status: null, signal: 'SIGTERM', stdout: '', stderr: '' };

test('found and nothing found are answers: git is started once', () => {
  const found = gitThatSays(FOUND);
  assert.deepEqual(grepFor('/repo', ['leaf.js'], found.run), ['server/index.html', 'server/js/leaf.js']);
  assert.equal(found.starts.length, 1);
  assert.equal(found.starts[0].command, 'git');
  assert.deepEqual(found.starts[0].argv.slice(-2), ['-e', 'leaf.js']);
  assert.equal(found.starts[0].options.cwd, '/repo');
  const nothing = gitThatSays(NOTHING);
  assert.deepEqual(grepFor('/repo', ['leaf.js'], nothing.run), []);
  assert.equal(nothing.starts.length, 1);
});

test('a search git could not finish is asked once more, with the same words', () => {
  const git = gitThatSays(KILLED, FOUND);
  assert.deepEqual(grepFor('/repo', ['leaf.js', 'twig.js'], git.run), ['server/index.html', 'server/js/leaf.js']);
  assert.equal(git.starts.length, 2);
  assert.deepEqual(git.starts[1].argv, git.starts[0].argv);
  // The second answer may be "nothing found" too: that is an answer.
  assert.deepEqual(grepFor('/repo', ['leaf.js'], gitThatSays(LOCKED, NOTHING).run), []);
});

test('failed twice, it stops with the reason, whatever kind it is', () => {
  const locked = gitThatSays(LOCKED);
  assert.throws(() => grepFor('/repo', ['leaf.js'], locked.run), /git grep failed twice in \/repo \(exit 128: fatal: Unable to create 'index\.lock': File exists\.\)/);
  assert.equal(locked.starts.length, 2, 'twice, not more');
  assert.throws(() => grepFor('/repo', ['leaf.js'], gitThatSays(KILLED).run), /git grep failed twice in \/repo \(stopped by SIGTERM\)/);
  assert.throws(() => grepFor('/repo', ['leaf.js'], gitThatSays({ status: 2, stdout: '', stderr: '' }).run), /\(exit 2, and git said nothing\)/);
  const missing = { status: null, signal: null, error: new Error('spawnSync git ENOENT'), stdout: '', stderr: '' };
  assert.throws(() => grepFor('/repo', ['leaf.js'], gitThatSays(missing).run), /\(spawnSync git ENOENT\)/);
});
