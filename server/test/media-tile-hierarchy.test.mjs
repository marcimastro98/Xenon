import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// On a wide, short tile — the shape every tile has on a Xeneon Edge — the Media
// tile used to lay its four pieces out in a single queue: cover, source chip,
// title, transport, all on one baseline. Nothing read as primary, the source
// chip sat as a peer of the track title and shoved it rightwards, and the
// transport was marooned across a gap. Reported as "non hanno una gerarchia e si
// susseguono uno dopo l'altro".

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(__dirname, '..', 'components', 'MediaPanel', 'MediaPanel.css'), 'utf8');

// The one container step this is about: short enough to lay out sideways, wide
// enough to have somewhere to lay out.
const BAND = '@container mediatile (max-height: 300px) and (min-width: 430px)';

function band() {
  const at = CSS.indexOf(BAND);
  assert.ok(at > 0, 'the wide-short container step is gone');
  // Rules inside a @container block are nested one level, so the block ends at
  // the first closing brace in column 0.
  const end = CSS.indexOf('\n}', at);
  assert.ok(end > at, 'could not delimit the container step');
  return CSS.slice(at, end);
}

test('the wide-short tile is two blocks, not four things in a row', () => {
  const b = band();
  assert.match(b, /\.media-content \{[^}]*display: grid;/);
  assert.match(b, /grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.ok(!/flex-direction: row/.test(b), 'the old single-row strip must be gone');
});

test('the text column reads top-down in the order it should be read', () => {
  const b = band();
  // source above, then title, then artist, then the per-app volume — the same
  // order the tall tile already uses, turned on its side.
  assert.match(b, /\.media-app-row\s+\{ grid-column: 1; grid-row: 1;/);
  assert.match(b, /\.media-textblock \{ grid-column: 1; grid-row: 2;/);
  assert.match(b, /\.media-volume\s+\{ grid-column: 1; grid-row: 3;/);
  // The transport is its own block on the right, against the whole column.
  assert.match(b, /\.media-actions\s+\{ grid-column: 2; grid-row: 1 \/ -1; justify-self: end;/);
});

test('a hidden chip or volume collapses instead of leaving a hole', () => {
  // Both are hidden at some sizes and when there is no matching audio session.
  assert.match(band(), /grid-template-rows: auto auto auto;/);
});

test('the source chip is an eyebrow, not a badge competing with the title', () => {
  assert.match(band(), /\.app-pill \{ height: 22px;[^}]*font-size: 10px; \}/);
});

test('the cover may use the height the text column no longer needs', () => {
  // The global cap is 44cqh so a short tile cannot clip a square cover; with the
  // text beside it now a compact three-row block, that cap was the only thing
  // holding the row short and left the bottom third of a wide tile empty.
  assert.match(CSS, /width: min\(34cqw, 44cqh, 170px\);/);          // still the global rule
  assert.match(band(), /\.media-art \{ width: min\(34cqw, 62cqh, 170px\); \}/);
});

test('every one of these changes is scoped to that one container step', () => {
  // The tall and narrow tiles were not the complaint and must not move. If any
  // of this leaks out of the band, this test is how we find out.
  const b = band();
  const outside = CSS.slice(0, CSS.indexOf(BAND)) + CSS.slice(CSS.indexOf(BAND) + b.length);
  for (const needle of ['grid-template-columns: minmax(0, 1fr) auto', 'grid-row: 1 / -1', '62cqh']) {
    assert.ok(!outside.includes(needle), `"${needle}" leaked outside the wide-short step`);
  }
});
