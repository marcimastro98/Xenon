// The pages no tag search finds: the page of a widget on the desktop is built by
// the engine from a list of files per widget (server/js/layer-tiles.js). A split
// must put its new files into that list next to the old one, and the page check
// must open every page that loads a file before the file may be split.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAGES, onThisPc, plainFor, serverOf, staysOnCopy, uncheckedPages } from '../../tools/restructure/browser-check-pages.mjs';
import { addToLists, BUILT_LIST, listRunProblems, listsHold, readLists } from '../../tools/restructure/browser-lists.mjs';
import { applyMove } from '../../tools/restructure/browser-moves.mjs';
import { listPages, tagsOf } from '../../tools/restructure/browser-pages.mjs';
import { builtPages } from '../../tools/restructure/browser-state.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());

// A small list written the way the real one is: rows by hand, and rows made by a helper that builds one name.
const LIST = [
  '(function (root, factory) { module.exports = factory(); })(this, function () {',
  "  const tile = (name, global, js, streams, cssName, moreCss) => ({ css: ['components/' + (cssName || global) + '/' + (cssName || global) + '.css'].concat(moreCss || []), js: js });",
  '  const TILES = {',
  "    clock: { css: ['components/Clock/Clock.css', 'components/Select/Select.css'], js: ['js/select.js', 'js/clock.js'] },",
  "    disk: tile('disk', 'Disk', ['js/select.js', 'js/disk.js'], ['system'], null, ['components/Select/Select.css']),",
  "    battery: tile('battery', 'Battery', ['js/battery.js'], []),",
  "    stock: tile('stock', 'Stock', ['js/stock.js'], [], 'Ticker'),",
  '  };',
  '  return { TILES: TILES };',
  '});',
  '',
].join('\n');

const css = (text, row) => readLists(text)[row].css.map((file) => file.replace('server/components/', ''));
const js = (text, row) => readLists(text)[row].js.map((file) => file.replace('server/js/', ''));

test('the list of files per widget is read by running it', () => {
  assert.deepEqual(readLists(LIST).disk, { css: ['server/components/Disk/Disk.css', 'server/components/Select/Select.css'], js: ['server/js/select.js', 'server/js/disk.js'] });
  assert.equal(listsHold(LIST, 'server/components/Ticker/Ticker.css'), true, 'a name the list builds is found by asking it');
  assert.equal(listsHold(LIST, 'server/components/Stock/Stock.css'), false);
  assert.equal(listsHold(null, 'server/js/clock.js'), false, 'a repo without the list');
});

test('a new script goes right before the old one in every row that holds it', () => {
  const done = addToLists(LIST, 'server/js/select.js', ['server/js/select/a.js', 'server/js/select/b.js'], 'before');
  assert.deepEqual(done.reasons, []);
  assert.deepEqual(js(done.text, 'clock'), ['select/a.js', 'select/b.js', 'select.js', 'clock.js']);
  assert.deepEqual(js(done.text, 'disk'), ['select/a.js', 'select/b.js', 'select.js', 'disk.js']);
  assert.deepEqual(js(done.text, 'battery'), ['battery.js'], 'a row without the file is left alone');
  assert.equal(addToLists(LIST, 'server/js/absent.js', ['server/js/x.js'], 'before').text, LIST);
});

test('the parts of a stylesheet go right after it, also where the row builds its name', () => {
  const written = addToLists(LIST, 'server/components/Select/Select.css', ['server/components/Select/SelectMenu.css'], 'after');
  assert.deepEqual(written.reasons, []);
  assert.deepEqual(css(written.text, 'clock'), ['Clock/Clock.css', 'Select/Select.css', 'Select/SelectMenu.css']);
  assert.deepEqual(css(written.text, 'disk'), ['Disk/Disk.css', 'Select/Select.css', 'Select/SelectMenu.css']);
  const more = addToLists(LIST, 'server/components/Disk/Disk.css', ['server/components/Disk/DiskBars.css'], 'after');
  assert.deepEqual(css(more.text, 'disk'), ['Disk/Disk.css', 'Disk/DiskBars.css', 'Select/Select.css'], 'in front of the stylesheets the row already adds');
  const four = addToLists(LIST, 'server/components/Battery/Battery.css', ['server/components/Battery/BatteryRows.css'], 'after');
  assert.deepEqual([four.reasons, css(four.text, 'battery')], [[], ['Battery/Battery.css', 'Battery/BatteryRows.css']]);
  const five = addToLists(LIST, 'server/components/Ticker/Ticker.css', ['server/components/Ticker/TickerRows.css'], 'after');
  assert.deepEqual([five.reasons, css(five.text, 'stock')], [[], ['Ticker/Ticker.css', 'Ticker/TickerRows.css']]);
  assert.ok(five.text.includes("tile('stock', 'Stock', ['js/stock.js'], [], 'Ticker', ['components/Ticker/TickerRows.css'])"), 'the edit is the smallest one that does it');
});

test('a row the tool cannot follow stops the split, and nothing is written', () => {
  const odd = LIST.replace("js: ['js/select.js', 'js/clock.js']", "js: ['select', 'clock'].map((name) => 'js/' + name + '.js')");
  const done = addToLists(odd, 'server/js/select.js', ['server/js/select/a.js'], 'before');
  assert.deepEqual(done.reasons, [`the row "clock" of ${BUILT_LIST} builds its js list in a way the tool cannot follow: write js/select.js out in that row first`]);
  assert.equal(done.text, odd);
});

test('the files of a split follow each other in every row, or the row is named', () => {
  const run = ['server/js/select/a.js', 'server/js/select.js'];
  assert.deepEqual(listRunProblems(addToLists(LIST, 'server/js/select.js', ['server/js/select/a.js'], 'before').text, run), []);
  assert.deepEqual(listRunProblems(LIST, run).length, 2, 'both rows that load the old script lack the new one');
  assert.match(listRunProblems(LIST, run)[0], /the row "clock" of server\/js\/layer-tiles\.js loads js\/select\.js where js\/select\/a\.js, js\/select\.js must follow each other/);
});

test('a move writes the list together with the pages', () => {
  const sheet = '.a { color: red; }\n\n/* second */\n.b { color: blue; }\n';
  const files = { 'server/index.html': '<link rel="stylesheet" href="components/Select/Select.css">\n', 'server/components/Select/Select.css': sheet, [BUILT_LIST]: LIST };
  const tree = { get: (file) => files[file] ?? null };
  const move = { kind: 'style', from: 'server/components/Select/Select.css', parts: [{ file: 'server/components/Select/SelectMenu.css', at: 2 }] };
  const done = applyMove(tree, move, { parser, pages: ['server/index.html'], earlier: [] });
  assert.deepEqual(css(done.files.get(BUILT_LIST), 'disk'), ['Disk/Disk.css', 'Select/Select.css', 'Select/SelectMenu.css']);
  assert.ok(done.files.get('server/index.html').includes('Select/Select.css">\n<link rel="stylesheet" href="components/Select/SelectMenu.css">'));
  const odd = { ...files, [BUILT_LIST]: LIST.replace("'components/Clock/Clock.css', 'components/Select/Select.css'", "'components/Clock/Clock.css', 'components/Select/' + 'Select.css'") };
  assert.throws(() => applyMove({ get: (file) => odd[file] ?? null }, move, { parser, pages: ['server/index.html'], earlier: [] }),
    (error) => error instanceof Refusal && /the row "clock".*cannot follow/.test(error.reasons.join('\n')));
});

test('the engine builds a desktop page for every widget the list holds', () => {
  const pages = builtPages(ROOT);
  const { LITE } = createRequire(import.meta.url)('../js/layer-tiles.js');
  assert.equal(pages.length, LITE.length + 1, 'one page per widget and one with all of them');
  for (const { page, html } of pages) assert.ok(tagsOf(html).some((tag) => tag.file === BUILT_LIST), `${page} is a real page`);
});

test('the page check opens every page of the app that loads a file of its own', () => {
  const pages = listPages(ROOT);
  assert.deepEqual(PAGES.map((page) => page.file).filter((file) => !pages.includes(file)), [], 'a page on the list is a page of the repo');
  // A page with no file of ours to load cannot be touched by a split; the widget examples run in a frame
  // of their own and load only the two files next to them, which are never split.
  const loadsOurs = (page) => tagsOf(fs.readFileSync(path.join(ROOT, page), 'utf8')).some((tag) => tag.file !== null);
  const unopened = uncheckedPages(pages).filter(loadsOurs);
  assert.deepEqual(unopened.filter((page) => !/^server\/sdk-example\/[a-z0-9-]+\/index\.html$/.test(page)), []);
  assert.deepEqual(uncheckedPages(['server/index.html', 'server/sdk-example/hello-xenon/index.html']), ['server/sdk-example/hello-xenon/index.html']);
  assert.deepEqual(PAGES.map((page) => page.name).filter((name, at, all) => all.indexOf(name) !== at), [], 'a page has one name in a recording');
});

test('a page the check opens can reach the test copy and nothing else', () => {
  for (const address of ['http://127.0.0.1:3041/', 'http://127.0.0.1:3041/api/native/status?x=1', 'ws://127.0.0.1:3041/api/ai/live',
    'data:image/png;base64,AAAA', 'blob:http://127.0.0.1:3041/1b2c', 'about:blank']) {
    assert.equal(staysOnCopy(address, 3041), true, address);
  }
  // The installed app answers on a fixed port of the same PC: a page of the copy that names it must not get there.
  for (const address of ['http://127.0.0.1:3030/api/native/status', 'http://localhost:3041/', 'http://127.0.0.1/', 'https://127.0.0.1:3041/',
    'http://127.0.0.1:30411/', 'http://127.0.0.1:3041@example.com/', 'https://example.com/font.woff2', 'wss://example.com:443', 'ws://127.0.0.1:3030/ws',
    'file:///C:/x.html', 'not an address', '']) {
    assert.equal(staysOnCopy(address, 3041), false, address);
  }
  assert.equal(serverOf('http://127.0.0.1:3030/api/native/status?x=1'), 'http://127.0.0.1:3030');
  assert.equal(serverOf('https://example.com/img/a.jpg?width=140'), 'https://example.com');
  assert.deepEqual(['http://127.0.0.1:3030', 'http://localhost:8080', 'http://[::1]:3030', 'https://example.com', 'https://127.example.com', 'no'].map(onThisPc),
    [true, true, true, false, false, false]);
});

test('a recording drops the address of the test copy and keeps any other, so a refused request says where it was going', () => {
  const plain = plainFor(3041);
  assert.equal(plain('http://127.0.0.1:3041/js/app.js?v=5.1.0'), '/js/app.js');
  assert.equal(plain('http://127.0.0.1:3030/api/native/status net::ERR_BLOCKED_BY_CLIENT'), 'http://127.0.0.1:3030/api/native/status net::ERR_BLOCKED_BY_CLIENT');
  assert.equal(plain("blocked at 'http://127.0.0.1:3041/a' from origin 'http://127.0.0.1:3041'"), "blocked at '/a' from origin ''");
  assert.equal(['http://127.0.0.1:3041/a.css', 'http://127.0.0.1:3041/b.css'].map(plain).join(' '), '/a.css /b.css', 'usable as the function of a map');
});
