// The explorable map page (tools/map/map-html.mjs, map-read.mjs): what it reads out
// of a file, and that the data it embeds cannot close its own script tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildData, renderPage } from '../../tools/map/map-html.mjs';
import { docAbove, exportsOf, routesOf, summaryOf, symbolsOf } from '../../tools/map/map-read.mjs';

test('summary: the first sentence of the opening comment, without banners or copyright', () => {
  assert.equal(summaryOf("'use strict';\n// What the engine answers about the weather. More words.\nconst a = 1;", 'js'), 'What the engine answers about the weather.');
  assert.equal(summaryOf('/* Xenon — Copyright (c) 2026 Someone.\n */\n// The engine starts here.\n', 'js'), 'The engine starts here.');
  assert.equal(summaryOf('/* ── Details: label over value ── */\n.x{}', 'css'), 'Details: label over value');
  assert.equal(summaryOf('#Requires -Version 5\n<#\n.SYNOPSIS\nReads the fans.\n#>\n', 'ps1'), 'Reads the fans.');
  assert.equal(summaryOf('# Title here\n\ntext', 'md'), 'Title here');
  assert.equal(summaryOf('const a = 1;\n// late comment', 'js'), '');
});

test('functions: name, line and the comment above, in order and once', () => {
  const src = [
    '// Reads the fans. Then more.', 'function a() {}',
    '  /**', '   * Sends it to the screen.', '   * @param {number} x', '   */', '  async function b(x) {}',
    'const c = (x) => x;', 'class E {}', 'function a() {}', '    if (x) {}',
  ].join('\n');
  assert.deepEqual(symbolsOf(src, 'js'), [['a', 2, 'Reads the fans.'], ['b', 7, 'Sends it to the screen.'], ['c', 8], ['E', 9]]);
  assert.deepEqual(symbolsOf('# Gets them\nfunction Get-Fans {\n}\n', 'ps1'), [['Get-Fans', 2, 'Gets them']]);
  assert.deepEqual(symbolsOf('/// Starts it.\n#[tauri::command]\npub fn start() {}', 'rs'), [['start', 3, 'Starts it.']]);
  assert.deepEqual(symbolsOf('.a { }', 'css'), []);
  assert.equal(docAbove(['x();', 'function f() {}'], 1, 'slash'), '', 'code above is not a comment');
});

test('exports: browser globals, ES exports and CommonJS names', () => {
  assert.deepEqual(exportsOf('window.SdkBadges = { set };\nwindow.x = 1;'), ['window.SdkBadges']);
  assert.deepEqual(exportsOf('export function run() {}\nexport const KEY = 1;'), ['run', 'KEY']);
  assert.deepEqual(exportsOf('module.exports = { readA, writeB: write, ...rest };'), ['readA', 'writeB', 'rest']);
});

test('routes: the METHOD /path keys of a routes table, with line and comment', () => {
  const src = "const branches = {\n  // The weather now.\n  'GET /weather': a,\n  'POST|GET /api/x': b,\n  \"DELETE /api/y/*\": c,\n};\n'GET'; '/z';";
  assert.deepEqual(routesOf(src), [['GET /weather', 3, 'The weather now.'], ['POST|GET /api/x', 4], ['DELETE /api/y/*', 5]]);
});

test('data: every file gets its feature, names come in both languages, and a file name cannot close the page', () => {
  const map = {
    intro: [], areas: [{ id: 'a', name: 'A', what: 'Area.' }],
    features: [{ id: 'one', area: 'a', name: 'One', what: 'Does `x`.', files: ['src/**'] }],
  };
  const italian = { pieces: {}, areas: { a: ['Zona A', 'Area.'] }, features: {} };
  const data = buildData(['src/x.js', 'other.txt'], map, italian, () => '// Says hi.\nfunction hi() {}');
  assert.deepEqual(data.files.map((file) => [file.p, file.o]), [['src/x.js', 'one'], ['other.txt', '']]);
  assert.deepEqual(data.files[0].f, [['hi', 2, 'Says hi.']]);
  assert.deepEqual(data.areas[0].name, { en: 'A', it: 'Zona A' });
  assert.deepEqual(data.features[0].name, { en: 'One', it: 'One' }, 'a missing translation falls back to English');
  assert.equal(data.features[0].what.en, 'Does x.');
  const page = renderPage({ html: '<style>/*@CSS@*/</style><script>/*@JS@*/</script>@MAP_STAMP@', css: 'b{}', js: 'const DATA = /*@MAP_DATA@*/null;' }, { s: '</script><b>' }, '1 <file>');
  assert.equal(page.split('</script>').length, 2, 'the data holds no closing tag');
  assert.ok(page.startsWith('<style>b{}</style>'));
  assert.ok(page.endsWith('1 file'));
});
