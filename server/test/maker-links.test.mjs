import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appStringsSource } from './i18n-source.mjs';

// The Maker is reached from the places where people look for things to install or
// change. These are browser files, so the check reads the source.
const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const MAKER_URL = 'https://xenon-app.com/maker/';

test('Settings links the Maker beside Themes, Background and Ambient', () => {
  const html = read('index.html');
  const row = (marker) => {
    const at = html.indexOf(marker);
    assert.ok(at > 0, 'missing ' + marker);
    return html.slice(Math.max(0, at - 600), at);
  };
  for (const marker of ['data-i18n="settings_theme_manage"', 'data-i18n="settings_bg_code_import"', 'data-i18n="ambient_import_code"']) {
    assert.ok(row(marker).includes(`href="${MAKER_URL}"`), 'no Maker link before ' + marker);
  }
});

test('the Store and the Deck profile menu link the Maker in a new window', () => {
  for (const file of ['js/community-gallery.js', 'js/deck.js']) {
    const src = read(file);
    assert.ok(src.includes(`const MAKER_URL = '${MAKER_URL}'`), file);
    assert.match(src, /maker\.href = MAKER_URL; maker\.target = '_blank'; maker\.rel = 'noopener noreferrer'/, file);
    assert.ok(src.includes("'ambient_create_maker'"), file);
  }
});

test('every app language has the link label', () => {
  const i18n = appStringsSource();
  assert.equal(i18n.match(/ambient_create_maker:/g).length, 11);
});
