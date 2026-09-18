import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// The active face's icon — the second icon on a key.
//
// "A deck key can already carry two faces" was the standing answer to "is it
// possible to assign two icons to a single button and toggle between them". It
// was not quite true: the active face's icon was a bare string capped at
// ICON_MAX.emoji, rendered with textContent, and offered in the editor as a
// text box with an `e.g. 🔴` placeholder. Two EMOJI on one key, not two icons.
// Asked again as "is this feature active? I cannot find it" — the field was both
// in a different tab than described and narrower than described.
//
// It now takes what the base face takes: a built-in vector, an uploaded picture
// or an emoji, through the same normalizeIcon and the same renderer.

const require = createRequire(import.meta.url);
const dm = require('../js/deck-model.js');
const DECK = readFileSync(new URL('../js/deck.js', import.meta.url), 'utf8');
const EDITOR = readFileSync(new URL('../js/deck-editor.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

const face = (icon) => dm.normalizeDeckConfig({
  profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [
    { id: 'k', kind: 'action', state: { source: 'scriptState', name: 'x' }, stateStyle: { icon } },
  ] }] } }],
}).profiles[0].root.pages[0].keys[0].stateStyle;

test('the active face takes a built-in vector icon', () => {
  assert.deepEqual(face({ type: 'builtin', value: 'power' }), { icon: { type: 'builtin', value: 'power' } });
});

test('…an uploaded picture, always as the compact kind', () => {
  // The other fits turn the whole cap into the picture. Flipping a key into and
  // out of that on every state change is a layout change, not an icon swap, so
  // the stored value says 'small' rather than the renderer quietly ignoring it.
  const f = face({ type: 'image', value: 'data:image/png;base64,AAA', fit: 'cover' });
  assert.deepEqual(f.icon, { type: 'image', value: 'data:image/png;base64,AAA', fit: 'small' });
});

test('…and an emoji, which is what it always took', () => {
  assert.deepEqual(face({ type: 'emoji', value: '🔴' }), { icon: { type: 'emoji', value: '🔴' } });
});

test('a face saved before this keeps working', () => {
  // Bare strings sit in every saved profile and inside every shared profile code.
  assert.deepEqual(face('🎧'), { icon: { type: 'emoji', value: '🎧' } });
  assert.equal(face(''), undefined, 'and an empty one is still nothing at all');
});

test('a hostile image value is dropped, not stored', () => {
  assert.equal(face({ type: 'image', value: 'javascript:alert(1)' }), undefined);
  assert.equal(face({ type: 'image', value: '' }), undefined);
});

test('the renderer builds the active icon with the same code as the base one', () => {
  const at = DECK.indexOf('function fillGlyphIcon(');
  assert.ok(at > 0, 'a shared builder, not a second copy that supports only text');
  const body = DECK.slice(at, DECK.indexOf('\n  }', at));
  assert.match(body, /is-builtin/);
  assert.match(body, /is-img-small/);
  assert.match(body, /safeIconSrc\(icon\.value\)/, 'an image value still goes through the URL guard');
});

test('only an emoji is ever printed as text', () => {
  // Without the type test, a value that failed to render was written onto the cap
  // as a word — an unknown built-in id, or a rejected `javascript:` URL.
  const at = DECK.indexOf('function fillGlyphIcon(');
  const body = DECK.slice(at, DECK.indexOf('\n  }', at));
  assert.match(body, /const text = \(type === 'emoji'/);
  assert.match(body, /if \(!text\) return false;/, 'and nothing renderable means: keep the base face');
});

test('an unrenderable active icon restores the base face instead of blanking the key', () => {
  const at = DECK.indexOf('function applyStateStyle(');
  const body = DECK.slice(at, DECK.indexOf('\n  }', at));
  assert.match(body, /if \(!fillGlyphIcon\(base\.ico, ss\.icon\)\)/);
  assert.match(body, /base\.ico\.className = base\.iconClass;/);
  // …and the normal restore has to put the classes back too, or a built-in SVG
  // returns without `is-builtin` and is sized as a bare glyph.
  assert.match(body, /base\.ico\.className = base\.iconClass \|\| 'deck-ico';/);
});

test('the editor offers the real picker, trimmed to a glyph', () => {
  assert.match(EDITOR, /const ssIconPicker = buildIconPicker\(ssExisting, null, \{ glyphOnly: true \}\);/);
  // glyphOnly hides what belongs to the KEY rather than to one of its faces.
  const at = EDITOR.indexOf('const glyphOnly =');
  assert.ok(at > 0);
  assert.match(EDITOR, /if \(glyphOnly\) \{ imageFit = 'small'; fitField\.style\.display = 'none'; \}/);
  assert.match(EDITOR, /if \(glyphOnly\) \{ colField\.style\.display = 'none'; sizeField\.style\.display = 'none'; \}/);
});

test('an untouched picker does not save an icon nobody chose', () => {
  // read() always answers with a shaped object, emoji-with-no-value included.
  assert.match(EDITOR, /const ssIcon = ssIconPicker\.read\(\);\s*\n\s*if \(ssIcon && ssIcon\.value\) ss\.icon = ssIcon;/);
});

test('the editor no longer promises emoji in every language', () => {
  const hints = [...I18N.matchAll(/deck_statestyle_hint: '((?:[^'\\]|\\.)*)'/g)].map(m => m[1]);
  assert.equal(hints.length, 11, 'the hint is translated everywhere');
  for (const h of hints) {
    assert.ok(!/^Emoji|^Émoji|^绝|^Эмодзи/.test(h), 'a hint still leads with "emoji": ' + h);
  }
});
