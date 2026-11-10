// Widget SDK `topbarButton` (js/sdk-topbar-button.js + custom-widget.js) and the
// bar kept in view on Settings → Top bar (js/settings-bar-preview.js). What a
// user would notice if it broke: a widget putting a button on the bar without
// asking, a placed widget button that comes back in the wrong spot or forces
// itself shown, a removed widget whose button stays in the list, or a Settings
// page that hides the very bar it is changing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sdk = require('../sdk-widgets.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function fnSource(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, signature);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('no closing brace: ' + signature);
}

const SETTINGS = read('../js/settings.js');
const SERVER = read('../server.js');
const clientActions = Function('return (' + fnSource(SETTINGS, 'function normalizeTopbarActions(value)') + ')')();
const serverActions = Function(
  SERVER.slice(SERVER.indexOf('const TOPBAR_ALWAYS_SHOWN'), SERVER.indexOf('function normalizeTopbarActions(value)'))
  + '\nreturn (' + fnSource(SERVER, 'function normalizeTopbarActions(value)') + ')',
)();
const without = Function('return (' + fnSource(SETTINGS, 'function withoutSdkTopbarButtons(settings, pkgIds)') + ')')();

test('the manifest asks for a bar button only with the exact true literal', () => {
  const m = (extra) => sdk.normalizeManifest({ api: 1, name: 'X', ...extra }, 'w1').manifest;
  assert.equal(m({}).topbarButton, false);
  assert.equal(m({ topbarButton: true }).topbarButton, true);
  assert.equal(m({ topbarButton: 'true' }).topbarButton, false);
  assert.equal(m({ topbarButton: 1 }).topbarButton, false);
  // A button the user placed must answer with no tile on screen.
  assert.equal(m({ topbarButton: true, background: true }).background, true);
  assert.equal(m({ background: true }).background, false);
});

test('a placed widget button keeps its place and side, in both normalizers', () => {
  const list = [
    { id: 'search', side: 'right', hidden: false },
    { id: 'sdk:my-timer', side: 'right', hidden: true },
    { id: 'lock', side: 'left', hidden: false },
  ];
  for (const norm of [clientActions, serverActions]) {
    const out = norm(list);
    assert.deepEqual(out.slice(0, 3).map((a) => a.id), ['search', 'sdk:my-timer', 'lock']);
    assert.deepEqual(out[1], { id: 'sdk:my-timer', hidden: true, side: 'right' });
    // Built-in buttons are all still there, Settings and Layout shown.
    for (const id of ['settings', 'layout']) assert.equal(out.find((a) => a.id === id).hidden, false);
  }
  assert.deepEqual(clientActions(list), serverActions(list));
});

test('bad widget ids are dropped and the list cannot grow past 8 of them', () => {
  const list = [
    { id: 'sdk:' }, { id: 'sdk:A' }, { id: 'sdk:<img>' }, { id: 'sdkx:abc' },
    ...Array.from({ length: 12 }, (_, i) => ({ id: 'sdk:pkg-' + i, side: 'left' })),
    { id: 'sdk:pkg-0', side: 'right' },
  ];
  for (const norm of [clientActions, serverActions]) {
    const sdkIds = norm(list).filter((a) => a.id.startsWith('sdk:')).map((a) => a.id);
    assert.equal(sdkIds.length, 8);
    assert.ok(sdkIds.every((id) => /^sdk:pkg-\d+$/.test(id)));
    assert.equal(new Set(sdkIds).size, sdkIds.length);
  }
});

test('removing a widget takes its button out of the list and its look', () => {
  const settings = {
    topbarClock: { align: 'center', actions: [{ id: 'sdk:a', side: 'left' }, { id: 'lock', side: 'left' }, { id: 'sdk:b', side: 'right' }] },
    topbarLook: { surface: 'solid', buttons: { 'sdk:a': { label: 'A' }, 'sdk:b': { label: 'B' }, lock: { label: 'L' } } },
  };
  const out = without(settings, ['a']);
  assert.deepEqual(out.topbarClock.actions.map((x) => x.id), ['lock', 'sdk:b']);
  assert.equal(out.topbarClock.align, 'center');
  assert.deepEqual(Object.keys(out.topbarLook.buttons).sort(), ['lock', 'sdk:b']);
  assert.equal(out.topbarLook.surface, 'solid');
  // Both uninstall paths use it.
  assert.match(read('../js/installed-manager.js'), /withoutSdkTopbarButtons\(hubSettings, \[pkg\.id\]\)/);
  assert.match(read('../js/preset-share.js'), /withoutSdkTopbarButtons\(HS\(\), widgetDeleteIds\)/);
});

test('the bar draws the button itself: text only, no widget markup', () => {
  const src = read('../js/sdk-topbar-button.js');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function/);
  assert.match(src, /btn\.setAttribute\('data-tb-id', idOf\(pkgId\)\)/);
  assert.match(src, /const MAX_OWNERS = 4;/);
  // The sweep stops when no button is left.
  assert.match(src, /clearInterval\(sweepTimer\)/);
  const cw = read('../js/custom-widget.js');
  assert.match(cw, /if \(!pkg \|\| pkg\.topbarButton !== true \|\| !grant\.topbarButton\) return;/);
  assert.match(cw, /d\.type === 'topbarButton'/);
  assert.match(cw, /\(pkg\.topbarButton === true && !g\.topbarButton\)/);
  assert.match(cw, /addSection\('cw_perm_topbar_button'/);
  const index = read('../index.html');
  assert.ok(index.indexOf('src="js/sdk-topbar-button.js"') > index.indexOf('src="js/sdk-mini.js"'));
});

test('the permission strings exist in all 11 languages', () => {
  const i18n = read('../js/i18n.js');
  for (const key of ['cw_perm_topbar_button', 'cw_perm_topbar_button_val', 'cw_perm_background_topbar_button']) {
    assert.equal((i18n.match(new RegExp('\\n  ' + key + ': ', 'g')) || []).length, 11, key);
  }
});

test('Settings → Top bar keeps the real bar in view and lets go of it after', () => {
  const src = read('../js/settings-bar-preview.js');
  assert.match(src, /const PAGE = 'island';/);
  assert.match(src, /tm\.holdRails\(on\)/);
  assert.match(src, /resizeObs\.disconnect\(\)/);
  assert.match(src, /attributeFilter: \['hidden'\]/);
  assert.match(SETTINGS, /if \(window\.SettingsBarPreview\) SettingsBarPreview\.page\(cat\);/);
  const tm = read('../js/topbar-minimal.js');
  assert.match(tm, /if \(!active \|\| !autoHideEnabled\(\) \|\| railsHeld\) return;/);
  const css = read('../components/SettingsModal/SettingsModal.css');
  assert.match(css, /body\.settings-bar-preview \.settings-overlay \{\n\s*padding: var\(--sbp-top/);
  assert.match(css, /pointer-events: none;/);
});
