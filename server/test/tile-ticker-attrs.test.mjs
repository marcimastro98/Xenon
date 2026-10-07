'use strict';
// The Claude tile's ticker rewrites EVERY [data-reset-at] / [data-expires-at] /
// [data-age-base] in the document once a second, reading data-reset-at as epoch
// SECONDS. A second tile that borrowed those names had its countdown written by
// both tickers in turn: the Codex tile stores milliseconds, so its "resets in"
// flipped every second between "29d23h" and "20742078d9h" (reported 6 Oct 2026).
// Every other tile keeps attribute names of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, '..', 'js', f), 'utf8');
const CLAIMED = /dataset\.(resetAt|expiresAt|ageBase)\b|data-(reset-at|expires-at|age-base)\b/;

test('the Claude ticker selects document-wide, which is why the names are reserved', () => {
  assert.match(read('claude-widget.js'), /document\.querySelectorAll\('\[data-reset-at\], \[data-expires-at\], \[data-age-base\]'\)/);
});

for (const f of ['codex-widget.js', 'chatgpt-widget.js']) {
  test(f + ' does not use the attribute names the Claude ticker rewrites', () => {
    const hits = read(f).split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => CLAIMED.test(l)).map(([n]) => f + ':' + n);
    assert.deepEqual(hits, []);
  });
}
