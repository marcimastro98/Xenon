import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Four ways a community widget could end up with more than the user approved:
//   1. a frame that navigates itself away keeps its place on the bridge;
//   2. a share code replaces an installed widget and inherits its grants;
//   3. a manifest switches its shared store group under an existing grant;
//   4. a shared Deck key types text through chained one-key "hotkeys".

const require = createRequire(import.meta.url);
const sdkWidgets = require('../sdk-widgets.js');
const sdkStore = require('../sdk-store.js');
const wau = require('../widget-auto-update.js');
const PS = require('../js/preset-share.js');
const DeckModel = require('../js/deck-model.js');
const DeckActions = require('../js/deck-actions.js');
const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const CW_SRC = read('../js/custom-widget.js');

// ── 1. a frame that leaves its page ──────────────────────────────────────────

function sliceFn(src, header) {
  const start = src.indexOf(header);
  assert.ok(start >= 0, header + ' not found');
  const end = src.indexOf('\n  }\n', start);
  return src.slice(start, end + 4);
}
function loadGuard(origin) {
  const observers = [];
  // A MutationObserver stand-in: the test calls `hostSetSrc` where the page
  // would write the element's src attribute.
  class FakeObserver {
    constructor(cb) { this.cb = cb; }
    observe(target) { observers.push({ target, cb: this.cb }); }
  }
  const ctx = vm.createContext({
    URL,
    MutationObserver: FakeObserver,
    window: { location: { origin, href: origin + '/' } },
  });
  vm.runInContext(sliceFn(CW_SRC, '  function requiredFrameCsp() {') + '\n'
    + sliceFn(CW_SRC, '  function guardFrame(frame, onLeft) {')
    + '\nthis.guardFrame = guardFrame; this.requiredFrameCsp = requiredFrameCsp;', ctx);
  ctx.hostSetSrc = (frame) => observers.filter((o) => o.target === frame).forEach((o) => o.cb([]));
  return ctx;
}
function fakeFrame(src = '/sdk/widget/w/index.html?v=1') {
  const listeners = [];
  return {
    contentWindow: { id: 1 },
    getAttribute: (name) => (name === 'src' ? src : null),
    addEventListener(type, fn) { if (type === 'load') listeners.push(fn); },
    fire() { listeners.forEach((fn) => fn()); },
  };
}

test('guardFrame: the first load is the widget, a second in the same window is a new document', () => {
  const { guardFrame } = loadGuard('http://127.0.0.1:3030');
  const f = fakeFrame();
  let left = 0;
  guardFrame(f, () => { left++; });
  f.fire();
  assert.equal(left, 0, 'its own page loading is not leaving it');
  f.fire();   // same WindowProxy: location.href = 'https://…'
  assert.equal(left, 1);
  f.fire();
  assert.equal(left, 1, 'told once');
});

test('guardFrame: a tile moved to another page reloads in a NEW window and is left alone', () => {
  const { guardFrame } = loadGuard('http://127.0.0.1:3030');
  const f = fakeFrame();
  let left = 0;
  guardFrame(f, () => { left++; });
  f.fire();
  f.contentWindow = { id: 2 };   // re-inserted iframe: fresh browsing context
  f.fire();
  assert.equal(left, 0);
  f.fire();                      // ...and only then does it navigate away
  assert.equal(left, 1);
});

test('guardFrame requires the widget CSP on Chromium, with the origin where the header says self', () => {
  const { guardFrame, requiredFrameCsp } = loadGuard('http://127.0.0.1:3030');
  const f = fakeFrame();
  guardFrame(f, () => {});
  assert.equal(f.csp, requiredFrameCsp());
  const want = sdkWidgets.WIDGET_CSP.split('; ').filter((d) => !d.startsWith('sandbox'));
  const got = f.csp.split('; ');
  assert.equal(got.length, want.length, 'every directive of the served policy, nothing else');
  for (const d of want) {
    const name = d.split(' ')[0];
    const mine = got.find((g) => g.split(' ')[0] === name);
    assert.ok(mine, name);
    // Same sources, except 'self' (which in a page elsewhere would mean THAT
    // page) is spelled as this dashboard's origin.
    const norm = (s) => s.split(' ').slice(1).map((x) => (x === "'self'" ? 'http://127.0.0.1:3030' : x)).sort().join(' ');
    assert.equal(norm(mine), norm(d), name);
  }
  assert.ok(!/'self'/.test(f.csp));
  // An origin we cannot name sets no policy rather than one that refuses our own widgets.
  assert.equal(loadGuard('null').requiredFrameCsp(), '');
  // A document this server does not serve (the website demo's blob: previews,
  // with their own policy) gets none either.
  const blob = fakeFrame('blob:http://127.0.0.1:3030/1234');
  guardFrame(blob, () => {});
  assert.equal(blob.csp, undefined);
});

test('guardFrame: the host pointing the same element at a new document is not leaving', () => {
  const ctx = loadGuard('http://127.0.0.1:3030');
  const f = fakeFrame();
  let left = 0;
  ctx.guardFrame(f, () => { left++; });
  f.fire();
  ctx.hostSetSrc(f);   // the demo's live preview re-sets src on the same iframe
  f.fire();
  assert.equal(left, 0);
  f.fire();            // no write from the host this time: the widget went somewhere
  assert.equal(left, 1);
});

test('every SDK frame creator arms the guard before the frame loads', () => {
  for (const header of ['  function mountFrame(body, instId, pkg, tile) {', '  function registerAmbientFrame(pkgId, frame) {', '  function registerCanvasFrame(instId, pkgId, frame) {']) {
    assert.match(sliceFn(CW_SRC, header), /guardFrame\(frame,/, header);
  }
  const svc = sliceFn(CW_SRC, '  function syncServiceFrames() {');
  assert.ok(svc.indexOf('guardFrame(frame,') < svc.indexOf('serviceHost().appendChild(frame)'), 'service frame armed before insertion');
  // The scene pages register before inserting, which is what makes the first load count.
  for (const f of ['../js/ambient-mode.js', '../js/screen-scene.js']) {
    const s = read(f);
    assert.ok(s.indexOf('registerAmbientFrame(pkg.id, frame)') < s.indexOf('host.replaceChildren(frame)'), f);
  }
  const canvas = read('../js/ambient-canvas.js');
  assert.ok(canvas.indexOf('registerCanvasFrame(comp.id, pkg.id, frame)') < canvas.indexOf('body.appendChild(frame)'));
  // A stopped tile says so, and a reload starts it again.
  assert.match(CW_SRC, /leftPage\.get\(instId\) === pkg\.id/);
  assert.match(sliceFn(CW_SRC, '  function bumpAssets() {'), /leftPage\.clear\(\)/);
  // The animated background counts its loads too.
  assert.match(read('../js/custom-bg.js'), /loads\+\+ > 0 && win && win === firstWin/);
});

test('the player frames are not SDK frames and are not touched', () => {
  for (const f of ['../js/youtube-widget.js', '../js/twitchwatch-widget.js', '../js/sdk-youtube-player.js']) {
    assert.ok(!/guardFrame|\.csp\s*=/.test(read(f)), f);
  }
});

// ── 2. replacing an installed widget ─────────────────────────────────────────

test('installOverwrite: a new id installs; an installed one needs a reason', () => {
  const d = sdkWidgets.installOverwrite;
  assert.deepEqual(d({ exists: false, origin: 'import' }), { ok: true, dropGrants: false });
  assert.deepEqual(d({ exists: true, origin: 'import' }), { ok: false, error: 'id_exists' }, 'a share code over an installed id');
  assert.deepEqual(d({ exists: true, origin: 'import', replace: true }), { ok: true, dropGrants: true }, 'confirmed: the old grants go');
  assert.deepEqual(d({ exists: true, origin: 'import', catalogUpdate: true }), { ok: true, dropGrants: false }, 'the Store updating its own install');
  assert.deepEqual(d({ exists: true, origin: 'creator', own: true }), { ok: true, dropGrants: false }, 'the Creator editing the user\'s own widget');
  assert.deepEqual(d({ exists: true, origin: 'creator', own: false }), { ok: false, error: 'id_exists' }, 'a "creator" claim over someone else\'s widget');
  assert.deepEqual(d({ exists: true, origin: 'creator', catalogUpdate: true }), { ok: false, error: 'id_exists' });
  assert.deepEqual(d(null), { ok: true, dropGrants: false });
});

test('/sdk/install decides on the server, and the import review reads what the server read', () => {
  const srv = read('../server.js');
  const route = srv.slice(srv.indexOf("reqPath === '/sdk/install' && req.method === 'POST'"), srv.indexOf("reqPath === '/sdk/claim'"));
  assert.match(route, /sdkWidgets\.installOverwrite\(/);
  assert.match(route, /payload\.dryRun === true/);
  assert.match(route, /payload\.replace === true/);
  assert.match(route, /decided\.dropGrants[\s\S]*dropSdkGrant\(v\.id\)/);
  const share = read('../js/preset-share.js');
  const review = share.slice(share.indexOf('async function openWidgetImport('), share.indexOf('async function openAmbientImport('));
  assert.match(review, /reviewWidgetPayload\(w\)/);
  assert.match(review, /reviewedBits\(review\)/);
  assert.match(review, /appendReplacesNote\(body, review\)/);
  assert.ok(!/w\.actions|w\.hosts|w\.streams/.test(review), 'never the envelope\'s own description');
  // The Store's Update button falls back to the confirming review.
  assert.match(read('../js/installed-manager.js'), /d\.error === 'id_exists'[\s\S]{0,80}openImport/);
});

// ── 3. the shared store group belongs to the grant ───────────────────────────

test('storeNamespace opens a group only when it is the approved one', () => {
  const pkg = { id: 'radar', storageGroup: 'dgm' };
  assert.equal(sdkStore.storeNamespace(pkg), 'g:dgm', 'one argument: the manifest, as before');
  assert.equal(sdkStore.storeNamespace(pkg, 'dgm'), 'g:dgm');
  assert.equal(sdkStore.storeNamespace(pkg, 'other'), '');
  assert.equal(sdkStore.storeNamespace(pkg, ''), '');
  assert.equal(sdkStore.storeNamespace(pkg, null), '');
  assert.equal(sdkStore.storeNamespace({ id: 'radar' }, null), 'radar', 'no group: its own store');
  assert.equal(sdkStore.storeNamespace({ id: 'radar', storageGroup: '' }, 'dgm'), 'radar');
});

test('migrateGrantStorageGroups fills old grants from the installed package, once', () => {
  const grants = {
    a: { storage: true },                      // predates the field, package has a group
    b: { storage: true },                      // predates the field, no group
    c: { storage: true, storageGroup: 'x' },   // already recorded: untouched
    gone: { storage: true },                   // not installed any more
  };
  const pkgs = [{ id: 'a', storageGroup: 'set' }, { id: 'b', storageGroup: '' }, { id: 'c', storageGroup: 'y' }];
  const m = sdkWidgets.migrateGrantStorageGroups(grants, pkgs);
  assert.equal(m.changed, true);
  assert.equal(m.grants.a.storageGroup, 'set');
  assert.equal(m.grants.b.storageGroup, '');
  assert.equal(m.grants.c.storageGroup, 'x', 'a recorded group is never rewritten to match a new manifest');
  assert.equal(m.grants.gone.storageGroup, '');
  assert.equal(grants.a.storageGroup, undefined, 'input not mutated');
  const again = sdkWidgets.migrateGrantStorageGroups(m.grants, pkgs);
  assert.equal(again.changed, false);
  assert.equal(again.grants, m.grants);
});

test('a new or changed group needs review, on the dashboard and for auto-update alike', () => {
  const start = CW_SRC.indexOf('  function grantNeedsReview(pkg) {');
  const end = CW_SRC.indexOf('\n  }', start);
  const client = (g) => {
    const grant = { streams: [], actions: [], hosts: [], hooks: [], handlers: [], ...g };
    const ctx = vm.createContext({ grantsFor: () => grant });
    vm.runInContext(CW_SRC.slice(start, end + 4) + '\nthis.fn = grantNeedsReview;', ctx);
    return ctx.fn;
  };
  const cases = [
    [{ storage: true, storageGroup: 'dgm' }, { storage: true, storageGroup: 'dgm' }, false],
    [{ storage: true, storageGroup: 'dgm' }, { storage: true, storageGroup: 'other' }, true],
    [{ storage: true, storageGroup: 'dgm' }, { storage: true, storageGroup: '' }, true],
    [{ storage: true, storageGroup: 'dgm' }, { storage: true }, true],
    [{ storage: true, storageGroup: '' }, { storage: true, storageGroup: 'dgm' }, false],
    [{ storage: true }, { storage: true }, false],
  ];
  for (const [m, g, want] of cases) {
    assert.equal(client(g)(m), want, 'dashboard ' + JSON.stringify({ m, g }));
    assert.equal(wau.exceedsGrants(m, g, null) !== '', want, 'auto-update ' + JSON.stringify({ m, g }));
  }
  assert.equal(wau.exceedsGrants({ storage: true, storageGroup: 'b' }, { storage: true, storageGroup: 'a' }, null), 'storageGroup');
});

test('the permission dialog records the group, and the settings normalizer keeps it', () => {
  assert.match(CW_SRC, /storageGroup: wantsStorage \? storageGroup : ''/);
  const settings = read('../js/settings.js');
  assert.match(settings, /grants\[key\]\.storageGroup = g\.storageGroup/);
  const srv = read('../server.js');
  assert.match(srv, /if \(pkg\.storageGroup && grant\.storageGroup !== pkg\.storageGroup\) \{ json\(\{ ok: false, error: 'not_granted' \}\)/);
});

// ── 4. a shared Deck key is a shortcut, never typing ─────────────────────────

const DEPS = { model: DeckModel, actions: DeckActions };
const profileWith = (tap) => ({ name: 'P', root: { pages: [{ keys: [{ kind: 'action', title: 'k', triggers: { tap } }] }] } });
const tapOf = (prof) => DeckActions.triggerSteps(prof.root.pages[0].keys.find(Boolean).triggers.tap);
const hk = (keys, delayMs = 0) => ({ action: { type: 'hotkey', keys }, delayMs });

test('hotkeyTypesText: bare and shifted typing keys out, real shortcuts in', () => {
  for (const k of ['a', 'Z', '7', 'space', 'enter', 'return', 'tab', 'backspace', 'delete', 'shift+a', 'shift+5', 'Shift+Enter', 'shift', '', ';']) {
    assert.equal(PS.hotkeyTypesText(k), true, k);
  }
  for (const k of ['ctrl+shift+m', 'Ctrl+C', 'alt+tab', 'cmd+space', 'f5', 'F12', 'shift+f5', 'esc', 'up', 'pagedown']) {
    assert.equal(PS.hotkeyTypesText(k), false, k);
  }
  // Never shared: the Windows key opens the system (Win+R, Win+X), and a combo
  // on Enter confirms what was put there (Ctrl+Shift+Enter runs it elevated).
  for (const k of ['win+d', 'win+r', 'WIN+X', 'ctrl+enter', 'ctrl+shift+enter', 'alt+return']) {
    assert.equal(PS.hotkeyTypesText(k), true, k);
  }
});

test('sanitize drops typing hotkeys, keeps shortcuts and the media/OBS steps around them', () => {
  const prof = PS.sanitizeDeckProfile(profileWith({ steps: [
    hk('win+r'), hk('c'), hk('m'), hk('d'), hk('enter'),
    { action: { type: 'media', cmd: 'playpause' }, delayMs: 0 },
  ] }), DEPS);
  const steps = tapOf(prof);
  assert.deepEqual(steps.filter((s) => s.action.type === 'hotkey').map((s) => s.action.keys), [], 'win+r is not shared either');
  assert.ok(steps.some((s) => s.action.type === 'media'), 'other steps survive');
  const single = PS.sanitizeDeckProfile(profileWith({ type: 'hotkey', keys: 'ctrl+shift+m' }), DEPS);
  assert.deepEqual(tapOf(single).map((s) => s.action.keys), ['ctrl+shift+m']);
  const fkey = PS.sanitizeDeckProfile(profileWith({ type: 'hotkey', keys: 'f13' }), DEPS);
  assert.deepEqual(tapOf(fkey).map((s) => s.action.keys), ['f13']);
});

test('sanitize strips the combos of a slot that chains more than three', () => {
  const three = PS.sanitizeDeckProfile(profileWith({ steps: [hk('ctrl+a'), hk('ctrl+c'), hk('alt+tab')] }), DEPS);
  assert.equal(tapOf(three).length, 3);
  const four = PS.sanitizeDeckProfile(profileWith({ steps: [hk('ctrl+a'), hk('ctrl+c'), hk('alt+tab'), hk('ctrl+v'), { action: { type: 'micMute', mode: 'toggle' }, delayMs: 0 }] }), DEPS);
  assert.deepEqual(tapOf(four).map((s) => s.action.type), ['micMute']);
  assert.equal(PS.SHARED_HOTKEY_MAX_STEPS, 3);
});

test('the import review can name the combos a profile presses', () => {
  const prof = PS.sanitizeDeckProfile(profileWith({ steps: [hk('Ctrl+Shift+M'), hk('f5'), hk('ctrl+shift+m')] }), DEPS);
  assert.deepEqual(PS.profileHotkeys(prof, DEPS), ['ctrl+shift+m', 'f5']);
  assert.match(read('../js/preset-share.js'), /actionChipLabel\(tr\(spec && spec\.labelKey, s\.type\), s\.type, s\.count, \[prof\]\)/);
});

// ── the new words exist in every language ────────────────────────────────────

test('the new strings are in all eleven languages', () => {
  const src = read('../js/i18n.js');
  for (const key of ['cw_left_page', 'cw_left_page_hint', 'preset_widget_replaces']) {
    const n = (src.match(new RegExp('\\b' + key + ':', 'g')) || []).length;
    assert.equal(n, 11, key);
  }
});
