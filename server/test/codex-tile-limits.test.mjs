import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Codex sends extra limit buckets (seen: "gpt-reserve") that its own usage menu
// never shows. The tile lists the main one, and another only while it blocks.

const SRC = readFileSync(new URL('../js/codex-widget.js', import.meta.url), 'utf8');

test('extra limit buckets show only while they are the one reached', () => {
  assert.match(SRC, /lim\.buckets\.slice\(0, 3\)\.filter\(\(b, i\) => i === 0 \|\| b\.reached\)\.forEach/);
});
