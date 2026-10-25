// The radius tokens are lengths (--radius: 8px stock, 9px Comic, 0 Retro, and
// uiRoundness rewrites them inline as px). A rule that multiplies one by another
// length is invalid CSS, which the browser drops silently: an Ambient scene's
// card was square on every theme because of `calc(14px * var(--radius, 1))`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return cssFiles(p);
    return e.name.endsWith('.css') ? [p] : [];
  });
}

const LENGTH_TIMES_RADIUS = /\d(?:px|em|rem)\s*\*\s*var\(--radius[\w-]*|var\(--radius[\w-]*(?:,[^)]*)?\)\s*\*\s*[\d.]+(?:px|em|rem)/;

test('no rule multiplies a radius token by a length', () => {
  const bad = [];
  for (const f of [...cssFiles(join(ROOT, 'components')), ...cssFiles(join(ROOT, 'styles'))]) {
    readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (LENGTH_TIMES_RADIUS.test(line)) bad.push(`${f.slice(ROOT.length)}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});
