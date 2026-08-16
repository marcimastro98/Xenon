import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The label on an Upcoming chip. It exists because the chip is a grid whose only
// flexible cell is the NAME, so whatever this returns is width the title does not
// get: an absolute "Aug 18, 08:00 AM" left ~30px for the name and every event
// read as "K…". These tests pin the two properties that make it a fix rather
// than a restyle — it stays short in every language we ship, and it counts
// CALENDAR days rather than 24h chunks.
//
// calendar.js is a browser global script, so the function is evaluated out of the
// source the app actually serves (the state-server-origin idiom).
const __dirname = dirname(fileURLToPath(import.meta.url));
// Newlines normalised: the working copy is CRLF on Windows and LF in the repo,
// and the slice below looks for a line that is exactly "}".
const SRC = readFileSync(join(__dirname, '..', 'js', 'calendar.js'), 'utf8').replace(/\r\n/g, '\n');

function loadLabel() {
  const start = SRC.indexOf('function upcomingWhenLabel(');
  assert.ok(start >= 0, 'upcomingWhenLabel declaration not found');
  const end = SRC.indexOf('\n}\n', start);
  assert.ok(end > start, 'could not find the end of upcomingWhenLabel');
  const body = SRC.slice(start, end + 2);
  return new Function(body + '; return upcomingWhenLabel;')();
}

const label = loadLabel();
const at = (s) => new Date(s).getTime();
// A Sunday 09:00, so "later today", "tonight" and "tomorrow" are all expressible.
const NOW = at('2026-08-16T09:00:00');

test('an event today shows the time, not a distance', () => {
  assert.equal(label('2026-08-16T18:30:00', NOW, 'en-GB'), '18:30');
  // The list keeps events up to a minute old; those are still "today".
  assert.equal(label('2026-08-16T08:59:30', NOW, 'en-GB'), '08:59');
});

test('later days are counted in calendar days, not 24h chunks', () => {
  // 23 hours away, but it is tomorrow to a person reading the chip.
  assert.equal(label('2026-08-17T08:00:00', at('2026-08-16T23:00:00'), 'en-GB'), '1d');
  assert.equal(label('2026-08-18T08:00:00', NOW, 'en-GB'), '2d');
  // …and a whole day away that lands on the same date is still today.
  assert.equal(label('2026-08-16T23:59:00', NOW, 'en-GB'), '23:59');
});

test('the unit grows with the distance instead of printing "in 78w"', () => {
  assert.equal(label('2026-08-29T09:00:00', NOW, 'en-GB'), '13d');
  assert.equal(label('2026-08-30T09:00:00', NOW, 'en-GB'), '2w');
  assert.equal(label('2026-10-16T09:00:00', NOW, 'en-GB'), '2m'); // 61 days
  assert.equal(label('2026-10-30T09:00:00', NOW, 'en-GB'), '3m'); // 75 days rounds up
});

// The whole point of the change: it has to be SHORT, in every language the
// dashboard ships, or the name is squeezed exactly as before. RelativeTimeFormat
// was rejected here — its narrow form is "in 2 days" in en-GB and "in 2 Tagen"
// in German, which would have fixed this for en-US only.
test('every shipped language gets a label short enough to leave the name room', () => {
  const langs = ['it', 'en-GB', 'en-US', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
  for (const loc of langs) {
    for (const iso of ['2026-08-18T09:00:00', '2026-08-30T09:00:00', '2026-10-30T09:00:00']) {
      const out = label(iso, NOW, loc);
      assert.ok(out.length > 0 && out.length <= 8, `${loc} → "${out}" (${out.length} chars)`);
    }
  }
});

test('a broken date is empty rather than "Invalid Date" across the chip', () => {
  assert.equal(label('not a date', NOW, 'en-GB'), '');
  assert.equal(label('', NOW, 'en-GB'), '');
});
