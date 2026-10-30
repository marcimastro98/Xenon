// App copy carries no em-dashes: they read as machine-written. A lone "—" is
// still allowed, it is the "no value yet" mark in tiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');

function loadStrings() {
  const ctx = { window: {}, document: { documentElement: {}, addEventListener() {}, querySelectorAll: () => [] }, localStorage: { getItem() { return null; }, setItem() {} }, navigator: { language: 'en' }, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('js/i18n.js') + '\n;globalThis.__i18n = i18n;', ctx);
  return ctx.__i18n;
}

test('no translated string in any language uses an em-dash', () => {
  const all = loadStrings();
  assert.equal(Object.keys(all).length, 11);
  assert.ok(Object.keys(all.en).length > 1000, 'the string tables loaded');
  const bad = [];
  for (const [lang, table] of Object.entries(all)) {
    for (const [key, value] of Object.entries(table)) {
      if (typeof value === 'string' && value.includes('—') && value.trim() !== '—') bad.push(`${lang}.${key}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the Italian defaults written in index.html have no em-dash either', () => {
  const html = read('index.html').replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const texts = [...html.matchAll(/data-i18n="([\w.-]+)"[^>]*>([^<]*)</g)].filter(([, , t]) => t.includes('—') && t.trim() !== '—');
  assert.deepEqual(texts.map(([, key]) => key), []);
});
