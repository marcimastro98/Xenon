// create_preset: every share code kind the assistant can build passes the
// app's own import normalizers unchanged, broken input is reported precisely,
// sound packs are refused, and the import window opens only on success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadServerSettingsSlice, serverDashboardWidgets } from './server-settings-slice.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = require('../ai-presets.js');
const PresetShare = require('../js/preset-share.js');
const DeckModel = require('../js/deck-model.js');
const DeckActions = require('../js/deck-actions.js');
const DashboardPresets = require('../js/dashboard-presets.js');
const AmbientScene = require('../js/ambient-scene.js');
const SdkWidgets = require('../sdk-widgets.js');
const IconPacks = require('../icon-packs.js');

const deps = { normalizeSettings: loadServerSettingsSlice(), dashboardWidgets: serverDashboardWidgets(), sdkEnabled: true, appVersion: '9.9.9' };
const BUILDABLE = PresetShare.PRESET_KINDS.filter((k) => k !== 'sounds');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>';

function build(kind, data, d = deps) {
  return P.buildPreset(kind, 'Test ' + kind, data, d);
}
const paths = (r) => (r.report.entries || []).map((e) => e.path);

// A richer valid example per kind than the reference's minimal one.
const RICH = {
  theme: { appearance: 'auto', autoPalette: false, accent: '#7c5cff', background: '#0b0a12', text: '#ecebf5', surface: '#15131f',
    paletteVariants: { light: { accent: '#5b3fe0', background: '#f6f5fb', text: '#16141f' }, dark: { accent: '#7c5cff', background: '#0b0a12', text: '#ecebf5' } },
    styleMode: 'glass', panelAlpha: 0.8, glassBlur: 30, bgAurora: { enabled: false, intensity: 40, speed: 20 }, bgStatic: { style: 'prisma', intensity: 60 },
    topbarLook: { surface: 'glass', opacity: 50, shape: 'pill' } },
  deck: { name: 'Big', cols: 5, rows: 3, look: { capStyle: 'neon', keyShape: 'circle', plate: 'carbon', transparency: 40, litRing: true },
    root: { pages: [{ keys: [
      { kind: 'action', title: 'Mic', icon: '🎙️', bg: '#112233', bg2: '#334455', bgDir: 'v', labelPos: 'top', triggers: { tap: { type: 'micMute' }, hold: { steps: [{ action: { type: 'media', cmd: 'next' }, delayMs: 0 }, { action: { type: 'media', cmd: 'previous' }, delayMs: 200 }] } }, state: { source: 'micMuted' } },
      null,
      { kind: 'action', title: 'Glyph', icon: { type: 'svg', value: SVG }, triggers: { tap: { type: 'openUrl', url: 'https://example.com' } } },
      { kind: 'folder', title: 'More', icon: '📁', folder: { pages: [{ keys: [{ kind: 'folder', title: 'Deeper', folder: { pages: [{ keys: [{ kind: 'action', title: 'In', triggers: { tap: { type: 'media', cmd: 'playpause' } } }] }] } }] }] } },
      { kind: 'slider', title: 'Vol', slider: { target: 'volume' } },
    ] }] } },
};

test('every kind except sounds builds from its reference example with an empty report', () => {
  for (const kind of BUILDABLE) {
    const ref = P.presetReference(kind, deps);
    assert.ok(ref.ok && ref.example, kind + ' has an example');
    const r = build(kind, ref.example);
    assert.equal(r.ok, true, kind + ': ' + r.error);
    assert.deepEqual(r.report, { dropped: 0, changed: 0 }, kind);
  }
});

test('a built code decodes and goes through the import normalizers again unchanged', () => {
  const examples = Object.fromEntries(BUILDABLE.map((k) => [k, RICH[k] || P.presetReference(k, deps).example]));
  for (const [kind, data] of Object.entries(examples)) {
    const r = build(kind, data);
    assert.equal(r.ok, true, kind + ': ' + r.error + ' ' + JSON.stringify(r.report));
    assert.deepEqual(r.report, { dropped: 0, changed: 0 }, kind + ' ' + JSON.stringify(r.report));
    const env = PresetShare.decodePreset(r.code);
    assert.equal(env.kind, kind);
    assert.equal(env.name, 'Test ' + kind);
    assert.equal(env.gridCols, 24);
    const again = build(kind, env.data);
    assert.deepEqual(again.report, { dropped: 0, changed: 0 }, kind + ' second pass');
  }
});

test('the encoded data is what each import path accepts', () => {
  const deck = PresetShare.decodePreset(build('deck', RICH.deck).code).data;
  const deckDeps = { model: DeckModel, actions: DeckActions };
  assert.deepEqual(PresetShare.sanitizeDeckProfile(JSON.parse(JSON.stringify(deck)), deckDeps), deck, 'deck is already sanitized');
  assert.equal(PresetShare.countProfileKeys(deck), 6);
  assert.match(deck.root.pages[0].keys[2].icon.value, /^data:image\/svg\+xml;base64,/);
  assert.equal(deck.root.pages[0].keys[0].icon.type, 'emoji');

  const page = PresetShare.decodePreset(build('page', P.presetReference('page', deps).example).code).data;
  const norm = DashboardPresets.normalizePresets([{ kind: 'page', gridCols: 24, data: page }], deps.dashboardWidgets.map((w) => w.id))[0];
  assert.equal(norm.data.items.length, page.items.length);

  const widget = PresetShare.decodePreset(build('widget', P.presetReference('widget', deps).example).code).data;
  assert.equal(SdkWidgets.validateWidgetPayload(widget.payload).ok, true);
  assert.equal(widget.surface, 'tile');
  const ambient = PresetShare.decodePreset(build('ambient', P.presetReference('ambient', deps).example).code).data;
  assert.equal(ambient.surface, 'ambient');

  const icons = PresetShare.decodePreset(build('icons', P.presetReference('icons', deps).example).code).data;
  assert.equal(IconPacks.validateIconPack(icons).ok, true);
  assert.equal(icons.icons[0].type, 'svg');

  const layout = PresetShare.decodePreset(build('ambient-layout', P.presetReference('ambient-layout', deps).example).code).data;
  assert.equal(AmbientScene.normalizeScene(layout.scene).components.length, layout.scene.components.length);

  const theme = PresetShare.decodePreset(build('theme', RICH.theme).code).data;
  const applied = deps.normalizeSettings(PresetShare.themeImportPatch(theme));
  assert.equal(applied.autoPalette, false);
  assert.equal(applied.paletteVariants.light.background, '#f6f5fb');
});

test('a bundle checks every part with its own kind and keeps the import caps', () => {
  const widget = P.presetReference('widget', deps).example;
  const r = build('bundle', {
    theme: { accent: '#123456', background: '#000000', text: '#ffffff' },
    pages: [{ name: 'Home', data: { items: [{ type: 'widget', widget: 'media', x: 0, y: 0, w: 8, h: 8 }] } }],
    decks: [RICH.deck],
    bg: P.presetReference('bg', deps).example,
    topbar: P.presetReference('topbar', deps).example,
    widgets: [widget],
  });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.report, { dropped: 0, changed: 0 });
  const data = PresetShare.decodePreset(r.code).data;
  assert.deepEqual(Object.keys(data).sort(), ['bg', 'decks', 'pages', 'theme', 'topbar', 'widgets']);

  const tooMany = build('bundle', { decks: Array.from({ length: PresetShare.BUNDLE_MAX_DECKS + 2 }, () => RICH.deck), icons: {} });
  assert.equal(tooMany.ok, true);
  assert.equal(PresetShare.decodePreset(tooMany.code).data.decks.length, PresetShare.BUNDLE_MAX_DECKS);
  assert.deepEqual(paths(tooMany).sort(), ['decks', 'icons']);

  const broken = build('bundle', { theme: { accent: '#123456' }, decks: [{ root: { pages: [{ keys: [] }] } }] });
  assert.equal(broken.ok, false);
  assert.equal(broken.error, 'no_keys');
  assert.equal(broken.report.errors[0].path, 'decks[0].root');
});

test('broken input names what the import drops or changes, and why', () => {
  const theme = build('theme', { accent: '#f00', background: 'blue', text: '#fff', panelAlpha: 5, styleMode: 'neon', foo: 1, fontData: { data: 'x' } });
  assert.equal(theme.ok, true);
  assert.deepEqual(paths(theme).sort(), ['background', 'fontData', 'foo', 'panelAlpha', 'styleMode']);
  assert.equal(theme.report.entries.find((e) => e.path === 'panelAlpha').now, '1');

  const deck = build('deck', { cols: 12, root: { pages: [{ keys: [
    { kind: 'action', label: 'X', triggers: { tap: { type: 'runScript', path: 'a.bat' }, double: { type: 'bogus' }, hold: { steps: [{ action: { type: 'media', cmd: 'zzz' } }] }, wiggle: { type: 'micMute' } } },
    { kind: 'button' },
    { kind: 'action', title: 'Ok', triggers: { tap: { type: 'typeText', text: 'hi' } } },
  ] }] } });
  assert.equal(deck.ok, true);
  const why = Object.fromEntries(deck.report.entries.map((e) => [e.path, e.why]));
  assert.match(why.cols, /1-8/);
  assert.match(why['root.pages[0].keys[0].label'], /title/);
  assert.match(why['root.pages[0].keys[0].triggers.tap'], /local-only/);
  assert.match(why['root.pages[0].keys[0].triggers.double'], /unknown action type "bogus"/);
  assert.ok('root.pages[0].keys[0].triggers.hold.steps[0].action.cmd' in why);
  assert.match(why['root.pages[0].keys[0].triggers.wiggle'], /trigger slots/);
  assert.match(why['root.pages[0].keys[1]'], /action, folder or slider/);
  assert.match(why['root.pages[0].keys[2].triggers.tap'], /local-only/);
  const shipped = PresetShare.decodePreset(deck.code).data;
  assert.doesNotMatch(JSON.stringify(shipped), /runScript|typeText/, 'local-only actions never travel');

  const page = build('page', { items: [{ type: 'widget', widget: 'nope', x: 0, y: 0, w: 4, h: 4 }, { type: 'widget', widget: 'media', x: 0, y: 0, w: 8, h: 8, style: { mode: 'custom', accent: '#f00', radius: 9 } }] });
  assert.deepEqual(paths(page), ['items[0]', 'items[1].style.accent', 'items[1].style.radius']);
  assert.equal(PresetShare.decodePreset(page.code).data.items.length, 1, 'the dropped item is not shipped');

  const bar = build('topbar', { look: { surface: 'neon' }, style: 'tiny', clock: { items: [{ id: 'bogus' }, { id: 'time' }], actions: [{ id: 'settings', hidden: true }] }, extra: 1 });
  assert.deepEqual(paths(bar).sort(), ['clock.actions[0].hidden', 'clock.items[0]', 'extra', 'look.surface', 'style']);

  const scene = build('ambient-layout', { scene: { bg: { type: 'gradient', grad: { a: 1 } }, components: [{ type: 'clock', props: { style: 'sundial' } }, { type: 'sdk', props: {} }, { type: 'laser' }] } });
  assert.deepEqual(paths(scene).sort(), ['scene.bg.grad', 'scene.bg.type', 'scene.components[0].props.style', 'scene.components[1]', 'scene.components[2]']);
});

test('hard failures stop the build with a reason the model can fix', () => {
  const cases = [
    ['bg', { code: 'function draw(ctx){ ctx.fillRect(0,0,' }, /^syntax_error/],
    ['bg', { code: 'let x = 1;' }, /^no_draw_function$/],
    ['bg', {}, /^missing_code$/],
    ['page', { items: [] }, /^no_items$/],
    ['page', { items: [{ type: 'widget', widget: 'nope' }] }, /^no_valid_items$/],
    ['deck', { name: 'x' }, /^bad_profile$/],
    ['deck', { root: { pages: [{ keys: [{ kind: 'button' }] }] } }, /^no_keys$/],
    ['topbar', { style: 'full' }, /^no_look$/],
    ['theme', { foo: 1 }, /^empty_theme$/],
    ['icons', { manifest: { id: 'Bad Id', name: 'x' }, icons: [] }, /^bad_pack_id$/],
    ['icons', { manifest: { id: 'ok-pack', name: 'x' }, icons: [{ id: 'a', label: 'A', svg: '<svg onload="x"></svg>' }] }, /^svg_rejected$/],
    ['widget', { id: 'w1x', files: [{ path: 'index.html', content: 'x' }] }, /^missing_manifest$/],
    ['ambient', { id: 'abc', files: [{ path: 'manifest.json', content: '{"api":1,"name":"A"}' }, { path: 'index.html', content: 'x' }] }, /^surface_mismatch$/],
    ['ambient-layout', { widgets: [] }, /^no_scene$/],
    ['bundle', { icons: {} }, /^empty_package$/],
    ['nope', {}, /^unknown_kind$/],
    ['page', 'not an object', /^bad_data$/],
  ];
  for (const [kind, data, re] of cases) {
    const r = build(kind, data);
    assert.equal(r.ok, false, kind + ' ' + JSON.stringify(data));
    assert.match(r.error, re, kind);
    assert.equal(r.code, undefined);
  }
  const svgFail = build('icons', { manifest: { id: 'ok-pack', name: 'x' }, icons: [{ id: 'a', label: 'A', svg: '<svg onload="x"></svg>' }] });
  assert.equal(svgFail.report.errors[0].path, 'icons[0]');
});

test('widgets and Ambient packages need Community widgets switched on', () => {
  for (const kind of ['widget', 'ambient']) {
    const r = build(kind, P.presetReference(kind, deps).example, Object.assign({}, deps, { sdkEnabled: false }));
    assert.equal(r.error, 'sdk_disabled');
  }
});

test('a code over the 4 MB import cap is refused', () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(1_400_000);
  const keys = Array.from({ length: 4 }, (_, i) => ({ kind: 'action', title: 'K' + i, icon: { type: 'image', value: big }, triggers: { tap: { type: 'micMute' } } }));
  const r = build('deck', { root: { pages: [{ keys }] } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'too_large');
});

test('sound packs are refused, by the builder and by the reference', () => {
  const r = build('sounds', { clips: [] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'sounds_unsupported');
  assert.match(r.hint, /audio/);
  assert.equal(P.presetReference('sounds', deps).ok, false);
  const run = P.runCreatePreset({ kind: 'sounds', name: 'S', data: '{}' }, deps);
  assert.deepEqual(run.clientActions, []);
});

test('the tool opens the import window only on success', () => {
  const data = JSON.stringify(P.presetReference('page', deps).example);
  const ok = P.runCreatePreset({ kind: 'page', name: 'Mine', data }, deps);
  assert.equal(ok.fnResult.ok, true);
  assert.equal(ok.clientActions.length, 1);
  assert.equal(ok.clientActions[0].action, 'marketplace_open_import');
  assert.equal(PresetShare.decodePreset(ok.clientActions[0].args.code).name, 'Mine');
  assert.equal(ok.fnResult.code, undefined, 'the code goes to the client, not back into the model context');

  const asObject = P.runCreatePreset({ kind: 'page', name: 'Obj', data: JSON.parse(data) }, deps);
  assert.equal(asObject.clientActions.length, 1);

  for (const args of [{ kind: 'page', data: '{bad' }, { kind: 'page', data: '{"items":[]}' }, { kind: 'bg', data: '{"code":"x"}' }, {}]) {
    const r = P.runCreatePreset(args, deps);
    assert.equal(r.fnResult.ok, false, JSON.stringify(args));
    assert.deepEqual(r.clientActions, [], JSON.stringify(args));
  }
});

test('server.js declares both tools and hands create_preset actions to the client', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
  for (const name of ['preset_reference', 'create_preset']) {
    assert.match(src, new RegExp("\\{ name: '" + name + "', description: '"), name + ' declared');
    assert.match(src, new RegExp("fnName === '" + name + "'"), name + ' handled');
  }
  assert.match(src, /required: \['kind', 'name', 'data'\]/);
  const handler = src.slice(src.indexOf("fnName === 'create_preset'"), src.indexOf("fnName === 'deck_action_catalog'"));
  assert.match(handler, /aiPresets\.runCreatePreset\(fnArgs, aiPresetDeps\(\), pictures\)/);
  assert.match(handler, /clientActions\.push\(\.\.\.out\.clientActions\)/);
  const clientActions = src.match(/const CLIENT_ACTIONS = new Set\(\[([^\]]*)\]\)/)[1];
  assert.doesNotMatch(clientActions, /create_preset|preset_reference/, 'never forwarded raw to the client');
  const depsFn = src.slice(src.indexOf('function aiPresetDeps()'), src.indexOf('async function executeAiTool('));
  assert.match(depsFn, /normalizeSettings: normalizeHubSettings/);
  assert.match(depsFn, /sdkEnabled: sdkFeatureEnabled\(\)/);
});
