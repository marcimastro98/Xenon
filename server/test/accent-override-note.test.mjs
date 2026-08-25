// Saying so when the accent colour you picked is not the one on screen.
//
// Two things paint over it. The Pixel Retro style owns a fixed CRT palette —
// deliberately, and themes-retro.css enforces it — and the album tint follows
// the cover while music plays. In both cases the chosen colour is stored and
// kept; it is simply not what you see, so the picker looks broken and nothing
// says why. Reported as "the accent color stays yellow", which is #f5c518,
// Retro's own.
//
// The pattern is not new here: the background colour row has carried a "covered
// by an active background" note for exactly this reason. This is that note, for
// the row above.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SETTINGS = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

const KEYS = ['settings_accent_covered_retro', 'settings_accent_covered_album'];

// Every language the app ships. A note that falls back to another language is
// how `settings_background_covered` ended up showing Italian to Dutch users —
// it is missing from `nl` to this day, which is what prompted checking.
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

/** Which languages define `key`, by walking the file and tracking the namespace. */
function langsDefining(key) {
  const found = new Set();
  let current = null;
  for (const line of I18N.split('\n')) {
    const ns = line.match(/^ {2}([a-z]{2}): \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
    if (ns) current = ns[1];
    if (line.trimStart().startsWith(key + ':')) found.add(current);
  }
  return found;
}

test('both notes are translated in every language the app ships', () => {
  for (const key of KEYS) {
    const have = langsDefining(key);
    const missing = LANGS.filter((l) => !have.has(l));
    assert.deepEqual(missing, [], `${key} missing from: ${missing.join(', ')}`);
  }
});

// The picker is what the note is attached to, and it starts silent — the common
// case is a dashboard where nothing is overriding anything.
test('the note sits with the accent row and starts hidden', () => {
  const row = HTML.slice(HTML.indexOf('id="settings-accent-swatch"'), HTML.indexOf('id="settings-background-swatch"'));
  assert.match(row, /id="settings-accent-covered-note"/, 'the note belongs to the accent row');
  assert.match(row, /<span[^>]*id="settings-accent-covered-note"[^>]*\shidden[^>]*>/, 'and starts hidden');
});

// Retro must be reported FIRST. getEffectiveThemePalette applies the album tint
// and then overwrites it with the CRT palette, so under Retro the album is not
// the cause even when a tint is live — naming it would send the user to switch
// off a setting that would change nothing.
test('Retro is named before the album tint, because Retro is what wins', () => {
  const fn = SETTINGS.slice(SETTINGS.indexOf('function accentOverrideKey()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  const retroAt = body.indexOf('settings_accent_covered_retro');
  const albumAt = body.indexOf('settings_accent_covered_album');
  assert.ok(retroAt > -1 && albumAt > -1, 'both branches exist');
  assert.ok(retroAt < albumAt, 'the Retro branch must come first');
  // …and it must match the precedence the palette actually applies. Read from
  // deriveEffectiveThemePalette, which does the work — getEffectiveThemePalette
  // is only the cache in front of it and contains neither branch.
  const palette = SETTINGS.slice(SETTINGS.indexOf('function deriveEffectiveThemePalette'));
  const p = palette.slice(0, palette.indexOf('\n}'));
  assert.ok(
    p.indexOf('_dynamicAccent') < p.indexOf("styleMode === 'retro'"),
    'the palette applies the tint first and Retro over it — the note follows that order',
  );
});

// The album branch has two conditions and needs both: the feature on AND a tint
// actually live. Dropping either would show the note on a dashboard where the
// accent is exactly what the user chose.
test('the album note needs the feature on and a tint actually live', () => {
  const fn = SETTINGS.slice(SETTINGS.indexOf('function accentOverrideKey()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /dynamicAlbumTheme !== false && _dynamicAccent/);
});

// Two callers, because there are two ways the answer changes: a settings render
// (the style was switched) and a track change (the tint appeared or went away),
// and neither triggers the other.
test('the note is refreshed from both places that can change the answer', () => {
  const apply = SETTINGS.slice(SETTINGS.indexOf('function applyHubSettings()'));
  assert.match(apply.slice(0, apply.indexOf('\nfunction ')), /syncAccentOverrideNote\(\)/);
  const dyn = SETTINGS.slice(SETTINGS.indexOf('function setDynamicAccent(hex, source)'));
  assert.match(dyn.slice(0, dyn.indexOf('\n}')), /syncAccentOverrideNote\(\)/);
});

// The language can change while Settings is open, and the re-translate pass
// reads data-i18n — text alone would freeze the note in the old language.
test('the note carries its key, not just its text', () => {
  const fn = SETTINGS.slice(SETTINGS.indexOf('function syncAccentOverrideNote()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /setAttribute\('data-i18n', key\)/);
  assert.match(body, /removeAttribute\('data-i18n'\)/, 'and drops it again when nothing is overriding');
});

// Retro's accent is the yellow in the report. If that constant ever moves, the
// note explaining it should be revisited with it.
test('Retro still pins the accent that was reported', () => {
  assert.match(SETTINGS, /styleMode === 'retro'[\s\S]{0,400}accent: '#f5c518'/);
});
