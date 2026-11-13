// Bit says so when something from the Store has an update (js/store-update-mail.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { appStringsSource } from './i18n-source.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
const NOV_8 = Date.parse('2026-11-08T12:00:00Z');
// Objects made inside the page's context have its prototypes: compared as data.
const data = (v) => JSON.parse(JSON.stringify(v));

function load({ updates = [], settings = {}, catalog = { ok: true, entries: [{ id: 'any' }] } } = {}) {
  const filed = [];
  const ctx = {
    console, Date, String, Math, Number, Array, JSON, Promise, Object,
    t: (k) => k,
    hubSettings: settings,
    SERVER: 'http://pc.example:3030',
    fetch: async (url) => { ctx.asked = url; return { json: async () => catalog }; },
    setTimeout: () => 0,
    sessionStorage: { getItem: () => null, setItem() {} },
    document: { addEventListener() {} },
    BitMessages: {
      surface: 'dashboard',
      firstLine: (s) => s.split('. ')[0] + '.',
      file: async (list, live) => { filed.push({ list, live }); return true; },
    },
    CommunityGallery: { findUpdates: async () => updates },
  };
  ctx.window = ctx;
  vm.runInNewContext(read('../js/store-update-mail.js'), ctx);
  return { S: ctx.StoreUpdateMail, filed, ctx };
}

const theme = (id, version, more = {}) => ({ id, kind: 'theme', name: id.toUpperCase(), version, ...more });
const widget = (id, version, updatedAt, more = {}) => ({ id, kind: 'widget', pkgId: id, name: id, version, updatedAt, ...more });

test('one update is named, with its notes or its version, and opens Installed', () => {
  const { S } = load();
  const one = S.messageFor([theme('nocturne', '1.2.0', { changelog: 'Brighter night sky. Fixes the clock.' })]);
  assert.equal(one.kind, 'updates');
  assert.match(one.id, /^updates:[0-9a-f]{8}$/);
  assert.equal(one.title, 'settings_updates_toast_one'.replace('{name}', 'NOCTURNE'));
  assert.equal(one.line, 'Brighter night sky.');
  assert.equal(one.body, 'Brighter night sky. Fixes the clock.');
  assert.deepEqual(data(one.stamps), ['nocturne@1.2.0']);
  assert.deepEqual(data(one.action), { type: 'installed', label: 'bm_installed_open' });
  const bare = S.messageFor([theme('nocturne', '1.2.0')]);
  assert.equal(bare.line, 'gallery_fact_version 1.2.0');
  assert.equal(S.messageFor([]), null);
  assert.equal(S.messageFor([{ id: 'x' }]), null, 'no version, nothing to tell');
});

test('several updates are counted, the first three named, the list in full when opened', () => {
  const { S } = load();
  const list = ['a', 'b', 'c', 'd', 'e'].map((id) => theme(id, '2.0.0'));
  const msg = S.messageFor(list);
  assert.equal(msg.title, 'settings_updates_toast_n');
  assert.equal(msg.line, 'A, B, C +2');
  assert.equal(msg.body, 'A, B, C, D, E');
  assert.equal(S.messageFor(list.slice(0, 2)).line, 'A, B');
});

test('the id is the list: the same on every screen, new when a version is', () => {
  const { S } = load();
  const a = theme('a', '1.0.1');
  const b = theme('b', '3.0.0');
  assert.equal(S.messageFor([a, b]).id, S.messageFor([b, a]).id);
  assert.notEqual(S.messageFor([a, b]).id, S.messageFor([a, theme('b', '3.0.1')]).id);
  assert.notEqual(S.messageFor([a, b]).id, S.messageFor([a]).id);
});

test('a Store widget is left to update by itself for three days after its date', () => {
  const { S } = load();
  const on = {};
  const fresh = widget('clock', '1.1.0', '2026-11-06');
  assert.equal(S.autoTakes(fresh, NOV_8, on), true);
  assert.equal(S.autoTakes(widget('clock', '1.1.0', '2026-11-05'), NOV_8, on), false, 'still behind after three days');
  assert.equal(S.autoTakes({ ...fresh, kind: 'ambient' }, NOV_8, on), true);
  assert.equal(S.autoTakes(fresh, NOV_8, { autoUpdateWidgets: false }), false, 'the switch is off');
  assert.equal(S.autoTakes(fresh, NOV_8, { safeMode: true }), false, 'nothing updates in safe mode');
  assert.equal(S.autoTakes(theme('nocturne', '1.2.0', { updatedAt: '2026-11-07' }), NOV_8, on), false, 'only widgets update by themselves');
  assert.equal(S.autoTakes({ ...fresh, kind: 'bundle' }, NOV_8, on), false, 'a bundle with a package in it waits for the person');
  assert.equal(S.autoTakes(widget('clock', '1.1.0', 'soon'), NOV_8, on), false, 'a version with no date is never taken');
  assert.equal(S.autoTakes({ ...fresh, pkgId: '' }, NOV_8, on), false);
});

test('the check files one list, leaves out what updates by itself, and takes back a list when none is left', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { S, filed, ctx } = load({ updates: [theme('nocturne', '1.2.0'), widget('clock', '1.1.0', today)] });
  assert.ok(await S.check());
  assert.equal(ctx.asked, 'http://pc.example:3030/api/community/catalog');
  assert.equal(filed.length, 1);
  assert.deepEqual(data(filed[0].list.map((m) => m.stamps)), [['nocturne@1.2.0']]);
  assert.deepEqual(data(filed[0].live), { updates: [filed[0].list[0].id] });

  const none = load({ updates: [] });
  assert.ok(await none.S.check());
  assert.deepEqual(data(none.filed), [{ list: [], live: { updates: [] } }]);

  const offline = load({ catalog: null });
  assert.equal(await offline.S.check(), false);
  assert.deepEqual(offline.filed, [], 'offline: nothing filed, nothing taken back');
});

test('its button opens the Installed tab, on the dashboard and on the screen', () => {
  const src = read('../js/bit-messages.js');
  assert.match(src, /ON_SCREEN = \{[\s\S]*?installed: \(\) => sheet\(\{ open: 'store', kind: '__installed' \}\)/);
  assert.match(src, /ON_DASHBOARD = \{[\s\S]*?installed: \(\) => window\.CommunityGallery && window\.CommunityGallery\.open\('__installed'\)/);
});

test('the page loads it after the messages and the Store, and the old daily toast is gone', () => {
  const html = read('../index.html');
  const at = (f) => html.indexOf(`<script src="js/${f}"></script>`);
  assert.ok(at('store-update-mail.js') > at('community-gallery.js') && at('community-gallery.js') > 0);
  assert.ok(at('store-update-mail.js') > at('bit-messages.js') && at('bit-messages.js') > 0);
  assert.doesNotMatch(read('../js/settings.js'), /checkSdkUpdatesDaily/);
});

test('a widget update waiting for a permission says where it is, and opens it', () => {
  const fn = /function onAutoUpdated\(data\) \{[\s\S]*?\n  \}\n/.exec(read('../js/custom-widget.js'))[0];
  const waiting = fn.slice(fn.indexOf('if (waiting.length)'));
  assert.match(waiting, /onClick: \(\) => \{ if \(window\.CommunityGallery\) window\.CommunityGallery\.open\('__installed'\); \}/);
  const i18n = vm.runInNewContext(`${appStringsSource()}\ni18n;`, { window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null }, document: { documentElement: {} }, console });
  for (const l of LANGS) {
    assert.ok(i18n[l].widget_autoupdate_wait_sub.includes(i18n[l].gallery_tab_installed), `${l}: ${i18n[l].widget_autoupdate_wait_sub}`);
  }
});

test('its words are in all 11 languages, with no dash', () => {
  const i18n = vm.runInNewContext(`${appStringsSource()}\ni18n;`, { window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null }, document: { documentElement: {} }, console });
  for (const l of LANGS) {
    for (const k of ['bm_installed_open', 'settings_updates_toast_one', 'settings_updates_toast_n', 'gallery_fact_version']) {
      const v = i18n[l][k];
      assert.equal(typeof v, 'string', `${l}.${k} is missing`);
      assert.doesNotMatch(v, /[—–]/, `${l}.${k}: ${v}`);
      if (l !== 'en' && k !== 'gallery_fact_version') assert.notEqual(v, i18n.en[k], `${l}.${k} is still English`);
    }
    assert.match(i18n[l].settings_updates_toast_one, /\{name\}/, l);
    assert.match(i18n[l].settings_updates_toast_n, /\{n\}/, l);
  }
});
