import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard for a silent, invisible bug: several language blocks in i18n.js
// carried `...i18n.en` in the MIDDLE of the object, so every translation written
// ABOVE the spread was overwritten by English at load time. Two deliberate
// translation passes (the v4.4.0 completeness fill and the v4.5.1 update-flow
// strings) landed there and never reached a single user: 241 strings across nine
// languages rendered in English while the correct translation sat in the file.
//
// Nothing surfaces this. The app runs, the key resolves, the text is simply the
// wrong language, and the source looks right to anyone reading it. So it is pinned
// here: the spread supplies the FALLBACK, therefore it must come first and every
// real translation must override it.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'js', 'i18n.js'), 'utf8');
const LINES = SRC.split(/\r?\n/);

// Language blocks are declared one per line as `  xx: {` and closed by `  },`.
function languageBlocks() {
  const blocks = [];
  for (let i = 0; i < LINES.length; i++) {
    const head = /^ {2}([a-z]{2}(?:-[A-Z]{2})?): \{\s*$/.exec(LINES[i]);
    if (!head) continue;
    const block = { lang: head[1], start: i, spread: -1, firstKey: -1, end: -1 };
    for (let j = i + 1; j < LINES.length; j++) {
      if (/^ {2}\},?\s*$/.test(LINES[j])) { block.end = j; break; }
      if (/^\s*\.\.\.i18n\.en,\s*$/.test(LINES[j])) { if (block.spread < 0) block.spread = j; continue; }
      if (block.firstKey < 0 && /^\s*(?:'[^']+'|"[^"]+"|[A-Za-z_$][\w$]*)\s*:/.test(LINES[j])) block.firstKey = j;
    }
    assert.ok(block.end > 0, `unterminated language block: ${block.lang}`);
    blocks.push(block);
  }
  return blocks;
}

test('i18n.js declares at least the shipped languages', () => {
  const langs = languageBlocks().map(b => b.lang);
  for (const expected of ['it', 'en', 'ko', 'ja', 'zh']) {
    assert.ok(langs.includes(expected), `missing language block: ${expected}`);
  }
});

test('every ...i18n.en spread comes before the translations it falls back for', () => {
  for (const b of languageBlocks()) {
    if (b.spread < 0) continue;               // it/en carry no spread
    assert.ok(
      b.firstKey < 0 || b.spread < b.firstKey,
      `${b.lang}: ...i18n.en is on line ${b.spread + 1}, after a translation on line ${b.firstKey + 1}. ` +
      'Everything above the spread is silently replaced by English. Move the spread to the top of the block.',
    );
  }
});

test('no language block repeats the ...i18n.en spread', () => {
  for (const b of languageBlocks()) {
    const spreads = LINES.slice(b.start, b.end).filter(l => /^\s*\.\.\.i18n\.en,\s*$/.test(l)).length;
    assert.ok(spreads <= 1, `${b.lang}: ${spreads} ...i18n.en spreads in one block`);
  }
});
