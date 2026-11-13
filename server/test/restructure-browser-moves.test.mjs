// The three browser moves of tools/restructure as functions from texts to texts:
// where a new tag goes in a page, a stylesheet cut into parts, and a script
// written inside a page moved to a file. Every page that loads the old file must
// load the new ones right next to it, in order.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { applyMove } from '../../tools/restructure/browser-moves.mjs';
import { addTags, inlineScripts, runProblems, tagsOf } from '../../tools/restructure/browser-pages.mjs';
import { planStyleSplit, readStylesheet } from '../../tools/restructure/browser-styles.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const PAGE = ['<!doctype html>', '<head>', '<link rel="stylesheet" href="components/Box.css?v=1">', '<link rel="stylesheet" href="components/Last.css">',
  '</head>', '<body>', '<!-- <script src="js/old.js"></script> -->', '  <script src="js/first.js"></script>', '  <script src="js/demo.js"></script>',
  '<script src="js/last.js" defer></script>', '<script>', '  window.ready = true;', '</script>', '</body>', ''].join('\n');

const treeOf = (files) => ({ get: (file) => files[file] ?? null });
const refusal = (run) => { try { run(); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; } return ''; };

test('a page is read as the files it loads, in order, comments left out', () => {
  const tags = tagsOf(PAGE);
  assert.deepEqual(tags.map((tag) => tag.file), ['server/components/Box.css', 'server/components/Last.css', 'server/js/first.js', 'server/js/demo.js', 'server/js/last.js']);
  assert.deepEqual(tags.map((tag) => tag.kind), ['style', 'style', 'script', 'script', 'script']);
  assert.equal(tags[4].unordered, true, 'a deferred script does not run in tag order');
  assert.equal(tags[4].plain, false);
  assert.deepEqual(tagsOf('<script src="https://example.com/x.js"></script>').map((tag) => tag.file), [null], 'another site is not a file of ours');
});

test('a new tag is the old tag with another file, on its own line, right before or right after', () => {
  const before = addTags(PAGE, 'server/js/demo.js', ['server/js/demo/a.js', 'server/js/demo/b.js'], 'before');
  assert.deepEqual(before.reasons, []);
  assert.ok(before.html.includes('  <script src="js/first.js"></script>\n  <script src="js/demo/a.js"></script>\n  <script src="js/demo/b.js"></script>\n  <script src="js/demo.js"></script>\n'));
  const after = addTags(PAGE, 'server/components/Box.css', ['server/components/BoxEdit.css'], 'after');
  assert.ok(after.html.includes('<link rel="stylesheet" href="components/Box.css?v=1">\n<link rel="stylesheet" href="components/BoxEdit.css">\n<link rel="stylesheet" href="components/Last.css">'),
    'the cache stamp of the old tag is not copied: the engine stamps every tag it serves');
  assert.equal(addTags(PAGE, 'server/js/absent.js', ['server/js/x.js'], 'before').html, PAGE, 'a page that does not load the file is left alone');
});

test('a tag that is not a plain, ordered load is not copied', () => {
  assert.match(addTags(PAGE, 'server/js/last.js', ['server/js/x.js'], 'before').reasons.join('\n'), /async, defer or a module/);
  const twice = PAGE.replace('<script src="js/first.js"></script>', '<script src="js/demo.js"></script>');
  assert.match(addTags(twice, 'server/js/demo.js', ['server/js/x.js'], 'before').reasons.join('\n'), /loads server\/js\/demo\.js 2 times/);
  const shared = '<script src="js/a.js"></script><script src="js/b.js"></script>\n';
  assert.match(addTags(shared, 'server/js/a.js', ['server/js/x.js'], 'before').reasons.join('\n'), /shares its line/);
  const withId = '<link rel="stylesheet" href="a.css" id="theme">\n';
  assert.match(addTags(withId, 'server/a.css', ['server/b.css'], 'after').reasons.join('\n'), /carries more than the file to load/);
});

test('the files of a split must follow each other with nothing between', () => {
  const run = ['server/js/demo/a.js', 'server/js/demo.js'];
  const good = addTags(PAGE, 'server/js/demo.js', ['server/js/demo/a.js'], 'before').html;
  assert.deepEqual(runProblems(good, run), []);
  assert.deepEqual(runProblems(PAGE.replace('  <script src="js/demo.js"></script>\n', ''), run), [], 'a page that loads none of them is fine');
  assert.match(runProblems(PAGE, run).join('\n'), /loads demo\.js where a\.js, demo\.js must follow each other/);
  const apart = good.replace('  <script src="js/demo/a.js"></script>\n', '').replace('  <script src="js/first.js"></script>\n', '  <script src="js/demo/a.js"></script>\n  <script src="js/first.js"></script>\n');
  assert.match(runProblems(apart, run).join('\n'), /must follow each other/);
});

test('a script move changes the page, the old script and the new one together', (t) => {
  if (!parser) return t.skip(SKIP);
  const script = ['function hello() { return 1; }', 'function bye() { return 2; }', 'hello();', ''].join('\n');
  const tree = treeOf({ 'server/index.html': PAGE, 'server/other.html': '<p>nothing</p>\n', 'server/js/demo.js': script });
  const context = { parser, pages: ['server/index.html', 'server/other.html'], earlier: [] };
  const done = applyMove(tree, { kind: 'script', from: 'server/js/demo.js', file: 'server/js/demo/hello.js', about: 'Says hello.', names: ['hello'] }, context);
  assert.deepEqual([...done.files.keys()].sort(), ['server/index.html', 'server/js/demo.js', 'server/js/demo/hello.js']);
  assert.equal(done.files.get('server/js/demo/hello.js'), '// Says hello.\n\nfunction hello() { return 1; }\n');
  assert.equal(done.files.get('server/js/demo.js'), 'function bye() { return 2; }\nhello();\n');
  assert.ok(done.files.get('server/index.html').includes('  <script src="js/demo/hello.js"></script>\n  <script src="js/demo.js"></script>'));
  assert.deepEqual(done.record, { kind: 'script', from: 'server/js/demo.js', file: 'server/js/demo/hello.js', about: 'Says hello.', names: ['hello'] });

  const taken = treeOf({ 'server/index.html': PAGE, 'server/js/demo.js': script, 'server/js/demo/hello.js': 'old\n' });
  assert.match(refusal(() => applyMove(taken, done.record, { ...context, pages: ['server/index.html'] })), /exists already/);
  const noPage = treeOf({ 'server/index.html': '<p>nothing</p>\n', 'server/js/demo.js': script });
  assert.match(refusal(() => applyMove(noPage, done.record, { ...context, pages: ['server/index.html'] })), /no page loads server\/js\/demo\.js with a tag/);
});

const SHEET = ['/* Box */', '.box {', '  color: red;', '}', '', '/* ── Edit ── */', '.box-edit,', '.box-edit:hover {', '  color: blue;', '}',
  '@media (max-width: 400px) {', '  .box { color: green; }', '}', ''].join('\n');

test('a stylesheet is cut only between two rules, and the parts read in order are the old file', () => {
  assert.deepEqual([...readStylesheet(SHEET).between].sort((a, b) => a - b), [1, 2, 5, 6, 7, 11, 14]);
  const cut = planStyleSplit(SHEET, [{ file: 'server/components/BoxEdit.css', at: 6 }, { file: 'server/components/BoxSmall.css', at: 11 }], 'server/components/Box.css');
  assert.equal(cut.kept, '/* Box */\n.box {\n  color: red;\n}\n\n');
  assert.equal(cut.kept + cut.parts.map((part) => part.text).join(''), SHEET);
  const why = (cuts) => refusal(() => planStyleSplit(SHEET, cuts, 'server/components/Box.css'));
  assert.match(why([{ file: 'x.css', at: 3 }]), /line 3 is inside a rule, a comment or a list of selectors/);
  assert.match(why([{ file: 'x.css', at: 8 }]), /line 8 is inside a rule/, 'between two selectors of one rule');
  assert.match(why([{ file: 'x.css', at: 12 }]), /line 12 is inside a rule/, 'inside a media block');
  assert.match(why([{ file: 'x.css', at: 11 }, { file: 'y.css', at: 6 }]), /the cuts must go down the file/);
  assert.match(why([]), /no cut given/);
});

test('a stylesheet that cannot be read in parts is refused whole', () => {
  const cut = [{ file: 'x.css', at: 2 }];
  assert.match(refusal(() => planStyleSplit('@import url("a.css");\n.a { color: red; }\n', cut, 'a.css')), /@import at line 1 works for one stylesheet only/);
  assert.match(refusal(() => planStyleSplit('.a { color: red;\n.b { color: blue; }\n', cut, 'a.css')), /still open at the end/);
  assert.match(refusal(() => planStyleSplit('/* never closed\n.a { color: red; }\n', cut, 'a.css')), /never closes/);
  assert.deepEqual([...readStylesheet('.a { content: "}"; }\n/* } */\n.b { color: red; }\n').between].sort((a, b) => a - b), [1, 2, 3, 4],
    'a bracket inside a string or a comment is not a bracket');
});

test('a stylesheet move links the parts right after the old sheet on every page', () => {
  const tree = treeOf({ 'server/index.html': PAGE, 'server/components/Box.css': SHEET });
  const move = { kind: 'style', from: 'server/components/Box.css', parts: [{ file: 'server/components/BoxEdit.css', at: 6 }] };
  const done = applyMove(tree, move, { parser: null, pages: ['server/index.html'], earlier: [] });
  assert.equal(done.files.get('server/components/Box.css') + done.files.get('server/components/BoxEdit.css'), SHEET);
  assert.ok(done.files.get('server/index.html').includes('href="components/Box.css?v=1">\n<link rel="stylesheet" href="components/BoxEdit.css">\n'));
  assert.match(refusal(() => applyMove(tree, move, { parser: null, pages: ['server/index.html'], earlier: [done.record] })), /cut into parts already/);
});

test('a script written inside a page becomes a file with the same code', () => {
  assert.deepEqual(inlineScripts(PAGE).map((block) => [block.code, block.simple]), [['\n  window.ready = true;\n', true]]);
  const move = { kind: 'inline', from: 'server/index.html', file: 'server/js/ready.js', about: 'Says the page is ready.', nth: 0 };
  const done = applyMove(treeOf({ 'server/index.html': PAGE }), move, { parser: null, pages: ['server/index.html'], earlier: [] });
  assert.equal(done.files.get('server/js/ready.js'), '// Says the page is ready.\n\n  window.ready = true;\n');
  assert.equal(done.files.get('server/index.html'), PAGE.replace('<script>\n  window.ready = true;\n</script>', '<script src="js/ready.js"></script>'));
  const own = PAGE.replace('window.ready = true;', 'document.currentScript.remove();');
  assert.match(refusal(() => applyMove(treeOf({ 'server/index.html': own }), move, {})), /document\.currentScript, which means something else in a file/);
  const typed = PAGE.replace('<script>\n', '<script type="module">\n');
  assert.match(refusal(() => applyMove(treeOf({ 'server/index.html': typed }), move, {})), /not a bare <script> on its own lines/);
  assert.match(refusal(() => applyMove(treeOf({ 'server/index.html': PAGE }), { ...move, nth: 3 }, {})), /has no script number 3/);
});
