// The dashboard's live data (js/grid/data-stream.js) was the middle of main.js. It reads
// names main.js declares while it runs (`need` above all, a const), so it must load right
// after main.js on every page that loads main.js: earlier, `need` does not exist yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { partsOf } from './browser-source.mjs';

const SERVER = new URL('../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, SERVER), 'utf8').replace(/\r\n/g, '\n');
const scriptsOf = (html) => [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b[^>]*\bsrc="([^"?]+)/g)].map((m) => m[1]);

test('every page that loads main.js loads the data stream on the next tag, once', () => {
  const pages = fs.readdirSync(SERVER).filter((name) => name.endsWith('.html'));
  const loaders = pages.filter((page) => scriptsOf(read(page)).includes('js/main.js'));
  assert.ok(loaders.includes('index.html'), 'the dashboard loads main.js');
  for (const page of loaders) {
    const scripts = scriptsOf(read(page));
    assert.equal(scripts.filter((src) => src === 'js/main.js').length, 1, `${page} loads main.js once`);
    assert.equal(scripts[scripts.indexOf('js/main.js') + 1], 'js/grid/data-stream.js', `${page}: the stream right after main.js`);
    assert.equal(scripts.filter((src) => src === 'js/grid/data-stream.js').length, 1, `${page} loads the stream once`);
  }
  for (const page of pages.filter((name) => !loaders.includes(name))) {
    assert.ok(!scriptsOf(read(page)).includes('js/grid/data-stream.js'), `${page} loads the stream without main.js`);
  }
});

test('tests that read main.js read the stream with it, in page order', () => {
  assert.deepEqual(partsOf('server/js/main.js'), ['server/js/main.js', 'server/js/grid/data-stream.js']);
});

test('the stream script is one strict function run once, and main.js still declares what it reads', () => {
  const code = read('js/grid/data-stream.js').replace(/^\/\/.*\n/gm, '');
  assert.match(code, /^'use strict';\n\n\(function initDataStream\(\) \{\n/, 'strict like main.js, and nothing before the function');
  assert.ok(code.endsWith('\n}());\n'), 'nothing after it');
  const main = read('js/main.js');
  assert.match(main, /^'use strict';/);
  for (const name of [/^const need = \{/m, /^function alertToastCtx\(\)/m, /^function showAlertToast\(toast\)/m, /^function onAutoUpdate\(d\)/m]) {
    assert.match(main, name);
  }
  // What the stream reads from main.js, and nothing main.js runs later reads from the stream.
  for (const used of ['need.status', 'alertToastCtx()', 'showAlertToast(', 'onAutoUpdate(']) assert.ok(code.includes(used), used);
  assert.ok(!/initDataStream|\bconnect\(|startPollingFallback/.test(main.replace(/^\s*\/\/.*$/gm, '')), 'main.js never calls into the stream');
});
