// The Xeneon Edge preview opens from a link only when the link asks for it (?edge or #edge).
// A share link (#preset=CODE) once held the letters "edge" inside its code by chance, and
// opening it switched the preview on and saved it in that browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';

const SRC = readFileSync(new URL('../js/grid/edge-preview.js', import.meta.url), 'utf8');

function initialState(href, stored = null) {
  const start = SRC.indexOf('  function initialState(');
  const body = SRC.slice(start, SRC.indexOf('\n  }\n', start) + 4);
  const url = new URL(href);
  const window = { location: { search: url.search, hash: url.hash } };
  const localStorage = { getItem: () => stored };
  return vm.runInNewContext(`const STORE_KEY = 'xenon.edgePreview';\n${body}\ninitialState()`, {
    window, localStorage, URLSearchParams,
  });
}

test('a share link never switches the preview on, whatever its code holds', () => {
  assert.equal(initialState('http://127.0.0.1:3030/#preset=abcEdGexyz'), false);
  assert.equal(initialState('http://127.0.0.1:3030/#preset=xxedgexx&place=screen'), false);
  assert.equal(initialState('http://127.0.0.1:3030/#knowledge'), false);
});

test('?edge and #edge still open it, and =0 or =false keep it off', () => {
  assert.equal(initialState('http://127.0.0.1:3030/?edge'), true);
  assert.equal(initialState('http://127.0.0.1:3030/#edge'), true);
  assert.equal(initialState('http://127.0.0.1:3030/#edge=1'), true);
  assert.equal(initialState('http://127.0.0.1:3030/#preset=abc&edge'), true);
  assert.equal(initialState('http://127.0.0.1:3030/#edge=0', '1'), false);
  assert.equal(initialState('http://127.0.0.1:3030/?edge=false', '1'), false);
});

test('with nothing in the link, the browser keeps its own choice', () => {
  assert.equal(initialState('http://127.0.0.1:3030/', '1'), true);
  assert.equal(initialState('http://127.0.0.1:3030/', '0'), false);
});
