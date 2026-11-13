// A classic script becomes an ES module (tools/restructure/browser-module.mjs) only
// where nothing can tell the difference: it already ran last, nothing else loads
// it, no other file has its names, and its code means the same in a module.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PAGES } from '../../tools/restructure/browser-check-pages.mjs';
import { replay } from '../../tools/restructure/browser-extract.mjs';
import { MODULE_LINE, codeProblems, moduleReasons, moduleStateProblems, placeProblems } from '../../tools/restructure/browser-module.mjs';
import { applyMove } from '../../tools/restructure/browser-moves.mjs';
import { compareRecordings } from '../../tools/restructure/browser-page-check.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const LEAF = "'use strict';\n(function () {\n  const tile = document.querySelector('.tile');\n  if (tile) tile.hidden = false;\n})();\n";
const page = (...tail) => ['<!doctype html>', '<body>', '<div class="tile"></div>', '<script src="js/first.js"></script>', ...tail, '</body>', '</html>', ''].join('\n');
const LAST = page('<script src="js/leaf.js"></script>');
const treeOf = (files) => ({ get: (file) => files[file] ?? null });
const refusal = (run) => { try { run(); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; } return ''; };

test('a script may become a module only where it already ran last, with the whole page above it', () => {
  const where = (html, converted) => placeProblems(html, 'server/js/leaf.js', 'server/a.html', converted).join('\n');
  assert.equal(where(LAST), '');
  assert.equal(where(page('<script src="js/other.js"></script>')), '', 'a page that does not load it has nothing to say');
  assert.match(where(page('<script src="js/leaf.js"></script>', '<script src="js/after.js"></script>')), /loads js\/after\.js after it as a classic script/);
  assert.equal(where(page('<script src="js/leaf.js"></script>', '<script type="module" src="js/after.js"></script>')), '', 'a module after it runs after it either way');
  assert.equal(where(page('<script src="js/leaf.js"></script>', '<!-- <script src="js/old.js"></script> -->')), '', 'a tag in a comment is not a tag');
  assert.match(where(page('<script src="js/leaf.js"></script>', '<script>', 'start();', '</script>')), /goes on after its tag/);
  assert.match(where(page('<script src="js/leaf.js"></script>', '<p>late</p>')), /goes on after its tag: a module runs once the whole page is read/);
  assert.match(where(page('<script src="js/leaf.js"></script>', '<script src="js/leaf.js"></script>')), /loads it 2 times/);
  assert.match(where(page('<script src="js/leaf.js" id="boot"></script>')), /loads it with <script src="js\/leaf\.js" id="boot"><\/script>, not with <script src="js\/leaf\.js"><\/script>/);
  assert.match(where(['<script src="js/early.js" defer></script>', LAST].join('\n')), /loads js\/early\.js with defer before it/);
  assert.match(where(LAST, true), /not with <script type="module" src="js\/leaf\.js"><\/script>/, 'once converted, the tag must say so');
  assert.equal(where(page('<script type="module" src="js/leaf.js"></script>'), true), '');
});

test('code that would run differently as a module keeps its script classic', (t) => {
  if (!parser) return t.skip(SKIP);
  const said = (text) => codeProblems(text, 'server/js/leaf.js', parser).problems.join('\n');
  assert.equal(said(LEAF), '');
  assert.match(said(LEAF.replace("'use strict';\n", '')), /does not start with 'use strict'/);
  assert.match(said(`${LEAF}const me = document.currentScript;\n`), /uses document\.currentScript: it is null in a module/);
  assert.match(said(`${LEAF}if (document.readyState === 'loading') wait();\n`), /uses the page's readyState: a module never sees the page still loading/);
  assert.match(said(`${LEAF}const { readyState } = document;\n`), /uses the page's readyState/, 'taken out of the document, it is still the page\'s');
  assert.match(said(`${LEAF}if (document['readyState'] !== 'complete') wait();\n`), /uses the page's readyState/);
  assert.equal(said(`${LEAF}const es = new EventSource('/sse');\nes.onerror = () => { if (es.readyState === EventSource.CLOSED) again(); };\n`), '', 'a stream has a readyState of its own');
  assert.equal(said(`${LEAF}// document.readyState is not asked here\n`), '', 'a word in a comment is not a use');
  assert.match(said(`${LEAF}window.root = this;\n`), /reads `this` outside any function/);
  assert.match(said(`${LEAF}(() => this.start)();\n`), /reads `this` outside any function/, 'an arrow function has no this of its own');
  assert.equal(said(`${LEAF}function inside() { return this; }\nconst held = { get me() { return this; } };\n`), '');
  assert.match(said(LEAF.trimEnd()), /does not end with a line break/);
  assert.match(said(`${LEAF}${MODULE_LINE}`), /is a module already/);
  assert.deepEqual(codeProblems(`${LEAF}function show() {}\nconst LIMIT = 3, STEP = 1;\n`, 'server/js/leaf.js', parser).names, ['show', 'LIMIT', 'STEP']);
});

test('the conversion is the tag of every page that loads the script and one last line, and nothing else', (t) => {
  if (!parser) return t.skip(SKIP);
  const files = { 'server/a.html': LAST, 'server/b.html': LAST.replace('js/leaf.js', '/js/leaf.js'), 'server/c.html': page(), 'server/js/leaf.js': `${LEAF}function show() {}\n` };
  const pages = ['server/a.html', 'server/b.html', 'server/c.html', 'server/gone.html'];
  const done = applyMove(treeOf(files), { kind: 'module', file: 'server/js/leaf.js' }, { parser, pages, earlier: [] });
  assert.deepEqual([...done.files.keys()].sort(), ['server/a.html', 'server/b.html', 'server/js/leaf.js']);
  assert.equal(done.files.get('server/a.html'), LAST.replace('<script src="js/leaf.js">', '<script type="module" src="js/leaf.js">'));
  assert.ok(done.files.get('server/b.html').includes('<script type="module" src="/js/leaf.js"></script>'), 'the address stays as the page wrote it');
  assert.equal(done.files.get('server/js/leaf.js'), `${LEAF}function show() {}\nexport {};\n`);
  assert.deepEqual(done.made, []);
  assert.deepEqual(done.record, { kind: 'module', file: 'server/js/leaf.js', names: ['show'] });
  const after = { ...files, ...Object.fromEntries(done.files) };
  assert.match(refusal(() => applyMove(treeOf(after), { kind: 'module', file: 'server/js/leaf.js' }, { parser, pages, earlier: [done.record] })), /is a module already/);
  const followed = { ...files, 'server/b.html': page('<script src="js/leaf.js"></script>', '<script src="js/after.js"></script>') };
  assert.match(refusal(() => applyMove(treeOf(followed), { kind: 'module', file: 'server/js/leaf.js' }, { parser, pages, earlier: [] })), /server\/b\.html loads js\/after\.js after it/,
    'one page where it does not run last is enough to refuse');
  assert.match(refusal(() => applyMove(treeOf({ 'server/js/leaf.js': LEAF }), { kind: 'module', file: 'server/js/leaf.js' }, { parser, pages, earlier: [] })), /no page loads server\/js\/leaf\.js with a tag/);
  assert.match(refusal(() => applyMove(treeOf(after), { kind: 'script', from: 'server/js/leaf.js', file: 'server/js/leaf/show.js', about: 'Shows.', names: ['show'] },
    { parser, pages, earlier: [done.record] })), /server\/js\/leaf\.js is a module: its names are its own/);
});

test('a converted script must keep saying it is a module, and every page must load it as one, last', (t) => {
  if (!parser) return t.skip(SKIP);
  const module = `${LEAF}${MODULE_LINE}`;
  const good = [{ page: 'server/a.html', html: page('<script type="module" src="js/leaf.js"></script>') }, { page: 'server/c.html', html: page() }];
  assert.deepEqual(moduleStateProblems('server/js/leaf.js', module, good, parser), []);
  assert.match(moduleStateProblems('server/js/leaf.js', LEAF, good, parser).join('\n'), /is recorded as a module and has no import or export left/);
  assert.match(moduleStateProblems('server/js/leaf.js', module, [{ page: 'server/a.html', html: LAST }], parser).join('\n'), /server\/js\/leaf\.js: server\/a\.html loads it with <script src=/);
  assert.match(moduleStateProblems('server/js/leaf.js', module, [good[1]], parser).join('\n'), /no page loads server\/js\/leaf\.js/);
});

function repo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-browser-module-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
  for (const args of [['init', '-q'], ['add', '-A']]) assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  return root;
}

test('who else loads a script, and who has its names, is asked of the whole repo', (t) => {
  if (!parser) return t.skip(SKIP);
  const files = {
    'server/index.html': page('<script src="js/listed.js"></script>', '<script src="js/named.js"></script>', '<script src="js/node.js"></script>', '<script src="js/loaded.js"></script>',
      '<script src="js/part.js"></script>', '<script src="js/leaf.js"></script>'),
    'server/js/leaf.js': `${LEAF}function onlyHere() {}\n`,
    'server/js/named.js': "'use strict';\nfunction showPanel() {}\nconst PANEL_MS = 300;\n",
    'server/js/first.js': "'use strict';\ndocument.addEventListener('click', () => showPanel());\n// PANEL_MS is only named in this comment\n",
    'server/js/listed.js': "'use strict';\n",
    'server/js/layer-tiles.js': "module.exports = { TILES: { clock: { css: [], js: ['js/listed.js'] } }, LITE: ['clock'] };\n",
    'server/js/node.js': "'use strict';\n",
    'server/test/node.test.mjs': "const made = require('../js/node.js');\n",
    'server/test/leaf.test.mjs': "import { readFileSync } from 'node:fs';\nconst text = readFileSync('server/js/leaf.js', 'utf8');\n",
    'server/js/loaded.js': "'use strict';\n",
    'server/js/loader.js': "const SCRIPTS = ['js/loaded.js'];\n",
    'server/js/part.js': "'use strict';\n",
    'tools/quality/baseline/lint.json': '{"counts":{"server/js/leaf.js rule":1}}\n',
  };
  const root = repo(t, files);
  const ledger = { moves: [{ kind: 'script', from: 'server/js/whole.js', file: 'server/js/part.js', about: '', names: [] }] };
  const pages = [{ page: 'server/index.html', html: files['server/index.html'] }];
  const why = (file) => moduleReasons({ root, parser, file, ledger, pages }).reasons.map((reason) => `${reason.kind}: ${reason.text}`).join('\n');
  assert.equal(why('server/js/leaf.js'), '', 'a test that reads it as text and a saved number that names it load nothing');
  assert.match(why('server/js/listed.js'), /^loader: server\/js\/layer-tiles\.js holds it in a list a page is built from/m);
  assert.match(why('server/js/loaded.js'), /^loader: server\/js\/loader\.js:1 names it in code/m);
  assert.match(why('server/js/node.js'), /^loader: server\/test\/node\.test\.mjs:1 loads it in Node/m);
  assert.match(why('server/js/part.js'), /^split: it is one of the scripts server\/js\/whole\.js is split into/m);
  assert.match(why('server/js/named.js'), /^names: server\/js\/first\.js has the word showPanel/m);
  assert.doesNotMatch(why('server/js/named.js'), /PANEL_MS/, 'a name in a comment is not read');
  assert.match(why('server/js/named.js'), /^place: server\/index\.html loads js\/node\.js after it as a classic script/m);
  assert.match(why('server/js/vendor/lib.js'), /is not a script of ours/);
  assert.match(why('server/js/absent.js'), /does not exist/);
});

test('verify redoes a conversion from the revision before and finds a tag changed by hand', (t) => {
  if (!parser) return t.skip(SKIP);
  const base = { 'server/index.html': LAST, 'server/js/leaf.js': LEAF };
  const converted = { 'server/index.html': LAST.replace('<script src="js/leaf.js">', '<script type="module" src="js/leaf.js">'), 'server/js/leaf.js': `${LEAF}${MODULE_LINE}`,
    'tools/restructure/extracted-browser.json': JSON.stringify({ moves: [{ kind: 'module', file: 'server/js/leaf.js', names: [] }] }) };
  const root = repo(t, converted);
  const show = (at, rev, file) => base[file] ?? null;
  assert.deepEqual(replay({ root, parser, base: 'before', show }), { problems: [], replayed: 1, compared: ['server/index.html', 'server/js/leaf.js'] });
  assert.deepEqual(replay({ root, parser, base: 'after', show: (at, rev, file) => converted[file] ?? null }), { problems: [], replayed: 0, compared: [] },
    'a revision that has the module already has nothing to redo');
  fs.writeFileSync(path.join(root, 'server/index.html'), converted['server/index.html'].replace('type="module"', 'type="module" async'));
  assert.match(replay({ root, parser, base: 'before', show }).problems.join('\n'), /server\/index\.html differs from before by more than the recorded moves/);
});

const view = (extra = {}) => ({ name: 'wide', address: '/', pageErrors: [], consoleErrors: [], failedRequests: [], refused: [], globals: ['a', 'show'], scripts: ['/js/a.js', '/js/leaf.js'],
  stylesheets: [], rules: 'same', ruleCount: 1, declared: { a: 'function', show: 'function', LIMIT: 'number' }, ...extra });
const recording = (extra) => ({ views: [view(extra)], settings: { opened: true } });
const MOVES = { moves: [{ kind: 'module', file: 'server/js/leaf.js', names: ['show', 'LIMIT'] }] };

test('the page check lets a recorded module take its own names off the page, and nothing more', () => {
  const before = recording();
  const diff = (extra, ledger = MOVES) => compareRecordings(before, recording(extra), ledger).join('\n');
  const ran = [{ address: '/js/leaf.js', exports: [] }];
  assert.equal(diff({ modules: ran, globals: ['a'], declared: { a: 'function' } }), '');
  assert.equal(diff({ modules: ran, globals: [], declared: {} }), 'wide: no longer on window: a\nwide: top-level names that answer differently: a (function -> not there)',
    'a name the module never had is still missed');
  assert.match(diff({ modules: ran, globals: ['a'], declared: { a: 'function' } }, { moves: [] }), /loads \/js\/leaf\.js as a module, and no recorded move made it one/);
  assert.match(diff({ modules: [{ address: '/js/leaf.js', error: 'x is not defined' }], globals: ['a'], declared: { a: 'function' } }), /the module \/js\/leaf\.js did not run: x is not defined/);
  assert.match(diff({ globals: ['a'], declared: { a: 'function' } }), /no longer on window: show/, 'without the module on the page its names are missed like any other');
  const was = recording({ modules: [{ address: '/js/leaf.js', exports: ['show'] }], globals: ['a'], declared: { a: 'function' } });
  const now = (modules) => compareRecordings(was, recording({ modules, globals: ['a'], declared: { a: 'function' } }), MOVES).join('\n');
  assert.equal(now([{ address: '/js/leaf.js', exports: ['show'] }]), '');
  assert.equal(now([{ address: '/js/leaf.js', exports: [] }]), 'wide: the module /js/leaf.js exports other names (show before, none now)');
  assert.equal(now([]), 'wide: no longer loads the module /js/leaf.js');
});

test('a page may have a question of its own, and its answer must stay the same', () => {
  const second = { deck: 'deck~two', drawn: true };
  const asked = (probe) => compareRecordings(recording({ probe: second }), recording(probe === undefined ? {} : { probe }), { moves: [] }).join('\n');
  assert.equal(asked({ deck: 'deck~two', drawn: true }), '');
  assert.equal(asked({ deck: null, drawn: true }), 'wide: the page\'s own question is answered differently ({"deck":"deck~two","drawn":true} before, {"deck":null,"drawn":true} now)');
  assert.match(asked(undefined), /answered differently \(.* before, undefined now\)/, 'a question no longer asked is not an answer');
  const one = PAGES.find((entry) => entry.probe);
  assert.equal(one.file, 'server/deck-popup.html', 'the window of a second deck is asked whose deck it shows');
  assert.match(one.path, /\?instance=deck~[a-z0-9]+$/);
});
