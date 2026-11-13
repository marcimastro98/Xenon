// A widget on the desktop, over a game or beside an app can let clicks pass
// through its box and take them back (the SDK `layer` message, v5.0.0). It can
// only give clicks away from itself, so it needs no grant; what keeps it honest
// is where it is refused. A widget beside an app is never offered a full screen
// it cannot have, and one opened at full size on a layer window fills it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const BRIDGE = read('../js/custom-widget.js');
const LAYER_CSS = read('../components/LayerHost/LayerHost.css');
const DOC = read('../../docs/WIDGET_SDK.md');

// The handler and what it leans on, run as they are written in the bridge.
function bridge(layerHost) {
  const start = BRIDGE.indexOf('  function layerRectsChanged() {');
  const fn = BRIDGE.indexOf('  function onBridgeLayer(', start);
  assert.ok(start !== -1 && fn !== -1, 'js/custom-widget.js must still define layerRectsChanged and onBridgeLayer');
  const end = BRIDGE.indexOf('\n  }\n', fn) + 4;
  const posted = [];
  const refreshed = { n: 0 };
  const ctx = {
    window: { LayerHost: layerHost && { ...layerHost, refreshRects: () => { refreshed.n++; } } },
    post: (_entry, msg) => posted.push(msg),
  };
  vm.createContext(ctx);
  vm.runInContext(BRIDGE.slice(start, end) + '\nthis.api = { onBridgeLayer, anchoredLayer };', ctx);
  return { ...ctx.api, posted, refreshed };
}

const tile = () => ({ frame: makeDom().document.createElement('iframe') });
const OVERLAY = { active: true, surface: 'overlay' };

test('on a layer window a widget lets clicks through, and takes them back', () => {
  const { onBridgeLayer, posted, refreshed } = bridge(OVERLAY);
  const entry = tile();
  onBridgeLayer(entry, { through: true, id: 7 });
  assert.equal(entry.frame.hasAttribute('data-layer-through'), true);
  assert.equal(refreshed.n, 1, 'the window is cut again');
  assert.deepEqual({ ...posted.at(-1) }, { type: 'layer_result', id: 7, ok: true, error: undefined });
  onBridgeLayer(entry, { through: false, id: 'back' });
  assert.equal(entry.frame.hasAttribute('data-layer-through'), false);
  assert.equal(refreshed.n, 2);
  assert.equal(posted.at(-1).ok, true);
  assert.equal(posted.at(-1).id, 'back');
});

test('anything but true or false is refused and changes nothing', () => {
  const { onBridgeLayer, posted, refreshed } = bridge(OVERLAY);
  const entry = tile();
  for (const through of ['true', 1, 0, null, undefined, {}]) {
    onBridgeLayer(entry, { through, id: {} });
    assert.equal(posted.at(-1).error, 'bad_request', String(through));
    assert.equal(posted.at(-1).id, null, 'an id that is not a string or number is not echoed');
  }
  assert.equal(entry.frame.hasAttribute('data-layer-through'), false);
  assert.equal(refreshed.n, 0);
});

test('off a layer window, or from a frame that is not a tile, it is refused', () => {
  for (const [host, over] of [[undefined, {}], [{ active: false }, {}], [OVERLAY, { service: true }], [OVERLAY, { ambient: true }]]) {
    const { onBridgeLayer, posted, refreshed } = bridge(host);
    const entry = { ...tile(), ...over };
    onBridgeLayer(entry, { through: true, id: 1 });
    assert.equal(posted.at(-1).ok, false);
    assert.equal(posted.at(-1).error, 'not_in_layer', JSON.stringify({ host, over }));
    assert.equal(entry.frame.hasAttribute('data-layer-through'), false);
    assert.equal(refreshed.n, 0);
  }
});

test('only a widget that said hello is heard, and one that starts again takes clicks', () => {
  assert.match(BRIDGE, /d\.type === 'layer'\) \{\n\s+if \(entry\.ready\) onBridgeLayer\(entry, d\);/);
  const hello = BRIDGE.slice(BRIDGE.indexOf("if (d.type === 'hello') {"), BRIDGE.indexOf("type: 'init',"));
  assert.match(hello, /entry\.frame\.removeAttribute\('data-layer-through'\);\n\s+layerRectsChanged\(\);/);
});

test('a widget beside an app is never offered a full screen it cannot have', () => {
  assert.equal(bridge({ active: true, surface: 'anchor' }).anchoredLayer(), true);
  for (const host of [OVERLAY, { active: true, surface: 'desktop' }, { active: false }, undefined]) {
    assert.equal(bridge(host).anchoredLayer(), false, JSON.stringify(host));
  }
  assert.match(BRIDGE, /expand: grant\.expand && !entry\.service && !entry\.ambient && !anchoredLayer\(\),/);
  assert.match(BRIDGE, /if \(anchoredLayer\(\) \|\| !expandWidget\(entry\)\) \{ reply\(false, 'unavailable'\); return; \}/);
});

test('opened at full size on a layer window, the widget fills it and the window is cut again', () => {
  const body = (name) => {
    const at = BRIDGE.indexOf(`  function ${name}(`);
    assert.notEqual(at, -1, `${name} is gone`);
    return BRIDGE.slice(at, BRIDGE.indexOf('\n  }\n', at));
  };
  assert.match(body('expandWidget'), /layerRectsChanged\(\);/);
  assert.match(body('collapseExpanded'), /layerRectsChanged\(\);/);
  const rule = LAYER_CSS.slice(LAYER_CSS.indexOf('.layer-slot:has(.cw-wrap.cw-expanded) {'));
  assert.notEqual(LAYER_CSS.indexOf('.layer-slot:has(.cw-wrap.cw-expanded) {'), -1, 'LayerHost.css grows the box of an expanded widget');
  const block = rule.slice(0, rule.indexOf('}'));
  for (const decl of ['left: 0;', 'top: 0;', 'width: 100%;', 'height: 100%;', 'opacity: 1;']) assert.ok(block.includes(decl), decl);
});

test('the SDK guide says how, when it is refused, and what the user keeps', () => {
  const at = DOC.indexOf("type: 'layer'");
  assert.notEqual(at, -1, 'docs/WIDGET_SDK.md documents the layer message');
  for (const word of ["type: 'layer_result'", 'not_in_layer', 'bad_request']) assert.ok(DOC.includes(word), word);
});
