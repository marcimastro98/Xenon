// The page's global `api` is the Deck store's object (js/deck-store.js), not a
// fetch helper. A script that calls `api(...)` without its own local `api`
// throws at that line: the capture toasts' "Show"/"Stop" buttons and the Home
// Assistant dashboard list both broke this way. Pinned here for every script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
const CALL = /(?<![.\w$])api\(/;
const LOCAL = /(function\s+api\s*\(|(const|let|var)\s+api\s*=|[(,]\s*api\s*[,)=])/;

test('the global api is an object, as every caller must assume', () => {
  const src = fs.readFileSync(path.join(JS, 'deck-store.js'), 'utf8');
  assert.match(src, /^const api = \{/m);
});

test('no script calls api(...) without a local api of its own', () => {
  const bad = fs.readdirSync(JS)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => {
      const src = fs.readFileSync(path.join(JS, f), 'utf8');
      return CALL.test(src) && !LOCAL.test(src);
    });
  assert.deepEqual(bad, [], 'use apiJson(path, opts) from utils.js');
});
