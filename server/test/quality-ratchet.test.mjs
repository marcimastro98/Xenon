// The "only gets better" rule and the three checks built on it: file length, types and lint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { countLintFindings } from '../../tools/quality/lint.mjs';
import { compareCounts, nextBaseline } from '../../tools/quality/ratchet.mjs';
import { REPO_ROOT, trackedFiles } from '../../tools/quality/repo-files.mjs';
import { LIMIT, countLines, isCounted, measure, readBaseline } from '../../tools/quality/sizes.mjs';
import { countTypeErrors } from '../../tools/quality/typecheck.mjs';

test('a number may go down and never up', () => {
  const { worse, better } = compareCounts({ a: 5, b: 2, gone: 4 }, { a: 6, b: 1, fresh: 1 });
  assert.deepEqual(worse, [{ key: 'a', was: 5, now: 6 }, { key: 'fresh', was: 0, now: 1 }]);
  assert.deepEqual(better, [{ key: 'b', was: 2, now: 1 }, { key: 'gone', was: 4, now: 0 }]);
});

test('a new key is fine up to the allowance, and equal numbers are silent', () => {
  const { worse, better } = compareCounts({ old: 900 }, { old: 900, small: 300, big: 301 }, 300);
  assert.deepEqual(worse, [{ key: 'big', was: 0, now: 301 }]);
  assert.deepEqual(better, []);
});

test('the saved list keeps only what is still over, in a stable order', () => {
  assert.deepEqual(Object.keys(nextBaseline({ z: 400, a: 301, fits: 300 }, 300)), ['a', 'z']);
});

test('lines are counted the way an editor shows them', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('one'), 1);
  assert.equal(countLines('one\n'), 1);
  assert.equal(countLines('one\ntwo'), 2);
  assert.equal(countLines('one\r\ntwo\r\n'), 2);
});

test('code is counted, tests and other people\'s code are not', () => {
  assert.equal(isCounted('server/server.js'), true);
  assert.equal(isCounted('server/components/Toast/Toast.css'), true);
  assert.equal(isCounted('apps/native/src-tauri/src/lib.rs'), true);
  assert.equal(isCounted('server/test/deck.test.mjs'), false);
  assert.equal(isCounted('server/vendor/gridstack/gridstack-all.js'), false);
  assert.equal(isCounted('server/js/vendor/qrcode.js'), false);
  assert.equal(isCounted('docs/index.html'), false);
  assert.equal(isCounted('server/whatsnew.json'), false);
});

test('a language\'s table of words is data: not counted, and nothing else rides on that', () => {
  assert.equal(isCounted('server/js/i18n/en.js'), false);
  assert.equal(isCounted('server/js/i18n/ja.js'), false);
  // The code around the words is counted like any other file.
  assert.equal(isCounted('server/js/i18n.js'), true);
  assert.equal(isCounted('server/js/i18n-load.js'), true);
  assert.equal(isCounted('server/app-strings/tables.js'), true);
  assert.equal(isCounted('server/js/i18n/loader.js'), true);
  assert.equal(isCounted('server/js/i18n/en/extra.js'), true);
  assert.equal(isCounted('server/js/other/en.js'), true);
});

test('compiler lines become one number per file and error code', () => {
  const cwd = path.join(REPO_ROOT, 'tools', 'quality');
  const text = [
    "../../server/a.js(3,1): error TS2339: Property 'x' does not exist on type '{}'.",
    "../../server/a.js(9,4): error TS2339: Property 'y' does not exist on type '{}'.",
    '  a continuation line the compiler prints under an error',
    '../../server/dir/b.js(1,1): error TS2304: Cannot find name \'q\'.',
  ].join('\n');
  assert.deepEqual(countTypeErrors(text, cwd, REPO_ROOT), { 'server/a.js TS2339': 2, 'server/dir/b.js TS2304': 1 });
});

test('no code file grew past its saved length, and no new one is over the limit', (t) => {
  const files = trackedFiles();
  if (!files) return t.skip('no git in this copy of the tree');
  const { worse } = compareCounts(readBaseline(), measure(files), LIMIT);
  const lines = worse.map((row) => `${row.key}: ${row.now} lines (${row.was === 0 ? `new, limit ${LIMIT}` : `was ${row.was}`})`);
  assert.deepEqual(lines, [], 'split by responsibility, then run: npm run sizes -- --update');
});

test('lint findings become one number per file and rule, hints left out', () => {
  const at = (file) => ({ path: file.split('/').join(path.sep) });
  const report = { diagnostics: [
    { severity: 'warning', category: 'lint/style/useConst', location: at('server/a.js') },
    { severity: 'error', category: 'lint/style/useConst', location: at('server/a.js') },
    { severity: 'info', category: 'lint/style/useTemplate', location: at('server/a.js') },
    { severity: 'error', category: 'lint/suspicious/noDuplicateObjectKeys', location: at('server/dir/b.js') },
  ] };
  assert.deepEqual(countLintFindings(report), { 'server/a.js style/useConst': 2, 'server/dir/b.js suspicious/noDuplicateObjectKeys': 1 });
  assert.deepEqual(countLintFindings({}), {});
});

test('the code has no new lint findings', (t) => {
  const tool = path.join(REPO_ROOT, 'tools', 'quality');
  if (!existsSync(path.join(tool, 'node_modules', '@biomejs', 'biome'))) {
    return t.skip('Biome is not installed (npm run quality:install)');
  }
  const run = spawnSync(process.execPath, [path.join(tool, 'lint.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

test('the engine code has no new type errors', (t) => {
  const tool = path.join(REPO_ROOT, 'tools', 'quality');
  if (!existsSync(path.join(tool, 'node_modules', 'typescript'))) {
    return t.skip('TypeScript is not installed (npm run quality:install)');
  }
  const run = spawnSync(process.execPath, [path.join(tool, 'typecheck.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});
