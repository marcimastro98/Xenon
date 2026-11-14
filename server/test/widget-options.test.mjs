// A Store widget's own options (manifest `options`): the manifest is checked, the values
// are kept in DATA_DIR/widget-options.json, and a change is checked against what the
// widget declared before it is written and announced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const Options = require('../widget-options/options.js');
const { createWidgetOptions } = require('../widget-options/index.js');
const capability = require('../capabilities/widget-option.js');

const DECLARED = [
  { id: 'form', kind: 'select', label: { en: 'Shape', it: 'Forma' }, default: 'row', choices: [{ value: 'min', label: 'Min' }, { value: 'row', label: 'Row' }] },
  { id: 'net', kind: 'group', label: 'Network' },
  { id: 'fps', kind: 'toggle', label: 'FPS', default: true },
  { id: 'ping', kind: 'toggle', label: 'Ping', group: 'net' },
];

test('the manifest options are kept in order; a wrong entry is left out, never guessed', () => {
  const out = Options.normalizeDeclared([
    ...DECLARED,
    { id: 'fps', kind: 'toggle', label: 'Twice' },
    { id: 'Bad', kind: 'toggle', label: 'Capital id' },
    { id: 'nolabel', kind: 'toggle' },
    { id: 'one', kind: 'select', label: 'One choice', choices: [{ value: 'a', label: 'A' }] },
    { id: 'lost', kind: 'toggle', label: 'Lost', group: 'nowhere' },
    { id: 'slider', kind: 'range', label: 'Unknown kind' },
  ]);
  assert.deepEqual(out.map((o) => o.id), ['form', 'net', 'fps', 'ping', 'lost']);
  assert.equal(out[3].group, 'net');
  assert.equal(out[4].group, undefined, 'a group it never declared');
  assert.equal(out[3].default, false);
  assert.deepEqual(Options.normalizeDeclared('x'), []);
  assert.equal(Options.normalizeDeclared(Array.from({ length: 50 }, (_, i) => ({ id: 'o' + i, kind: 'toggle', label: 'x' }))).length, Options.MAX_OPTIONS);
});

test('labels: control characters gone, cut to a line, per-language maps keep only language keys', () => {
  const [opt] = Options.normalizeDeclared([{ id: 'a', kind: 'toggle', label: { en: 'Mem\u0007ory', xx1: 'no', it: 'x'.repeat(200) } }]);
  assert.deepEqual(Object.keys(opt.label), ['en', 'it']);
  assert.equal(opt.label.en, 'Memory');
  assert.equal(opt.label.it.length, 60);
  assert.equal(Options.labelText(opt.label, 'ko'), 'Memory');
});

test('a select default it does not offer falls back on its first choice', () => {
  const [opt] = Options.normalizeDeclared([{ id: 'f', kind: 'select', label: 'F', default: 'huge', choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }]);
  assert.equal(opt.default, 'a');
});

test('resolve: the stored value when still valid, else the default', () => {
  const declared = Options.normalizeDeclared(DECLARED);
  assert.deepEqual(Options.resolve(declared, undefined), { form: 'row', fps: true, ping: false });
  assert.deepEqual(Options.resolve(declared, { form: 'gone', fps: 'yes', ping: true, extra: true }), { form: 'row', fps: true, ping: true });
});

test('applyChange: on/off for a switch, a declared value for a list, null for anything else', () => {
  const declared = Options.normalizeDeclared(DECLARED);
  assert.deepEqual(Options.applyChange(declared, {}, 'ping', 'on'), { form: 'row', fps: true, ping: true });
  assert.deepEqual(Options.applyChange(declared, { ping: true }, 'form', 'min'), { form: 'min', fps: true, ping: true });
  assert.equal(Options.applyChange(declared, {}, 'ping', 'true'), null);
  assert.equal(Options.applyChange(declared, {}, 'form', 'huge'), null);
  assert.equal(Options.applyChange(declared, {}, 'net', 'on'), null, 'a group is a heading, not a value');
  assert.equal(Options.applyChange(declared, {}, 'nope', 'on'), null);
});

test('the stored file is shape-checked: bad package ids, ids and values are dropped', () => {
  assert.deepEqual(Options.normalizeStored({ alibi: { fps: false, form: 'min', bad: { x: 1 }, 'Up': true }, '../x': { a: true }, list: [] }), { alibi: { fps: false, form: 'min' } });
  assert.deepEqual(Options.normalizeStored([1, 2]), {});
});

function store(dir, announced = []) {
  const packages = async () => [{ id: 'alibi', options: Options.normalizeDeclared(DECLARED) }];
  return createWidgetOptions({ dataDir: dir, packages, announce: (id) => announced.push(id) });
}

test('the store writes a valid change, announces it, and reads it back after a restart', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xenon-wopt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const announced = [];
  const s = store(dir, announced);
  const pkg = { id: 'alibi', options: Options.normalizeDeclared(DECLARED) };
  assert.deepEqual(await s.set('alibi', 'form', 'min'), { ok: true, values: { form: 'min', fps: true, ping: false } });
  assert.deepEqual(await s.set('alibi', 'form', 'huge'), { ok: false, error: 'bad_option' });
  assert.deepEqual(await s.set('ghost', 'form', 'min'), { ok: false, error: 'unknown_widget' });
  assert.deepEqual(announced, ['alibi'], 'only a written change is announced');
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'widget-options.json'), 'utf8')), { alibi: { form: 'min', fps: true, ping: false } });
  const again = store(dir);
  await again.load();
  assert.equal(again.valuesFor(pkg).form, 'min');
  assert.deepEqual(again.valuesFor({ id: 'plain', options: [] }), {});
});

test('two quick changes are written one after the other, none lost', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xenon-wopt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = store(dir);
  await Promise.all([s.set('alibi', 'ping', 'on'), s.set('alibi', 'fps', 'off')]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'widget-options.json'), 'utf8')).alibi, { form: 'row', fps: false, ping: true });
});

test('an unreadable file leaves every widget on its defaults', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xenon-wopt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'widget-options.json'), '{ not json');
  const s = store(dir);
  await s.load();
  assert.deepEqual(s.valuesFor({ id: 'alibi', options: Options.normalizeDeclared(DECLARED) }), { form: 'row', fps: true, ping: false });
});

test('the widgetOption capability passes plain strings through and refuses missing parts', async () => {
  const calls = [];
  const d = { widgetOptions: { set: async (...a) => { calls.push(a); return { ok: true }; } } };
  assert.deepEqual(await capability.run(d, { widget: 'alibi', option: 'ping', value: 'on' }), { ok: true });
  assert.deepEqual(calls, [['alibi', 'ping', 'on']]);
  assert.deepEqual(await capability.run(d, { widget: 'alibi', option: 'ping' }), { ok: false, error: 'bad_option' });
  assert.deepEqual(await capability.run({}, { widget: 'alibi', option: 'ping', value: 'on' }), { ok: false, error: 'unavailable' });
});

// Bit saw a widget's options only through list_layer_widgets: only for a widget placed
// on the desktop or over a game, only with the app. A widget used as a dashboard tile,
// on a browser, a phone, a Mac or Linux had options Bit could not name.
test('the store lists every installed widget that offers options, with their values, for Bit', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xenon-wopt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const packages = async () => [
    { id: 'alibi', name: 'Alibi', options: Options.normalizeDeclared(DECLARED) },
    { id: 'plain', name: 'Plain', options: [] },
  ];
  const s = createWidgetOptions({ dataDir: dir, packages, announce: () => {} });
  await s.set('alibi', 'ping', 'on');
  assert.deepEqual(await s.list(), [{
    id: 'alibi', name: 'Alibi',
    options: [
      { id: 'form', kind: 'select', label: 'Shape', value: 'row', choices: ['min', 'row'] },
      { id: 'fps', kind: 'toggle', label: 'FPS', value: true },
      { id: 'ping', kind: 'toggle', label: 'Ping', value: true },
    ],
  }]);
});

test('list_widget_options reaches Bit on every surface; the layer list keeps the same shape', async () => {
  const d = { widgetOptions: { list: async () => [{ id: 'alibi', name: 'Alibi', options: [] }] } };
  assert.deepEqual(await capability.list(d), { ok: true, widgets: [{ id: 'alibi', name: 'Alibi', options: [] }] });
  assert.deepEqual(await capability.list({}), { ok: false, error: 'unavailable' });
  const { ACTION_CATALOG } = require('../js/deck-actions.js');
  const entry = ACTION_CATALOG.find((a) => a.type === 'widgetOptionList');
  assert.equal(entry.capability.ai.name, 'list_widget_options');
  assert.equal(entry.capability.requires, 'widgetOptions', 'never the app: a dashboard tile has options too');
  const set = ACTION_CATALOG.find((a) => a.type === 'widgetOption');
  assert.match(set.capability.ai.description, /list_widget_options/);
  assert.match(src('capabilities/index.js'), /case 'widgetOptionList': return widgetOption\.list\(d\);/);
  assert.match(engineSource('server/capabilities/layers.js'), /WidgetOptions\.describe\(pkg\.options, pkg\.optionValues\)/);
});

// A phone refused widgetOption: the switch did nothing there, and a view tapped inside a
// Maker widget on the phone sprang back. It only changes what a widget shows.
test('a paired phone changes what a widget shows, and reads the options', () => {
  const ra = require('../remote-actions.js');
  const none = { configs: {}, presets: [] };
  assert.deepEqual(ra.remoteMayRun({ type: 'widgetOption', widget: 'alibi', option: 'ping', value: 'on' }, none), { ok: true });
  assert.deepEqual(ra.remoteMayRun({ type: 'widgetOptionList' }, none), { ok: true });
});

const src = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the host hands the values in init, passes a change to every copy, and lets a widget set only its own', () => {
  const cw = src('js/custom-widget.js');
  assert.match(cw, /options: optionValuesOf\(entry\.pkgId\),/);
  assert.match(cw, /\{ type: 'options', values \}/);
  assert.match(cw, /\} else if \(d\.type === 'option'\) \{\r?\n\s+if \(entry\.ready\) onBridgeOption\(entry, d\);/);
  assert.match(cw, /type: 'widgetOption', widget: entry\.pkgId, option:/, 'its own package, never one it names');
  assert.match(cw, /!Array\.isArray\(pkg\.options\) \|\| !pkg\.options\.length\) \{ reply\(false, 'not_allowed'\)/);
  assert.match(src('js/widget-feed.js'), /sdk_options: \(cw, d\) => cw\.onOptionsChanged\(d\),/);
  assert.match(src('js/main.js'), /addEventListener\('sdk_options'/);
  const server = engineSource();
  assert.match(server, /announce: \(pkg\) => broadcastSSE\('sdk_options', \{ pkg \}\)/);
  assert.match(server, /optionValues: widgetOptionsStore\.valuesFor\(p\)/);
});
