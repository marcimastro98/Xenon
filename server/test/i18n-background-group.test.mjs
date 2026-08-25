// The "Media background" settings group, translated in every language.
//
// Reported on Discord, and worth writing down because the failure mode is not
// the obvious one. A user on a SPANISH dashboard was told "Settings →
// Background" to put a GIF behind Ambient mode. He went to the right page, and
// answered: "I don't see the location. Is it one of those two?" — with a
// screenshot of that very page. Everything around the row was Spanish; the one
// row that uploads a wallpaper read "Media background / Upload image, GIF or
// video", because the whole group had shipped English-only in es, fr, de, pt
// and ru (and nl, which was also missing the SVG-paste dialog).
//
// A key with no translation is not a blank — t() falls back to English, so it
// renders perfectly and looks deliberate. That is exactly why it survived: it
// is invisible to anyone testing in Italian or English, and it makes a feature
// unfindable for everyone else. Hence a test rather than a fix alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

// Every key the group renders: the heading and upload row, the two sliders that
// sit with it, the status line after a save, and the SVG-paste dialog it opens.
const KEYS = [
  'settings_background_media', 'settings_bg_upload', 'settings_bg_upload_hint',
  'settings_bg_image_loaded', 'settings_bg_video_loaded', 'settings_bg_clear',
  'settings_bg_uploading', 'settings_bg_uploaded', 'settings_bg_upload_failed',
  'settings_bg_converted', 'settings_bg_convert_missing', 'settings_bg_convert_failed',
  'settings_bg_unsupported', 'settings_bg_video_failed', 'settings_bg_too_large',
  'settings_bg_removed', 'settings_bg_dim', 'settings_bg_blur',
  'settings_bg_blur_note_empty', 'settings_bg_blur_note_active',
  'settings_background_covered',
  'svg_paste', 'svg_paste_title', 'svg_paste_insert', 'svg_paste_cancel',
  'svg_paste_hint', 'svg_paste_invalid',
];

/** Which languages define `key`, walking the file and tracking the namespace. */
function langsDefining(key) {
  // Keys share lines here (`a: 'x', b: 'y'`), so match the key ANYWHERE on the
  // line, not just at its start — a start-anchored scan under-reports and turns
  // this into a test that fails on strings which are actually present.
  const re = new RegExp(`(^|[\\s{,])${key}\\s*:`);
  const found = new Set();
  let current = null;
  for (const line of I18N.split('\n')) {
    const ns = line.match(/^ {2}([a-z]{2}): \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
    if (ns) current = ns[1];
    if (re.test(line)) found.add(current);
  }
  return found;
}

test('every string in the background group is translated in every language', () => {
  const gaps = [];
  for (const key of KEYS) {
    const have = langsDefining(key);
    const missing = LANGS.filter((l) => !have.has(l));
    if (missing.length) gaps.push(`${key} → ${missing.join(', ')}`);
  }
  assert.deepEqual(gaps, [], `untranslated, so these fall back to English:\n  ${gaps.join('\n  ')}`);
});

// The group is only findable by its heading, so the heading must be wired to a
// key rather than hard-coded Italian in the markup.
test('the group heading and upload row carry their keys', () => {
  // The GROUP, not the sidebar button — both carry data-settings-cat="background".
  const group = HTML.slice(HTML.indexOf('class="settings-group settings-bg-group"'));
  const body = group.slice(0, group.indexOf('settings-upload-sub') + 200);
  assert.match(body, /data-i18n="settings_background_media"/, 'the heading is translatable');
  assert.match(body, /data-i18n="settings_bg_upload"/, 'and so is the upload label');
});

// settings_background_media names BOTH the sidebar entry and the group heading,
// which is why leaving it untranslated hid the whole category rather than one
// row: the user was scanning a Spanish sidebar for a Spanish word.
test('the sidebar entry for the category shares that key', () => {
  const nav = HTML.slice(HTML.indexOf('class="settings-nav-btn" data-settings-cat="background"'));
  assert.match(nav.slice(0, nav.indexOf('</button>')), /data-i18n="settings_background_media"/);
});

// The formats named in the hint must be the formats the picker accepts: a hint
// that promises GIF while the dialog filters it out sends the user hunting for
// a setting that is right in front of them.
test('the accepted formats match what the hint advertises', () => {
  const at = HTML.indexOf('id="settings-bg-file"');
  const tag = HTML.slice(at, HTML.indexOf('>', at));
  for (const mime of ['image/gif', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']) {
    assert.ok(tag.includes(mime), `${mime} must be accepted by the file picker`);
  }
});
