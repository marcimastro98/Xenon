// The artwork box said "No Media" while media was playing.
//
// Reported on Discord with a screenshot: the Playback tile showing BRAVE,
// "Nirvana - Smells Like Teen Spirit", a live position and working transport
// buttons — and, where the cover goes, the words "No Media". The source simply
// published no artwork; everything else about the session was there.
//
// The label is behind .media-art and CSS hides it the moment a cover loads
// (.media-art.has-image .media-placeholder { display: none }), so it says
// exactly one thing: this track has no picture. "No Media" claimed something
// else entirely, and it was a bare English string in the markup — the only one
// in that panel with no data-i18n, so it stayed English in all eleven languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../components/MediaPanel/MediaPanel.css', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

test('the artwork placeholder talks about the artwork, not about the media', () => {
  const m = HTML.match(/<div class="ph-label"[^>]*>([^<]*)<\/div>/);
  assert.ok(m, 'the placeholder label exists');
  assert.doesNotMatch(m[1], /no media/i,
    'it must not claim nothing is playing — it shows while a track plays without a cover');
});

test('and it is translated rather than hardcoded English', () => {
  const m = HTML.match(/<div class="ph-label"([^>]*)>/);
  assert.ok(m, 'the placeholder label exists');
  assert.match(m[1], /data-i18n="media_no_art"/, 'it goes through the i18n engine');

  const found = new Set();
  let current = null;
  for (const line of I18N.split('\n')) {
    const ns = line.match(/^ {2}"?([a-z]{2})"?: \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
    if (ns) current = ns[1];
    const t = line.trimStart();
    if (t.startsWith('media_no_art:') || t.startsWith('"media_no_art":')) found.add(current);
  }
  const missing = LANGS.filter((l) => !found.has(l));
  assert.deepEqual(missing, [], `media_no_art missing from: ${missing.join(', ')}`);
});

// The claim the label makes is only true because the cover hides it. If that
// rule ever goes, the text becomes a lie in the other direction — a cover on
// screen with "no artwork" written under it.
test('a loaded cover hides the label', () => {
  assert.match(CSS, /\.media-art\.has-image \.media-placeholder\s*\{\s*display:\s*none/,
    'the placeholder is hidden once artwork is there');
});
