// The Installed list says in words what a row waits on (a new version, or a
// permission), and keeps one green key per page: "Update all" when it is
// offered, otherwise the first row that waits on the person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { appStringsSource } from './i18n-source.mjs';

const SRC = readFileSync(new URL('../js/installed-manager.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

// A node is enough for what the row builds: class, text, children, listeners.
function makeEl(tag, className, text) {
  const node = {
    tag, className: className || '', textContent: text == null ? '' : String(text), children: [], type: '', disabled: false,
    appendChild(c) { node.children.push(c); return c; },
    addEventListener() {},
    all() { return node.children.flatMap((c) => [c, ...c.all()]); },
  };
  return node;
}

// needsYou, greenRow and renderRow lifted verbatim; the rest of the module stubbed.
function load({ updates = {}, ungranted = [] } = {}) {
  const body = SRC.slice(SRC.indexOf('  // What a row waits on from the person'), SRC.indexOf('  // Paint into `host`'));
  assert.ok(body.includes('function renderRow'), 'renderRow moved: update this test');
  const ctx = {
    el: makeEl,
    t: (k) => (k === 'installed_state_update' ? 'V{v}' : k === 'installed_state_allow' ? 'ALLOW' : k),
    updateFor: (row) => updates[row.pkg ? row.pkg.id : row.record.sourceId] || null,
    entryFor: () => null, thumbFor: () => makeEl('div', 'inst-thumb'), metaLine: () => '',
    ISSUE_ORIGINS: [], String,
  };
  ctx.window = ctx;
  ctx.CustomWidget = { packageGranted: (pkg) => !ungranted.includes(pkg.id) };
  vm.runInNewContext(`${body}\nthis.api = { needsYou, greenRow, renderRow };`, ctx);
  return ctx.api;
}

const pkg = (id) => ({ pkg: { id, name: id, origin: 'import' }, record: null });
const keysOf = (rowEl) => rowEl.all().filter((n) => n.tag === 'button');
const stateOf = (rowEl) => rowEl.all().find((n) => /\binst-row-state\b/.test(n.className));

test('a row with a new version says so in words, and its key just says Update', () => {
  const api = load({ updates: { clock: { version: '1.4.0' } } });
  const row = api.renderRow(pkg('clock'), {}, () => {}, true);
  assert.equal(stateOf(row).textContent, 'V1.4.0');
  assert.equal(stateOf(row).className, 'inst-row-state is-update');
  const update = keysOf(row).find((b) => b.textContent === 'settings_sdk_update');
  assert.ok(update, 'the update key is there');
  assert.equal(update.className, 'settings-btn primary');
});

test('a widget without its permissions says it stays off', () => {
  const api = load({ ungranted: ['nas'] });
  const row = api.renderRow(pkg('nas'), {}, () => {}, true);
  assert.equal(stateOf(row).textContent, 'ALLOW');
  assert.equal(stateOf(row).className, 'inst-row-state is-allow');
  assert.equal(keysOf(row).find((b) => b.textContent === 'settings_sdk_grant_btn').className, 'settings-btn primary');
});

test('a row with nothing waiting has no state line and no green key', () => {
  const api = load();
  const row = api.renderRow(pkg('ok'), {}, () => {}, false);
  assert.equal(stateOf(row), undefined);
  assert.equal(api.needsYou(pkg('ok'), {}), null);
  assert.ok(keysOf(row).every((b) => !/\bprimary\b/.test(b.className)));
});

test('a row that is not the page\'s next thing keeps its keys quiet', () => {
  const api = load({ updates: { clock: { version: '2.0.0' } }, ungranted: ['clock'] });
  const row = api.renderRow(pkg('clock'), {}, () => {}, false);
  assert.equal(stateOf(row).textContent, 'V2.0.0', 'the update is told first');
  assert.ok(keysOf(row).every((b) => !/\bprimary\b/.test(b.className)));
  const green = api.renderRow(pkg('clock'), {}, () => {}, true);
  assert.equal(keysOf(green).filter((b) => /\bprimary\b/.test(b.className)).length, 1, 'one green key on a row, the update');
});

test('one green key per page: Update all when offered, else the first row waiting', () => {
  const api = load({ updates: { b: { version: '1.1.0' } }, ungranted: ['c'] });
  const rows = [pkg('a'), pkg('b'), pkg('c')];
  assert.equal(api.greenRow(rows, {}, true), null, 'Update all is the green key');
  assert.equal(api.greenRow(rows, {}, false), rows[1]);
  assert.equal(api.greenRow([rows[0], rows[2]], {}, false), rows[2]);
  assert.equal(api.greenRow([rows[0]], {}, false), null);
});

test('the page passes the green row to renderRow and Update all stays primary', () => {
  assert.match(SRC, /const green = greenRow\(shown, cat, updatable\.length > 0\);\n\s+shown\.forEach\(\(row\) => list\.appendChild\(renderRow\(row, cat, repaint, row === green\)\)\);/);
  assert.match(SRC, /const go = el\('button', 'settings-btn primary', t\('installed_update_all'/);
});

test('its words are in all 11 languages, with no dash, and keep the version slot', () => {
  const i18n = vm.runInNewContext(`${appStringsSource()}\ni18n;`, { window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null }, document: { documentElement: {} }, console });
  for (const l of LANGS) {
    for (const k of ['installed_state_update', 'installed_state_allow']) {
      const v = i18n[l][k];
      assert.equal(typeof v, 'string', `${l}.${k} is missing`);
      assert.doesNotMatch(v, /[—–]/, `${l}.${k}: ${v}`);
      if (l !== 'en') assert.notEqual(v, i18n.en[k], `${l}.${k} is still English`);
    }
    assert.match(i18n[l].installed_state_update, /\{v\}/, l);
  }
});
