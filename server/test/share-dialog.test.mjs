import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom, settle, windowKeys } from './mini-dom.mjs';
import { appStringsSource } from './i18n-source.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(HERE, '..', 'js', name), 'utf8');
const SRC = read('dialog-focus.js') + read('preset-share.js');

// The share window opened through its real door: what the keys say and where they stand.
// One main key on screen, last in its row, and what else can happen to the file as a list.

function rig() {
  const { document, descendants, matches } = makeDom();
  document.readyState = 'complete';
  const window = { location: { origin: 'http://127.0.0.1:3030', hash: '', pathname: '/', search: '' }, ShareCard: { open() {} } };
  const keys = windowKeys(window);
  vm.runInNewContext(SRC, {
    window, document, location: window.location, history: { replaceState() {} }, navigator: {},
    TextEncoder, TextDecoder, btoa, atob, URL, setTimeout, clearTimeout, console,
  });
  const all = (selector) => descendants(document.body).filter((n) => matches(n, selector));
  const press = (key) => keys.slice().forEach((fn) => fn({ key, preventDefault() {}, stopPropagation() {} }));
  return { all, press, share: window.PresetShare };
}
const labels = (keys) => keys.map((k) => k.textContent);
// On screen: the lock form keeps its own main key while it is folded away.
const mainKeys = (r) => r.all('.settings-btn').filter((k) => k.classList.contains('primary') && k.offsetParent);

test('the link is the main key, last in its row', async () => {
  const r = rig();
  await r.share.exportTheme();
  await settle();
  const row = r.all('.preset-modal-actions')[0];
  const keys = [...row.children];
  assert.deepEqual(labels(keys), ['Download file', 'Copy link']);
  assert.equal(keys[1].classList.contains('primary'), true);
  assert.equal(mainKeys(r).length, 1);
});

test('what else can happen to it is a list under the keys', async () => {
  const r = rig();
  await r.share.exportTheme();
  await settle();
  const rows = r.all('.preset-more-row');
  assert.equal(rows.length, 3);
  rows.forEach((row) => assert.equal(row.classList.contains('primary'), false));
});

test('with the lock form open its key is the only main one, and closing it gives the link back', async () => {
  const r = rig();
  await r.share.exportTheme();
  await settle();
  const toggle = r.all('.preset-lock-toggle')[0];
  toggle.click();
  assert.deepEqual(labels(mainKeys(r)), ['Generate codes']);
  toggle.click();
  assert.deepEqual(labels(mainKeys(r)), ['Copy link']);
});

test('Esc closes the window, and the window can be read as one', async () => {
  const r = rig();
  await r.share.exportTheme();
  await settle();
  const modal = r.all('.preset-modal')[0];
  assert.equal(modal.getAttribute('role'), 'dialog');
  assert.equal(modal.getAttribute('aria-modal'), 'true');
  assert.equal(modal.getAttribute('aria-labelledby'), r.all('.preset-modal-title')[0].id);
  r.press('Escape');
  assert.equal(r.all('.preset-modal-overlay').length, 0);
});

test('the export list carries no tag beside each row', () => {
  const r = rig();
  r.share.openExport();
  assert.ok(r.all('.export-pick-row').length >= 8);
  assert.equal(r.all('.preset-modal-kind').length, 0);
});

test('a key opens with its word, in every language', () => {
  const src = appStringsSource();
  for (const key of ['preset_publish', 'sharecard_open', 'preset_lock_toggle', 'preset_cancel']) {
    const values = [...src.matchAll(new RegExp(`["']?\\b${key}["']?:\\s*(['"])(.*?)\\1`, 'g'))].map((m) => m[2]);
    assert.ok(values.length >= 11, `${key} in all 11 languages`);
    values.forEach((value) => assert.doesNotMatch(value, /\p{Extended_Pictographic}/u, key));
  }
});
