// Three safe action categories for widgets (v4.12.0): `benchmark` (start and
// stop, never 'reveal'), `gallery` (open with a filter, never an id) and
// `layers` (show or hide the widgets on the screen, switch their pages; never
// place, move or remove). Pinned on both doors (bridge and manifest macro), in
// the five places that move together, and the gallery opening on this screen
// from a dashboard but on the PC from a layer page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as readRaw } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const read = (rel) => readRaw(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const CW = read('../js/custom-widget.js');
const SETTINGS = read('../js/settings.js');
const I18N = read('../js/i18n.js');
const DOC = read('../../docs/WIDGET_SDK.md');
const sdk = require('../sdk-widgets.js');

function bridgeGate() {
  const grab = (re) => { const m = CW.match(re); assert.ok(m, String(re)); return m[0]; };
  const box = {};
  vm.createContext(box);
  vm.runInContext([
    grab(/const ACTION_CATEGORIES = \{[\s\S]*?\n {2}\};/),
    grab(/const ACTION_LIMITS = \{[\s\S]*?\n {2}\};/),
    grab(/function actionAllowed\(grant, action\) \{[\s\S]*?\n {2}\}/),
    'this.allowed = actionAllowed; this.cats = ACTION_CATEGORIES;',
  ].join('\n'), box);
  return box;
}

const CASES = {
  benchmark: {
    allowed: [{ type: 'benchmark' }, { type: 'benchmark', mode: 'toggle' }, { type: 'benchmark', mode: 'start' }, { type: 'benchmark', mode: 'stop' }],
    refused: [{ type: 'benchmark', mode: 'reveal' }, { type: 'benchmark', mode: 'junk' }],
  },
  gallery: {
    allowed: [{ type: 'gallery' }, { type: 'gallery', filter: 'video' }, { type: 'gallery', filter: 'all' }, { type: 'gallery', filter: 'screenshot' }],
    refused: [{ type: 'gallery', id: 'abc123' }, { type: 'gallery', id: '' }, { type: 'gallery', filter: 'recording' }],
  },
  layers: {
    allowed: [{ type: 'layersToggle' }, { type: 'layersToggle', mode: 'off', surface: 'overlay' }, { type: 'layerPage', page: 'next' }, { type: 'layerPage' },
      { type: 'xenonMenu' }, { type: 'xenonMenu', mode: 'open', section: 'keys' }, { type: 'xenonMenu', mode: 'close' }, { type: 'gameCompanion' }],
    refused: [],
  },
};

test('server: the three categories, and only what they say', () => {
  assert.deepEqual([...sdk.SDK_ACTION_CATEGORIES.benchmark], ['benchmark']);
  assert.deepEqual([...sdk.SDK_ACTION_CATEGORIES.gallery], ['gallery']);
  assert.deepEqual([...sdk.SDK_ACTION_CATEGORIES.layers], ['layersToggle', 'layerPage', 'screenDraw', 'xenonMenu', 'gameCompanion']);
  for (const { allowed, refused } of Object.values(CASES)) {
    for (const a of allowed) assert.equal(sdk.sdkActionWithinLimits(a), true, JSON.stringify(a));
    for (const a of refused) assert.equal(sdk.sdkActionWithinLimits(a), false, JSON.stringify(a));
  }
  // The user's own arrangement and settings stay out of every category.
  const all = Object.values(sdk.SDK_ACTION_CATEGORIES).flat();
  for (const t of ['layerPlace', 'layerRemove', 'layerMove', 'layerGroup', 'layersEdit', 'layerList', 'layersShortcut', 'layerPageEdit', 'galleryList', 'usageMode', 'aiEdgeGlow', 'deckShortcut']) {
    assert.equal(all.includes(t), false, t);
  }
});

test('bridge: same categories and limits as the server, nothing without the grant', () => {
  const box = bridgeGate();
  for (const cat of Object.keys(CASES)) {
    assert.deepEqual([...box.cats[cat]], [...sdk.SDK_ACTION_CATEGORIES[cat]], cat);
    const grant = { actions: [cat] };
    for (const a of CASES[cat].allowed) assert.equal(box.allowed(grant, a), true, JSON.stringify(a));
    for (const a of CASES[cat].refused) assert.equal(box.allowed(grant, a), false, JSON.stringify(a));
    for (const a of CASES[cat].allowed) assert.equal(box.allowed({ actions: ['capture'] }, a), false, JSON.stringify(a));
  }
});

test('manifest macros: a step installs with the category, a refused field or no category fails', () => {
  const manifest = (cat, action) => ({
    api: 1, name: 'Overlay kit', actions: cat ? [cat] : [],
    deck: { actions: [{ id: 'go', name: 'Go', steps: [{ action }] }] },
  });
  for (const [cat, { allowed, refused }] of Object.entries(CASES)) {
    assert.equal(sdk.normalizeManifest(manifest(cat, allowed[1]), 'overlay-kit').ok, true, JSON.stringify(allowed[1]));
    for (const a of refused) assert.equal(sdk.normalizeManifest(manifest(cat, a), 'overlay-kit').ok, false, JSON.stringify(a));
    assert.equal(sdk.normalizeManifest(manifest('', allowed[1]), 'overlay-kit').ok, false, cat);
  }
});

// The gallery branch of the bridge, run as written.
function galleryBranch({ layerPage, hasGallery }) {
  const at = CW.indexOf("    if (msg.action.type === 'gallery'");
  assert.ok(at > 0, 'the bridge opens the gallery itself on a dashboard');
  const end = CW.indexOf('\n    }\n', at) + 7;
  const opened = [];
  const posted = [];
  const window = hasGallery ? { CaptureGallery: { open: (o) => opened.push(o) } } : {};
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'isLayerPage', 'post', 'entry', 'reqId', 'msg',
    `${CW.slice(at, end)}\n    return 'server';`);
  return (action) => ({ went: run(window, () => layerPage, (_e, m) => posted.push(m), {}, 7, { action }) || 'here', opened, posted });
}

test('gallery: opens on this dashboard with the filter; from a layer page it goes to the server', () => {
  const r = galleryBranch({ layerPage: false, hasGallery: true })({ type: 'gallery', filter: 'video' });
  assert.equal(r.went, 'here');
  assert.deepEqual(r.opened, [{ filter: 'video' }]);
  assert.deepEqual(r.posted, [{ type: 'action_result', id: 7, ok: true }]);
  assert.deepEqual(galleryBranch({ layerPage: false, hasGallery: true })({ type: 'gallery', filter: 'all' }).opened, [{ filter: '' }]);
  assert.equal(galleryBranch({ layerPage: true, hasGallery: true })({ type: 'gallery' }).went, 'server');
  assert.equal(galleryBranch({ layerPage: false, hasGallery: false })({ type: 'gallery' }).went, 'server');
});

test('the five places: settings list, permission lines in 11 languages, docs', () => {
  assert.match(SETTINGS, /const SDK_WIDGET_ACTION_CATS = Object\.freeze\(\[[^\]]*'benchmark', 'gallery', 'layers'\]\)/);
  for (const cat of ['benchmark', 'gallery', 'layers']) {
    assert.match(CW, new RegExp(`\\n\\s+${cat}: \\['cw_act_${cat}', `));
    assert.equal((I18N.match(new RegExp(`\\n\\s+cw_act_${cat}: '`, 'g')) || []).length, 11, cat);
  }
  const i = DOC.indexOf('### 5c-quater. Benchmark, gallery and the widgets on the screen');
  assert.ok(i > 0);
  const sec = DOC.slice(i, DOC.indexOf('\n### ', i + 5));
  assert.match(sec, /`bench` in the `perf` stream/);
  assert.match(sec, /an `id` is refused/);
  assert.match(sec, /never rearrange another/);
  assert.match(DOC, /\| `layers` \| `layersToggle`, `layerPage`, `screenDraw`, `xenonMenu`, `gameCompanion` \|/);
});

// What comes back to the widget: the bridge's own filter, run as written.
function resultExtras() {
  const at = CW.indexOf('  const ACTION_RESULT_FIELDS = {');
  const end = CW.indexOf('\n  }\n', CW.indexOf('  function actionResultExtras(')) + 4;
  assert.ok(at > 0 && end > at, 'the bridge filters what an action returns');
  // eslint-disable-next-line no-new-func
  return new Function(`${CW.slice(at, end)}\n  return actionResultExtras;`)();
}

test('an action result carries only counts and yes/no, never text, a colour, a name or an id', () => {
  const ex = resultExtras();
  assert.deepEqual(ex('screenText', { ok: true, lines: 3, chars: 40, copied: true, text: 'secret' }), { lines: 3, chars: 40, copied: true });
  assert.deepEqual(ex('screenPin', { ok: true, pinned: 'w_9f2', surface: 'desktop', name: 'Screenshot 2026' }), { pinned: true, surface: 'desktop' });
  assert.deepEqual(ex('screenColor', { ok: true, hex: '#1E90FF', rgb: [30, 144, 255], text: '#1E90FF', copied: true }), {});
  assert.deepEqual(ex('screenMeasure', { ok: true, cancelled: true }), { cancelled: true });
  assert.deepEqual(ex('screenDraw', { ok: true, drawing: true }), { drawing: true });
  assert.deepEqual(ex('xenonMenu', { ok: true, where: 'screen', section: 'keys' }), { where: 'screen', section: 'keys' });
  assert.deepEqual(ex('xenonMenu', { ok: true, where: '/etc', section: '<b>' }), {});
  const { SECTIONS } = require('../screen-menu.js');
  for (const s of SECTIONS) assert.deepEqual(ex('xenonMenu', { ok: true, section: s }), { section: s }, 'every menu section passes');
  assert.deepEqual(ex('screenText', { ok: true, lines: 'x', copied: 'yes' }), {}, 'wrong types dropped');
  assert.deepEqual(ex('gameCompanion', { ok: true, opened: true, game: 'Elden Ring' }), {}, 'the game stays behind the perf grant');
  assert.deepEqual(ex('screenText', { ok: false, error: 'busy', lines: 2 }), {});
  assert.deepEqual(ex('constructor', { ok: true }), {});
  assert.match(CW, /error: \(d && d\.error\) \|\| \(d \? undefined : 'offline'\), \.\.\.actionResultExtras\(msg\.action\.type, d\) \}\);/);
});
