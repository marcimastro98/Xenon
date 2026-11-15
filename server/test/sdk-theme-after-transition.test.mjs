import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

// #156: --accent and --bg are registered colours that ease on :root, and the
// theme payload reads them off the widget frame. Read at the moment a theme is
// applied they still hold the old colour, so a widget kept the previous accent
// until something else re-pushed the theme. The host pushes again when the ease
// ends.

test('the accent and background still ease on :root (the reason for the re-push)', () => {
  const css = read('styles', 'global.css');
  assert.match(css, /@property --accent \{\s*syntax: '<color>'/);
  assert.match(css, /:root \{ transition: --accent [^;]*--bg [^;]*; \}/);
});

test('the theme is pushed to widgets again when the colour ease ends', () => {
  const src = read('js', 'custom-widget.js');
  const at = src.indexOf("document.documentElement.addEventListener('transitionend'");
  assert.ok(at > 0, 'custom-widget.js must listen for the end of the colour ease');
  const handler = src.slice(at, src.indexOf('});', at));
  assert.match(handler, /e\.target !== document\.documentElement/, 'only the root ease, not every tile animation');
  assert.match(handler, /'--accent'/);
  assert.match(handler, /'--bg'/);
  assert.match(handler, /refreshTheme\(\)/);
});

test('the payload is read from the frame computed style, which is what the ease delays', () => {
  const src = read('js', 'custom-widget.js');
  const fn = src.slice(src.indexOf('function themePayload('), src.indexOf('function langCode('));
  assert.match(fn, /getComputedStyle\(entry\.frame\)/);
  assert.match(fn, /accent: onTile\('--accent'/);
});
