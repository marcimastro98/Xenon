// The browser side's saved numbers (tools/quality/browser.mjs): the names scripts put in
// the page's shared scope, the inline on*= handlers of the pages, and the names two scripts
// of one page both declare. Each may go down and never up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCounts } from '../../tools/quality/baseline-file.mjs';
import {
  CHECKS, browserProblems, duplicateNames, familyOf, inlineHandlers, isBrowserScript, measureBrowser, mixedLoads, sharedNames,
} from '../../tools/quality/browser.mjs';
import { REPO_ROOT, trackedFiles } from '../../tools/quality/repo-files.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const NO_PARSER = 'TypeScript is not installed (npm run quality:install)';

test('an inline handler is an on*= attribute of a tag of the page, not text in a comment or in a script', () => {
  const page = [
    '<button onclick="save()" onpointerdown=\'press(this)\' data-on="x">Save</button>',
    '<!-- <button onclick="old()"> -->',
    '<script>el.innerHTML = \'<a onclick="go()">\';</script>',
    '<input oninput = "typed(this.value)" online="no">',
    '<p>turn it on="now"</p>',
  ].join('\n');
  assert.equal(inlineHandlers(page), 4, 'onclick, onpointerdown, oninput and online= (an attribute that starts with on)');
  assert.equal(inlineHandlers('<p>nothing here</p>'), 0);
});

test('only our own scripts under js/ and components/ are browser scripts', () => {
  assert.equal(isBrowserScript('server/js/main.js'), true);
  assert.equal(isBrowserScript('server/components/Notes/notes-list.js'), true);
  assert.equal(isBrowserScript('server/js/vendor/qrcode.js'), false);
  assert.equal(isBrowserScript('server/vendor/gridstack/gridstack-all.js'), false);
  assert.equal(isBrowserScript('server/server.js'), false);
  assert.equal(isBrowserScript('server/js/notes.css'), false);
});

test('a file split out of a script, or taken out of a page, counts with the file it came from', () => {
  const family = familyOf({ moves: [
    { kind: 'script', from: 'server/js/big.js', file: 'server/js/big/one.js' },
    { kind: 'script', from: 'server/js/big/one.js', file: 'server/js/big/one-a.js' },
    { kind: 'inline', from: 'server/index.html', file: 'server/js/from-page.js' },
    { kind: 'style', from: 'server/components/Box/Box.css', parts: [{ file: 'server/components/Box/BoxEdit.css', at: 10 }] },
    { kind: 'module', file: 'server/js/alone.js', names: [] },
  ] });
  assert.equal(family('server/js/big/one-a.js'), 'server/js/big.js');
  assert.equal(family('server/js/big.js'), 'server/js/big.js');
  assert.equal(family('server/js/from-page.js'), 'server/index.html');
  assert.equal(family('server/js/alone.js'), 'server/js/alone.js');
});

test('a classic script leaves its top-level names in the shared scope; a wrapper or a module leaves none', async (t) => {
  if (!parserAvailable()) return t.skip(NO_PARSER);
  const parser = await openParser();
  try {
    const classic = sharedNames('function a() {}\nconst b = 1, c = 2;\nlet d;\nclass E {}\nif (window.x) { var leaked = 1; }\nwindow.f = 3;\n', parser);
    assert.deepEqual(classic, { module: false, names: ['a', 'b', 'c', 'd', 'E', 'leaked'] });
    assert.deepEqual(sharedNames('(function () { function inside() {} window.Tool = { inside }; })();\n', parser), { module: false, names: [] });
    assert.deepEqual(sharedNames('import { a } from "./a.js";\nfunction b() { return a; }\nexport { b };\n', parser), { module: true, names: [] });
    assert.deepEqual(sharedNames('export function b() {}\n', parser), { module: true, names: [] });
    assert.deepEqual(sharedNames('function b() {}\nexport {};\n', parser), { module: true, names: [] });
  } finally {
    parser.close();
  }
});

test('a page must load a module as a module and a classic script as a classic script, and a built list holds no module', () => {
  const read = (file) => ({ 'server/js/leaf.js': { module: true }, 'server/js/old.js': { module: false } })[file] ?? null;
  const right = '<script src="js/old.js"></script>\n<script type="module" src="js/leaf.js?v=1"></script>\n<script src="js/vendor/lib.js"></script>\n';
  assert.deepEqual(mixedLoads('server/index.html', right, read), []);
  const wrong = '<script type="module" src="js/old.js"></script>\n<script src="js/leaf.js"></script>\n';
  assert.deepEqual(mixedLoads('server/index.html', wrong, read, ['server/js/leaf.js', 'server/js/old.js']), [
    'server/index.html loads server/js/old.js as a module, and the file does not say it is one',
    'server/index.html loads server/js/leaf.js as a classic script, and the file says it is a module',
    'server/js/layer-tiles.js holds server/js/leaf.js, a module, in a list written out as classic tags',
  ]);
  const saved = { scripts: {}, handlers: {}, duplicates: {} };
  assert.deepEqual(browserProblems({ ...saved, where: {}, mixed: ['a page loads x the wrong way'] }, saved), ['modules: a page loads x the wrong way'], 'never allowed, whatever is saved');
});

test('a name is a duplicate when two different scripts of the page declare it', () => {
  const found = duplicateNames([
    { file: 'js/first.js', names: ['cssId', 'renderNotes'] },
    { file: 'js/second.js', names: ['cssId', 'tick', 'tick'] },
    { file: 'js/clock.js', names: ['now'] },
  ]);
  assert.deepEqual(found, { cssId: ['js/first.js', 'js/second.js'] });
});

test('more names, a new script with names, a new handler or a new duplicate is a problem; fewer of any is not', () => {
  const saved = { scripts: { 'js/old.js': 5 }, handlers: { 'index.html': 10 }, duplicates: { cssId: 2 } };
  const same = { scripts: { 'js/old.js': 5 }, handlers: { 'index.html': 10 }, duplicates: { cssId: 2 }, where: { cssId: ['js/first.js', 'js/second.js'] } };
  assert.deepEqual(browserProblems(same, saved), []);
  assert.deepEqual(browserProblems({ scripts: {}, handlers: { 'index.html': 3 }, duplicates: {}, where: {} }, saved), []);
  const worse = browserProblems({ scripts: { 'js/old.js': 6, 'js/new.js': 1 }, handlers: { 'index.html': 11, 'menu.html': 1 },
    duplicates: { cssId: 3, esc: 2 }, where: { cssId: ['a.js', 'b.js', 'c.js'], esc: ['a.js', 'b.js'] } }, saved);
  assert.equal(worse.length, 6);
  assert.match(worse.join('\n'), /scripts: js\/new\.js: 1, new\. No new top-level names/);
  assert.match(worse.join('\n'), /scripts: js\/old\.js: 6, was 5/);
  assert.match(worse.join('\n'), /handlers: menu\.html: 1, new\. Use addEventListener/);
  assert.match(worse.join('\n'), /duplicates: esc \(a\.js \+ b\.js\): 2, new/);
});

test('the saved lists are the three files under tools/quality/baseline, and the one known duplicate is on its list', () => {
  for (const check of Object.values(CHECKS)) {
    const saved = JSON.parse(readFileSync(check.file, 'utf8'));
    assert.equal(saved.note, check.note);
    assert.equal(saved.total, Object.values(saved.counts).reduce((total, count) => total + count, 0));
  }
  // Known on 13 Nov 2026: cssId, in notes.js and timer.js. The list only loses names.
  assert.deepEqual(Object.keys(readCounts(CHECKS.duplicates.file)).filter((name) => name !== 'cssId'), []);
});

test('a small tree is measured whole: tags, a split, a module, a wrapper, a script built into the widgets page', async (t) => {
  if (!parserAvailable()) return t.skip(NO_PARSER);
  const root = mkdtempSync(path.join(os.tmpdir(), 'xenon-quality-browser-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    'server/index.html': ['<button onclick="go()">Go</button>', '<script src="js/big/part.js"></script>', '<script src="js/big.js"></script>', '<script src="js/other.js?v=1"></script>',
      '<script src="js/wrapped.js"></script>', '<script type="module" src="js/leaf.js"></script>', '<script src="js/vendor/lib.js"></script>', ''].join('\n'),
    'server/layer-lite.html': '<script src="js/other.js"></script>\n',
    'server/js/layer-tiles.js': "module.exports = { TILES: { clock: { css: [], js: ['js/tile.js'] } }, LITE: ['clock'] };\n",
    'server/js/big.js': 'function go() {}\nfunction esc() {}\n',
    'server/js/big/part.js': 'const LIMIT = 3;\n',
    'server/js/other.js': 'function esc() {}\n',
    'server/js/tile.js': 'var esc = 1;\n',
    'server/js/wrapped.js': '(function () { function esc() {} window.Wrapped = { esc }; })();\n',
    'server/js/leaf.js': 'export function esc() {}\n',
    'server/js/vendor/lib.js': 'function esc() {}\n',
    'tools/restructure/extracted-browser.json': JSON.stringify({ moves: [{ kind: 'script', from: 'server/js/big.js', file: 'server/js/big/part.js', names: ['LIMIT'] }] }),
  };
  for (const [file, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); }
  const now = await measureBrowser(root, Object.keys(files));
  assert.deepEqual(now.scripts, { 'server/js/big.js': 3, 'server/js/other.js': 1, 'server/js/tile.js': 1 });
  assert.deepEqual(now.handlers, { 'server/index.html': 1 });
  assert.deepEqual(now.where, { esc: ['server/js/big.js', 'server/js/other.js', 'server/js/tile.js'] });
  assert.deepEqual(now.duplicates, { esc: 3 });
  assert.deepEqual(now.modules, ['server/js/leaf.js']);
  assert.deepEqual(now.mixed, []);
  assert.equal(now.counted, 7);
});

test('the pages have no new inline handler', (t) => {
  const files = trackedFiles();
  if (!files) return t.skip('no git in this copy of the tree');
  const saved = readCounts(CHECKS.handlers.file);
  for (const page of files.filter((file) => /^server\/[^/]+\.html$/.test(file))) {
    const now = inlineHandlers(readFileSync(new URL(`../../${page}`, import.meta.url), 'utf8'));
    assert.ok(now <= (saved[page] ?? 0), `${page}: ${now} inline handlers, ${saved[page] ?? 0} saved. ${CHECKS.handlers.fix}`);
  }
});

test('no script put a new name in the shared scope, and no two scripts of a page declare the same new name', async (t) => {
  if (!parserAvailable()) return t.skip(NO_PARSER);
  if (!trackedFiles()) return t.skip('no git in this copy of the tree');
  const now = await measureBrowser(REPO_ROOT);
  assert.deepEqual(browserProblems(now), [], 'fix it, or after a clean-up run: npm run browser -- --update');
  assert.ok(now.classic.length > 0 && now.classic.length <= now.counted);
});
