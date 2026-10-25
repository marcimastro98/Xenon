// The in-app canvas scene editor (js/ambient-canvas-editor*.js): it changes an
// installed scene, never starts one; every option it offers must survive the
// normalizer; every word it shows exists in all 11 languages; it saves through
// settings.js without losing where the scene came from; and it cleans up after
// itself however it is closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const AS = require('../js/ambient-scene.js');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const EDITOR = read('../js/ambient-canvas-editor.js');
const FORM = read('../js/ambient-canvas-editor-form.js');
const FIELDS_SRC = read('../js/ambient-canvas-editor-fields.js');
const CANVAS = read('../js/ambient-canvas.js');
const SETTINGS = read('../js/settings.js');
const I18N = read('../js/i18n.js');
const INDEX = read('../index.html');

function loadFields() {
  const window = {};
  vm.runInNewContext(FIELDS_SRC, { window });
  return window.AmbientEditorFields;
}
const F = loadFields();
const TYPES = [...F.ADD_ORDER, 'sdk'];

function allKeys() {
  const keys = new Set();
  const walk = (groups) => groups.forEach(g => { if (g.title) keys.add(g.title); g.fields.forEach(f => { keys.add(f.label); (f.options || []).forEach(o => keys.add(o[1])); }); });
  for (const t of TYPES) { keys.add('ace_t_' + t); walk(F.elementGroups({ type: t, props: {} })); }
  walk(F.sceneGroups());
  for (const src of [EDITOR, FORM, SETTINGS]) for (const m of src.matchAll(/'(ace_[a-z0-9_]+)'/g)) if (!m[1].endsWith('_')) keys.add(m[1]);
  return [...keys];
}

test('the editor loads after the renderer it drives, with its own stylesheet', () => {
  const order = ['ambient-scene.js', 'ambient-canvas-parts.js', 'ambient-canvas.js', 'ambient-canvas-editor-fields.js', 'ambient-canvas-editor-form.js', 'ambient-canvas-editor.js']
    .map(f => INDEX.indexOf(`<script src="js/${f}"></script>`));
  assert.ok(order.every(i => i > 0), 'every script is on the page');
  assert.deepEqual(order, order.slice().sort((a, b) => a - b), 'in dependency order');
  assert.ok(INDEX.includes('<link rel="stylesheet" href="components/AmbientCanvasEditor/AmbientCanvasEditor.css">'));
});

test('every word the editor shows exists in all 11 languages', () => {
  const keys = allKeys();
  assert.ok(keys.length > 150, 'the key list was collected');
  const missing = keys.filter(k => (I18N.match(new RegExp('^  ' + k + ': ', 'gm')) || []).length !== 11);
  assert.deepEqual(missing, []);
});

test('every option the form offers is one the normalizer keeps', () => {
  const lost = [];
  for (const type of F.ADD_ORDER) {
    for (const g of F.elementGroups({ type, props: {} })) {
      for (const f of g.fields) {
        if (f.kind !== 'pick' || !f.path.startsWith('props.')) continue;
        const key = f.path.slice('props.'.length);
        for (const [v] of f.options) {
          const c = AS.normalizeComponent({ id: 'c1', type, x: 0, y: 0, w: 20, h: 20, props: { [key]: v } });
          if (String(c.props[key]) !== String(v)) lost.push(`${type}.${key}=${v}`);
        }
      }
    }
  }
  for (const [v] of F.elementGroups({ type: 'text', props: {} }).find(g => g.title === 'ace_sec_motion').fields[0].options) {
    const c = AS.normalizeComponent({ id: 'c1', type: 'text', x: 0, y: 0, w: 20, h: 20, props: {}, anim: { in: v, loop: 'none' } });
    if (v !== 'none' && (!c.anim || c.anim.in !== v)) lost.push('anim.in=' + v);
  }
  for (const [v] of F.sceneGroups()[1].fields[0].options) {
    const sc = AS.normalizeScene({ id: 'sc1', name: 'x', bg: { type: v, color: '#112233', url: 'data:image/webp;base64,AAAA', grad: { from: '#000000', to: '#ffffff' } }, components: [] });
    if (sc.bg.type !== v) lost.push('bg.type=' + v);
  }
  assert.deepEqual(lost, []);
});

test('new elements start inside the stage and are valid components', () => {
  for (const type of F.ADD_ORDER) {
    const [w, h] = F.NEW_SIZE[type];
    assert.ok(w >= 2 && w <= 100 && h >= 2 && h <= 100, type);
    const c = AS.normalizeComponent({ id: 'c1', type, x: Math.round(50 - w / 2), y: Math.round(50 - h / 2), w, h, props: F.NEW_PROPS[type] || {} });
    assert.ok(c && c.type === type, type);
  }
});

test('the editor only puts static icons into markup; names stay text', () => {
  assert.equal((EDITOR.match(/ace-btn-save/g) || []).length, 1, 'Save is the one primary action');
  for (const m of EDITOR.matchAll(/innerHTML = ([^;]+);/g)) assert.match(m[1], /^ICON\[icon\]$/, m[0]);
  assert.doesNotMatch(FORM, /innerHTML/);
  assert.match(EDITOR, /el\('button', 'ace-add-item', pkg\.name \|\| pkg\.id\)/, 'a widget name goes through textContent');
  assert.match(EDITOR, /p\.surface !== 'ambient'/, 'Ambient scenes are not offered as elements');
});

test('open and close pair every listener, and an outside close takes the editor down', () => {
  const open = EDITOR.slice(EDITOR.indexOf('  function open(id)'), EDITOR.indexOf('  function close()'));
  const close = EDITOR.slice(EDITOR.indexOf('  function close()'), EDITOR.indexOf('window.AmbientCanvasEditor'));
  for (const m of open.matchAll(/(\w+(?:\(\))?)\.addEventListener\('(\w+)', (\w+)\)/g)) {
    const target = m[1] === 'overlay()' ? 'o' : m[1];
    assert.ok(close.includes(`${target}.removeEventListener('${m[2]}', ${m[3]})`), `${m[1]} ${m[2]} is removed`);
  }
  assert.match(open, /onUnmount: \(\) => close\(\)/);
  assert.match(close, /if \(!s \|\| s\.closing\) return;/, 'close runs once even when unmount calls back');
  // The renderer runs the hook after teardown and keeps it across refreshes.
  assert.match(CANVAS, /const after = current && current\.onUnmount;\n    current = null;\n    if \(after\) after\(\);/);
  assert.match(CANVAS, /onUnmount: current\.onUnmount, edit/);
  // The global Escape leaves the editor alone (it closes its own panels first).
  assert.match(read('../js/main.js'), /if \(window\.AmbientCanvasEditor && AmbientCanvasEditor\.isOpen\(\)\) return;\n    if \(window\.AmbientMode && AmbientMode\.isOpen\(\)\)/);
});

test('saving keeps where the scene came from and refuses one that no longer fits', () => {
  const src = SETTINGS.slice(SETTINGS.indexOf('function saveAmbientScene(scene)'), SETTINGS.indexOf('window.saveAmbientScene = saveAmbientScene;'));
  const calls = [];
  const ctx = {
    AmbientScene: AS,
    hubSettings: { ambientScenes: [
      { id: 'sc1', name: 'One', imported: 'gallery', installId: 'i-1', components: [] },
      { id: 'sc2', name: 'Two', components: [] },
    ] },
    normalizeSettings: (x) => x,
    saveHubSettings: () => calls.push('save'),
    onAmbientScenesChanged: () => calls.push('changed'),
  };
  vm.runInNewContext(src + '\nthis.save = saveAmbientScene;', ctx);
  assert.equal(ctx.save({ id: 'sc1', name: 'Renamed', components: [] }), true);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.hubSettings.ambientScenes[0])), { id: 'sc1', name: 'Renamed', components: [], imported: 'gallery', installId: 'i-1' });
  assert.equal(ctx.hubSettings.ambientScenes[1].name, 'Two', 'the others are untouched');
  assert.deepEqual(calls, ['save', 'changed']);
  assert.equal(ctx.save({ id: 'gone', name: 'x', components: [] }), false, 'a deleted scene is not recreated');
  const huge = { id: 'sc2', name: 'Big', components: [], blob: 'x'.repeat(AS.SCENE_MAX_CHARS + 1) };
  assert.equal(ctx.save(huge), false);
  assert.equal(ctx.hubSettings.ambientScenes[1].name, 'Two', 'nothing is written when it does not fit');
});

test('Settings offers Edit next to Delete only when the editor is there', () => {
  const mgr = SETTINGS.slice(SETTINGS.indexOf('function renderAmbientSceneManager()'), SETTINGS.indexOf('function deleteAmbientScene('));
  assert.match(mgr, /const edit = window\.AmbientCanvasEditor\n\s+\? \[mk\(t\('ace_edit'\), '', \(\) => AmbientCanvasEditor\.open\(sc\.id\)\)\]\n\s+: \[\];/);
  assert.match(mgr, /acts\.append\(\.\.\.edit, mk\(t\('ambient_scene_delete'\)/);
});

test('the editor never offers a blank scene', () => {
  assert.doesNotMatch(EDITOR, /normalizeScene\(\{/, 'no scene is built from nothing');
  assert.match(EDITOR, /const found = list\.find\(x => x && x\.id === id\);\n    if \(!found\) return false;/);
});
