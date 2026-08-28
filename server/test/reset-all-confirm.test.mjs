// "i resetted xenon by error and lost everything"
//
// Reported on Discord by a supporter, as an aside while debugging something
// else. The footer's "Reset all settings" fired on a single click — no dialog —
// from the accent-coloured PRIMARY slot at the bottom of the settings panel,
// immediately below "Restart Xenon", whose hint promises in so many words that
// nothing will be lost. The harmless button was confirmed; the destructive one
// was not.
//
// And "settings" is not what it takes. The layout and the calendar feeds
// survive. Every tile's widget ASSIGNMENT and permission grant, every install
// receipt, every saved page preset, every custom theme, background and Ambient
// scene do not — which is why the person who pressed it described the result as
// losing everything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SETTINGS = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

const RESET = (() => {
  const start = SETTINGS.indexOf('async function resetAllSettings()');
  assert.ok(start > 0, 'resetAllSettings is awaitable — a dialog has to be waited for');
  return SETTINGS.slice(start, SETTINGS.indexOf('\n}', start));
})();

test('the reset asks before it runs', () => {
  assert.match(RESET, /settings_reset_all_confirm/, 'it asks with its own message');
  assert.match(RESET, /if \(!ok\) return;/, 'and answering no does nothing');
  // The ask must come first: a confirm evaluated after the write is decoration.
  assert.ok(RESET.indexOf('if (!ok) return;') < RESET.indexOf('normalizeSettings'),
    'nothing is written before the answer');
});

// The Xeneon Edge WebView is why settingsPrompt exists at all — but a browser
// with no such helper must still get asked, not silently reset.
test('a surface without the in-app dialog still gets a question', () => {
  assert.match(RESET, /window\.confirm/, 'there is a fallback');
  assert.match(RESET, /typeof window\.confirm !== 'function' \|\| window\.confirm\(msg\)/,
    'and it only proceeds unasked where nothing can ask');
});

// A dialog that opens with the destructive button focused is one keypress from
// doing the thing it is asking about.
test('the destructive confirm is styled and focused as destructive', () => {
  const fn = SETTINGS.slice(SETTINGS.indexOf('function settingsPrompt(opts)'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /o\.danger === true \? 'settings-btn danger' : 'settings-btn primary'/,
    'danger mode dresses the confirm as destructive');
  assert.match(body, /\(o\.danger === true \? cancel : ok\)\.focus\(\)/,
    'and opens with Cancel focused');
  assert.match(RESET, /danger: true/, 'the reset asks in danger mode');
});

test('the button no longer wears the inviting colour, and says what it takes', () => {
  const btn = HTML.match(/<button[^>]*onclick="resetAllSettings\(\)"[^>]*>/);
  assert.ok(btn, 'the button is still there');
  assert.doesNotMatch(btn[0], /settings-btn primary/, 'not the primary slot');
  assert.match(btn[0], /settings-btn danger/, 'the destructive one');
  // Its neighbour has carried a hint since it was added; this one is the button
  // that actually needed one.
  const after = HTML.slice(HTML.indexOf(btn[0]) + btn[0].length);
  assert.match(after.slice(0, 400), /data-i18n="settings_reset_all_hint"/,
    'a hint sits under it, like the restart button above');
});

test('both sentences exist in every language the app ships', () => {
  for (const key of ['settings_reset_all_confirm', 'settings_reset_all_hint']) {
    const found = new Set();
    let current = null;
    for (const line of I18N.split('\n')) {
      const ns = line.match(/^ {2}"?([a-z]{2})"?: \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
      if (ns) current = ns[1];
      const t = line.trimStart();
      if (t.startsWith(key + ':') || t.startsWith('"' + key + '":')) found.add(current);
    }
    const missing = LANGS.filter((l) => !found.has(l));
    assert.deepEqual(missing, [], `${key} missing from: ${missing.join(', ')}`);
  }
});

// The one thing the message must not do is repeat the button's own label back at
// the user. It exists to name the parts of "everything" that go — the question,
// what survives, what does not, and that it is final. Counted in sentences and
// not in characters: the CJK translations say all of it in a third of the length,
// and a length floor would have failed them for being efficient.
test('the message names what is lost, not just that something is', () => {
  let seen = 0;
  for (const m of I18N.matchAll(/settings_reset_all_confirm"?:\s*("(?:[^"\\]|\\.)*")/g)) {
    seen++;
    const text = JSON.parse(m[1]);
    const sentences = (text.match(/[.?!\u3002\uff1f\uff01]/g) || []).length;
    assert.ok(sentences >= 3, 'a one-line confirm cannot list what goes: ' + text.slice(0, 40));
  }
  assert.equal(seen, 11, 'every language was checked');
});
