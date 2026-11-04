// docs/llms.txt: what answer engines read about Xenon. Every page it names must
// exist, and the line stamp-release.mjs rewrites at deploy must stay findable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TXT = fs.readFileSync(path.join(ROOT, 'docs', 'llms.txt'), 'utf8');
// Served by other deploys on the same domain, not from docs/.
const ELSEWHERE = new Set(['/maker/']);

test('every xenon-app.com page in llms.txt exists in docs/', () => {
  const urls = [...TXT.matchAll(/https:\/\/xenon-app\.com(\/[^\s)#]*)/g)].map((m) => m[1]);
  assert.ok(urls.length > 10);
  for (const u of new Set(urls)) {
    if (ELSEWHERE.has(u)) continue;
    const file = path.join(ROOT, 'docs', u.endsWith('/') ? u + 'index.html' : u);
    assert.ok(fs.existsSync(file), `${u} has no file in docs/`);
  }
});

test('llms.txt keeps the stamped release line and the plain-language rules', () => {
  assert.match(TXT, /^- Latest release: .+$/m);
  assert.match(TXT, /^- Platforms:/m);
  assert.doesNotMatch(TXT, /—/);
  // Amounts name their currency.
  for (const m of TXT.matchAll(/\b\d+(?:[.,]\d+)?\s*(USD|\$|EUR|€)?/g)) {
    if (m[1] === '$' || m[1] === '€') assert.fail(`currency symbol instead of a code: ${m[0]}`);
  }
});
