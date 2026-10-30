import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// tools/demo/maker.js: the Xenon Maker's preview channel in the browser demo.
// The demo has no server, so it lists a Maker widget the way the app's folder
// scan would; these tests keep that listing equal to normalizeManifest() and
// pin the policy the preview document runs under.
const require = createRequire(import.meta.url);
const { makerPackage, makerGrant, previewCsp, withCsp, widgetFromMessage, packageIdOfSrc, themeFromMessage, bgFromMessage, ambientFromMessage, pageFromMessage, layoutWithPage, PAGE_ID, deckFromMessage, deckStore, DECK_ID, DECK_ITEM, topbarFromMessage } = require('../../tools/demo/maker.js');
const DashboardPresets = require('../js/dashboard-presets.js');
const { normalizeManifest } = require('../sdk-widgets.js');
const DeckModel = require('../js/deck-model.js');

// Shaped like the Maker's buildManifest() output (xenon-maker, src/formats/widget-package.ts).
const MANIFESTS = [
  { api: 1, id: 'clock-a1b2c3', name: 'Clock', version: '1.0.0', entry: 'index.html', surface: 'tile', streams: [], actions: [] },
  {
    api: 1, id: 'now-playing-x1', name: 'Now playing', version: '1.0.0', entry: 'index.html', surface: 'tile',
    streams: ['system', 'media'], actions: ['media'], author: 'Ada', description: 'Cover and title.',
    category: 'media', hosts: ['api.example.com'], storage: true, size: 'wide',
  },
];

test('a Maker widget is listed exactly as the app would list it', () => {
  for (const m of MANIFESTS) {
    const app = normalizeManifest(m, m.id);
    assert.equal(app.ok, true, m.id);
    assert.deepEqual(makerPackage(m), app.manifest, m.id);
  }
});

test('every tile size the app keeps, the demo keeps too', () => {
  const { TILE_SIZES } = require('../sdk-widgets.js');
  for (const size of [...TILE_SIZES, 'huge']) {
    const m = { ...MANIFESTS[0], size };
    assert.deepEqual(makerPackage(m), normalizeManifest(m, m.id).manifest, size);
  }
});

test('a manifest with a bad id or no name is not listed', () => {
  assert.equal(makerPackage({ ...MANIFESTS[0], id: '../x' }), null);
  assert.equal(makerPackage({ ...MANIFESTS[0], id: 'A' }), null);
  assert.equal(makerPackage({ ...MANIFESTS[0], name: '  ' }), null);
  assert.equal(makerPackage(null), null);
});

test('the preview runs with no network and no eval, whatever the document says', () => {
  const csp = previewCsp('https://xenon-app.com');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.match(csp, /img-src data: blob: https:\/\/xenon-app\.com/);
  assert.equal(previewCsp('javascript:alert(1)').includes('javascript'), false);

  const html = withCsp('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>', 'https://xenon-app.com');
  // The demo's own policy comes first: a later one can only narrow it.
  assert.ok(html.indexOf("connect-src 'none'") < html.indexOf('default-src *'));
  assert.equal(withCsp('<html><script>x</script>', 'https://xenon-app.com'), null);
  assert.equal(withCsp(42, 'https://xenon-app.com'), null);
});

test('only a tile widget message with both parts is shown', () => {
  const html = '<!doctype html><html><head></head><body></body></html>';
  const ok = widgetFromMessage({ type: 'xenon-maker:widget', manifest: MANIFESTS[0], html }, 'https://xenon-app.com');
  assert.equal(ok.pkg.id, 'clock-a1b2c3');
  assert.ok(ok.html.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"'));
  assert.equal(widgetFromMessage({ type: 'other', manifest: MANIFESTS[0], html }, ''), null);
  assert.equal(widgetFromMessage({ type: 'xenon-maker:widget', manifest: { ...MANIFESTS[0], surface: 'ambient' }, html }, ''), null);
  assert.equal(widgetFromMessage({ type: 'xenon-maker:widget', manifest: MANIFESTS[0] }, ''), null);
  assert.equal(ok.place, true);
  const kept = widgetFromMessage({ type: 'xenon-maker:widget', manifest: MANIFESTS[0], html, place: false }, '');
  assert.equal(kept.place, false);
});

test('a tile frame is matched to its package by the path custom-widget.js sets', () => {
  assert.equal(packageIdOfSrc('/sdk/widget/clock-a1b2c3/index.html?v=3'), 'clock-a1b2c3');
  assert.equal(packageIdOfSrc('https://evil.example/sdk/widget/clock-a1b2c3/index.html'), null);
  assert.equal(packageIdOfSrc('/sdk/wk/abc/clock/index.html'), null);
  assert.equal(packageIdOfSrc('/sdk/widget/%E0%A4%A/index.html'), null);
});

test('a theme message keeps its data and only a font the app could take', () => {
  const font = { name: 'Hand', ext: 'woff2', data: 'd09GMgAB' };
  const t = themeFromMessage({ type: 'xenon-maker:theme', data: { accent: '#8f7dff', fontData: font } });
  assert.deepEqual(t, { data: { accent: '#8f7dff' }, font: { ext: 'woff2', data: 'd09GMgAB' } });
  assert.equal(themeFromMessage({ type: 'xenon-maker:theme', data: { fontData: { ...font, ext: 'svg' } } }).font, null);
  assert.equal(themeFromMessage({ type: 'xenon-maker:theme', data: { fontData: { ...font, data: 'a")}x' } } }).font, null);
  assert.equal(themeFromMessage({ type: 'xenon-maker:theme', data: [] }), null);
  assert.equal(themeFromMessage({ type: 'xenon-maker:widget', data: {} }), null);
});

test('a top bar message is read by the topbar code reader, and nothing else', () => {
  const TopbarShare = require('../js/topbar-share.js');
  const data = { look: { surface: 'glass', accent: 'search' }, style: 'minimal', rails: { left: true, right: false } };
  assert.deepEqual(topbarFromMessage({ type: 'xenon-maker:topbar', data }), TopbarShare.read(data));
  assert.equal(topbarFromMessage({ type: 'xenon-maker:topbar', data: { style: 'minimal' } }), null);
  assert.equal(topbarFromMessage({ type: 'xenon-maker:theme', data }), null);
  assert.equal(topbarFromMessage(null), null);
});

test('a background message becomes the bgCustom an imported code sets, and nothing else', () => {
  const code = 'function draw(ctx, t, w, h) {}';
  assert.deepEqual(bgFromMessage({ type: 'xenon-maker:bg', data: { name: 'Dusk', code, fps: 15 } }), {
    code, name: 'Dusk', assets: {}, fps: 15, enabled: true, imported: true,
  });
  // The pictures ride along, so an image layer shows in the preview too.
  const assets = { pic: 'data:image/png;base64,iVBORw0KGgo=' };
  assert.deepEqual(bgFromMessage({ type: 'xenon-maker:bg', data: { code, assets } }).assets, assets);
  assert.deepEqual(bgFromMessage({ type: 'xenon-maker:bg', data: { code, assets: ['x'] } }).assets, {});
  assert.deepEqual(bgFromMessage({ type: 'xenon-maker:bg', data: { code, assets: 'x' } }).assets, {});
  assert.equal(bgFromMessage({ type: 'xenon-maker:bg', data: { name: 'x'.repeat(80), code } }).name.length, 60);
  assert.equal(bgFromMessage({ type: 'xenon-maker:bg', data: { code: '   ' } }), null);
  assert.equal(bgFromMessage({ type: 'xenon-maker:bg', data: { code: 'x'.repeat(60001) } }), null);
  assert.equal(bgFromMessage({ type: 'xenon-maker:bg', data: { code: 42 } }), null);
  assert.equal(bgFromMessage({ type: 'xenon-maker:theme', data: { code } }), null);
  assert.equal(bgFromMessage(null), null);
});

test('an Ambient scene message passes its scene on, and only one the app could store', () => {
  const scene = { name: 'Night', bg: { type: 'color', color: '#05060a' }, components: [{ type: 'clock', x: 10, y: 10, w: 30, h: 20 }] };
  assert.equal(ambientFromMessage({ type: 'xenon-maker:ambient', scene }), scene);
  assert.equal(ambientFromMessage({ type: 'xenon-maker:bg', scene }), null);
  assert.equal(ambientFromMessage({ type: 'xenon-maker:ambient', scene: [scene] }), null);
  assert.equal(ambientFromMessage({ type: 'xenon-maker:ambient' }), null);
  assert.equal(ambientFromMessage(null), null);
  // Larger than sanitizeAmbientScenes in server.js keeps.
  const big = { ...scene, name: 'x'.repeat(400001) };
  assert.equal(ambientFromMessage({ type: 'xenon-maker:ambient', scene: big }), null);
});

test('a page from the Maker is taken only whole and within the item limit', () => {
  const items = [{ type: 'widget', widget: 'system', x: 0, y: 0, w: 8, h: 8 }];
  assert.deepEqual(pageFromMessage({ type: 'xenon-maker:page', name: 'Desk', data: { items } }), { name: 'Desk', items });
  assert.equal(pageFromMessage({ type: 'xenon-maker:page', data: { items: [] } }), null);
  assert.equal(pageFromMessage({ type: 'xenon-maker:page', data: { items: Array(65).fill(items[0]) } }), null);
  assert.equal(pageFromMessage({ type: 'xenon-maker:ambient', data: { items } }), null);
  assert.equal(pageFromMessage(null), null);
});

test('the preview shows the page alone, on one stable page id', () => {
  const tile = (page, x) => ({ visible: true, page, x, y: 0, w: 8, h: 8 });
  const layout = {
    widgets: { system: tile('dashboard', 0), media: tile('dashboard', 8), lyrics: tile('two', 0), weather: tile('two', 8) },
    pages: [{ id: 'dashboard', name: 'Home' }, { id: 'two', name: 'Two' }],
    copies: [{ id: 'media~ab12', widget: 'media', page: 'two', x: 0, y: 8, w: 8, h: 8 }],
    groups: {},
  };
  const items = [
    { type: 'widget', widget: 'weather', x: 0, y: 0, w: 12, h: 6, style: { mode: 'custom', accent: '#ff8800' } },
    { type: 'group', x: 12, y: 0, w: 12, h: 8, members: ['media', 'lyrics'], active: 1 },
    { type: 'widget', widget: 'nope', x: 0, y: 6, w: 8, h: 4 },
  ];
  assert.equal(layoutWithPage(layout, { name: 'Desk', items }, DashboardPresets), true);
  assert.deepEqual(layout.pages, [{ id: PAGE_ID, name: 'Desk' }]);
  assert.equal(layout.copies.length, 0);
  assert.equal(layout.widgets.system.visible, false);
  assert.deepEqual(layout.widgets.weather, { visible: true, page: PAGE_ID, x: 0, y: 0, w: 12, h: 6, style: { mode: 'custom', accent: '#ff8800' } });
  const [group] = Object.values(layout.groups);
  assert.deepEqual([group.page, group.members, group.active], [PAGE_ID, ['media', 'lyrics'], 'lyrics']);
  assert.equal(layoutWithPage(layout, { name: 'Bad', items: [{ type: 'widget', widget: 'nope' }] }, DashboardPresets), false);
});

test('a page tile that names a package widget is handed back to be bound', () => {
  const layout = { widgets: { custom: { visible: true, page: 'dashboard', x: 0, y: 0, w: 8, h: 8 } }, pages: [{ id: 'dashboard', name: 'Home' }], copies: [], groups: {} };
  const bind = [];
  const items = [{ type: 'widget', widget: 'custom', pkg: 'clock-a1b2c3', x: 0, y: 0, w: 8, h: 8 }];
  assert.equal(layoutWithPage(layout, { name: 'Pack', items }, DashboardPresets, bind), true);
  assert.equal(bind.length, 1);
  assert.equal(bind[0].pkg, 'clock-a1b2c3');
  assert.ok(bind[0].instance);
});

test('a Deck profile from the Maker is taken with the view the editor is on', () => {
  const profile = { name: 'Live', cols: 3, rows: 1, root: { pages: [{ keys: [{ id: 'a', kind: 'action', title: 'Mic' }] }] } };
  assert.deepEqual(deckFromMessage({ type: 'xenon-maker:deck', profile, view: { path: ['f1', 2, 'f2'], page: 1.4, lit: true } }), {
    profile, view: { path: ['f1', 'f2'], page: 1, lit: true },
  });
  assert.deepEqual(deckFromMessage({ type: 'xenon-maker:deck', profile, view: { lit: 'yes' } }).view, { path: [], page: 0, lit: false });
  assert.equal(deckFromMessage({ type: 'xenon-maker:deck', profile: { name: 'x' } }), null);
  assert.equal(deckFromMessage({ type: 'xenon-maker:page', profile }), null);
  const big = { ...profile, name: 'x'.repeat(6 * 1024 * 1024 + 1) };
  assert.equal(deckFromMessage({ type: 'xenon-maker:deck', profile: big }), null);
});

test('the preview Deck keeps the grid it was made with and shows only that profile', () => {
  const profile = { name: 'Live', cols: 5, rows: 3, look: { capStyle: 'neon' }, root: { pages: [{ keys: [{ id: 'a', kind: 'action', title: 'Mic' }] }] } };
  const store = deckStore(profile, DeckModel);
  const cfg = store[DECK_ID];
  assert.equal(cfg.autoFit, false);
  assert.equal(cfg.showMedia, false);
  assert.equal(cfg.profiles.length, 1);
  assert.deepEqual([cfg.profiles[0].cols, cfg.profiles[0].rows, cfg.profiles[0].look], [5, 3, { capStyle: 'neon' }]);
  assert.equal(cfg.profiles[0].root.pages[0].keys[0].title, 'Mic');
  assert.equal(cfg.activeProfile, cfg.profiles[0].id);
  // The tile the profile sits in is a widget the dashboard knows.
  const layout = { widgets: { deck: { visible: false, page: 'dashboard', x: 0, y: 0, w: 6, h: 4 } }, pages: [{ id: 'dashboard', name: 'Home' }], copies: [], groups: {} };
  assert.equal(layoutWithPage(layout, { name: 'Live', items: [DECK_ITEM] }, DashboardPresets), true);
  assert.equal(layout.widgets.deck.visible, true);
});

test('the preview Deck shows its music screen when the profile styles it', () => {
  const profile = { name: 'Music', cols: 4, rows: 2, look: { mediaStyle: { accent: '#7c5cff' } }, root: { pages: [{ keys: [] }] } };
  assert.equal(deckStore(profile, DeckModel)[DECK_ID].showMedia, true);
});

// The preview of a page or bundle grants its widgets what they ask for, in the
// dialog's own shape, so the tile shows the widget instead of a permission card.
test('a package widget in a page preview is granted exactly what the dialog would grant', () => {
  const src = readFileSync(new URL('../js/custom-widget.js', import.meta.url), 'utf8');
  const line = /\[pkg\.id\]: \{ (streams: [^\n]*?) \} \},/.exec(src);
  assert.ok(line, 'the dialog grant patch');
  const dialogKeys = [...line[1].matchAll(/(\w+):/g)].map((m) => m[1]).sort();
  for (const m of MANIFESTS) {
    const pkg = makerPackage(m);
    const g = makerGrant(pkg);
    assert.deepEqual(Object.keys(g).sort(), dialogKeys, m.id);
    assert.deepEqual(g.streams, pkg.streams);
    assert.deepEqual(g.actions, pkg.actions);
    assert.deepEqual(g.hosts, pkg.hosts);
    assert.equal(g.storage, pkg.storage);
    // Nothing the package did not ask for.
    for (const k of dialogKeys) {
      if (typeof g[k] === 'boolean' && k !== 'storage') assert.equal(g[k], false, k);
    }
  }
});
