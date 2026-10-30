// The FAQ answers what people ask before and while they use Xenon (what it is,
// which screen, games, widgets, backups), not mostly antivirus trouble. Every
// question is translated in all 7 site languages, amounts name their currency,
// and the two anchors other pages link to (#warnings, #mac-linux) still land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(root, 'docs', 'faq.html'), 'utf8');
const dict = {};
for (const f of ['faq.json', 'faq.es.json', 'faq.fr.json']) {
  for (const [l, t] of Object.entries(JSON.parse(readFileSync(join(root, 'tools', 'i18n', f), 'utf8')))) dict[l] = { ...dict[l], ...t };
}
const LANGS = ['en', 'it', 'es', 'fr', 'ja', 'ko', 'zh'];
const QUESTIONS = ['what', 'edge', 'screen', 'os', 'free', 'sparks', 'games', 'add', 'sensors', 'connect', 'backup', 'virus', 'closes', 'temp', 'update', 'data', 'help'];

test('the page asks the agreed questions, in order', () => {
  const keys = [...html.matchAll(/<summary data-i18n="f\.q\.([a-z]+)">/g)].map((m) => m[1]);
  assert.deepEqual(keys, QUESTIONS);
});

test('the anchors other pages link to still exist', () => {
  assert.match(html, /id="warnings"/);
  assert.match(html, /<details id="mac-linux">\s*<summary data-i18n="f\.q\.os">/);
});

test('every question and answer is in all 7 languages, with no leftover keys', () => {
  const used = new Set([...html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)].map((m) => m[1]));
  for (const l of LANGS) {
    for (const k of used) assert.ok(dict[l]?.[k], `${l} is missing ${k}`);
    for (const k of Object.keys(dict[l])) assert.ok(used.has(k) || k.startsWith('meta.'), `${l} keeps an unused key ${k}`);
  }
});

test('amounts name their currency, and copy has no em-dashes', () => {
  for (const l of LANGS) {
    for (const [k, v] of Object.entries(dict[l])) {
      assert.doesNotMatch(v, /\$\s?\d/, `${l} ${k} writes a dollar sign`);
      assert.doesNotMatch(v, /—/, `${l} ${k} has an em-dash`);
    }
  }
  assert.match(dict.en['f.a.free'], /5 USD a month/);
});

test('the dropped questions are gone', () => {
  assert.doesNotMatch(html, /port 3030 is already in use|Do I have to use the app\?/);
});
