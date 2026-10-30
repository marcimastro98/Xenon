import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The assistant is called Bit and its Settings section "Bit assistant", in the
// app and on the site. The site pages and the dictionaries their language copies
// are built from must not send people to a "Xenon AI" that no longer exists.
// The release notes keep the old name: they describe versions already shipped.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS = join(ROOT, 'docs');
const OLD = /Xenon AI|Xenon IA|IA Xenon|IA de Xenon/;
const LANGS = ['', 'es', 'fr', 'it', 'ja', 'ko', 'zh'];

function pages() {
  const out = [];
  for (const l of LANGS) {
    const dir = join(DOCS, l);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.html') && f !== 'releases.html') out.push(join(dir, f));
  }
  out.push(join(DOCS, 'create', 'index.html'));
  return out;
}

test('no site page names the assistant "Xenon AI"', () => {
  const hits = pages().filter((f) => OLD.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
});

test('no site dictionary names the assistant "Xenon AI"', () => {
  const dir = join(ROOT, 'tools', 'i18n');
  const hits = readdirSync(dir).filter((f) => f.endsWith('.json') && OLD.test(readFileSync(join(dir, f), 'utf8')));
  assert.deepEqual(hits, []);
});

test('the home names Bit and its Sparks among the ways to run it, in every language', () => {
  const home = readFileSync(join(DOCS, 'index.html'), 'utf8');
  assert.match(home, /<h2 id="h-bit">Bit<\/h2>/);
  const sparks = ['Sparks, Xenon\'s credits', 'Scintille, i crediti di Xenon', 'Chispas, los créditos de Xenon',
    'Étincelles, les crédits de Xenon', 'Xenon のクレジットであるスパーク', 'Xenon의 크레딧인 스파크', 'Xenon 的点数“火花”'];
  for (const s of sparks) assert.ok(home.includes(s), `home lacks "${s}"`);
});
