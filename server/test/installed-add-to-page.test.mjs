import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Installed list reads /sdk/widgets fresh, while CustomWidget.addToPage only
// knows the package list it fetched at page load. A widget folder dropped in
// after that was listed with an "Add to page" button that did nothing and said
// nothing. These lock the fix: refresh once and retry, and say so when it still
// fails, in every language the app ships.

const ui = readFileSync(new URL('../js/installed-manager.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

function addHandler() {
  const start = ui.indexOf("t('settings_sdk_add_page'");
  assert.ok(start > 0, 'the Add to page button is still built here');
  return ui.slice(start, ui.indexOf('btns.appendChild(add)', start));
}

test('a miss refreshes the package list and tries again', () => {
  const h = addHandler();
  const first = h.indexOf('CustomWidget.addToPage(row.pkg.id)');
  const refresh = h.indexOf('await CustomWidget.refreshPackages()');
  const retry = h.indexOf('CustomWidget.addToPage(row.pkg.id)', refresh);
  assert.ok(first > 0 && refresh > first && retry > refresh, 'addToPage, then refresh, then addToPage again');
});

test('a tap that still places nothing tells the user', () => {
  assert.match(addHandler(), /toast\(t\('settings_sdk_add_page_failed'[^)]*\)[^;]*'error'\)/);
});

test('the failure message exists in all 11 languages', () => {
  assert.equal((i18n.match(/^\s*settings_sdk_add_page_failed: "[^"]+",\r?$/mg) || []).length, 11);
  assert.equal((i18n.match(/^\s*settings_sdk_added_page: /mg) || []).length, 11);
});
