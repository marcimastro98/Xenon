import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const DOC = readFileSync(join(__dirname, '..', '..', 'docs', 'WIDGET_SDK.md'), 'utf8');
// v4.11.8 gave the user a date format (Settings → Clock → Date format). The
// time format beside it has reached widgets through the theme bridge since
// v4.11.7 and is re-pushed on change; the date format has to travel the same
// way, or a widget printing a date is the one thing on screen still spelling
// out "Friday, 11 September" next to a dashboard set to "Fri 11 Sep".

test('the theme payload carries the date format on both shapes', () => {
  const src = read('js', 'custom-widget.js');
  const fn = src.slice(src.indexOf('function themePayload('), src.indexOf('function langCode('));
  assert.match(fn, /const dateFormat = \(typeof clockDateShape === 'function'\)/);
  // Two return paths (full palette / legacy flat). A field on only one is a
  // field a widget cannot rely on.
  assert.equal((fn.match(/dateFormat/g) || []).length >= 3, true, 'dateFormat must be on both theme shapes');
  assert.match(fn, /clock12, dateFormat, \.\.\.palette/);
});

test('changing the date format re-pushes the theme to live widgets', () => {
  const src = read('js', 'settings.js');
  const fn = src.slice(src.indexOf('function updateClockDateFormat('), src.indexOf("setSettingsStatus('settings_saved', 'ok');\n}", src.indexOf('function updateClockDateFormat(')));
  assert.ok(fn.includes('CustomWidget.refreshTheme'), 'updateClockDateFormat must re-push the theme');
  // The time format beside it already does; they must not drift apart.
  const sib = src.slice(src.indexOf('function updateClockFormat('));
  assert.ok(sib.includes('CustomWidget.refreshTheme'));
});

test('the guide documents theme.dateFormat as a shape name, not a string', () => {
  const sec = DOC.slice(DOC.indexOf('clock12: false,'), DOC.indexOf('overrides: ['));
  assert.match(sec, /dateFormat: 'full'/);
  assert.match(sec, /Intl\.DateTimeFormat/);
});
