// The capability catalog: one declaration per feature, offered to the Deck and
// Xenon AI, and always executed through actions/registry.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync as readFileSyncRaw } from 'node:fs';
const readFileSync = (p) => readFileSyncRaw(p, 'utf8').replace(/\r\n/g, '\n');

const require = createRequire(import.meta.url);
const { CAPABILITIES } = require('../js/capability-catalog.js');
const { ACTION_CATALOG, validateAction } = require('../js/deck-actions.js');
const { createRegistry } = require('../actions/registry.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const SERVER = readFileSync(new URL('../server.js', import.meta.url));
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url));

const RISKS = ['safe', 'sensitive'];
const DOMAINS = ['layers', 'perf', 'capture', 'gallery', 'ai', 'deck'];

// ── The catalog itself ───────────────────────────────────────────────────────

test('every capability is a well-formed Deck action with a capability block', () => {
  const types = new Set();
  const aiNames = new Set();
  for (const c of CAPABILITIES) {
    assert.ok(!types.has(c.type), `duplicate type ${c.type}`);
    types.add(c.type);
    assert.ok(Array.isArray(c.params), c.type);
    assert.ok(c.labelKey, c.type);
    const cap = c.capability;
    assert.ok(DOMAINS.includes(cap.domain), `${c.type}: domain ${cap.domain}`);
    assert.ok(RISKS.includes(cap.risk), `${c.type}: risk ${cap.risk} (there is no "dangerous" tier)`);
    assert.equal(typeof cap.requires, 'string', `${c.type}: requires names a capability`);
    if (cap.ai) {
      assert.match(cap.ai.name, /^[a-z][a-z0-9_]*$/, c.type);
      assert.ok(!aiNames.has(cap.ai.name), `duplicate AI name ${cap.ai.name}`);
      aiNames.add(cap.ai.name);
      assert.ok(cap.ai.description.length > 40, `${c.type}: the AI needs a real description`);
    }
  }
});

test('capability types never collide with an existing Deck action', () => {
  const counts = new Map();
  for (const a of ACTION_CATALOG) counts.set(a.type, (counts.get(a.type) || 0) + 1);
  for (const c of CAPABILITIES) assert.equal(counts.get(c.type), 1, c.type);
});

test('the Deck catalog carries the capabilities, so they validate like any key', () => {
  for (const c of CAPABILITIES) {
    assert.ok(ACTION_CATALOG.includes(c), c.type);
    // A strict choice has no default: the action is invalid without one.
    // (an optional strict one, like sensorHistory's interval, may be left out).
    if (c.params.some(p => p.strict && !p.optional)) assert.equal(validateAction({ type: c.type }), null, c.type);
    else assert.equal(validateAction({ type: c.type }).type, c.type);
  }
  assert.deepEqual(validateAction({ type: 'perfStats', path: 'C:/x.exe' }), { type: 'perfStats' });
  // Deleting the game history is never what a missing or mistyped mode means.
  assert.equal(validateAction({ type: 'gameSessionsSet', mode: 'wipe' }), null);
  assert.deepEqual(validateAction({ type: 'gameSessionsSet', mode: 'clear' }), { type: 'gameSessionsSet', mode: 'clear' });
});

test('every capability label exists in all 11 languages', () => {
  for (const c of CAPABILITIES) {
    const n = I18N.split('\n').filter(l => l.trim().startsWith(`${c.labelKey}:`)).length;
    assert.equal(n, 11, `${c.labelKey} in ${n} languages`);
  }
});

test('both pages load the catalog before the Deck actions', () => {
  for (const page of ['../index.html', '../deck-popup.html']) {
    const html = readFileSync(new URL(page, import.meta.url));
    const cat = html.indexOf('js/capability-catalog.js');
    assert.ok(cat > 0 && cat < html.indexOf('js/deck-actions.js'), page);
  }
});

// ── AI ────────────────────────────────────────────────────────────────────────

test('AI declarations are generated from the catalog in Gemini format', () => {
  const fns = aiFunctions({});
  const perf = fns.find(f => f.name === 'get_game_performance');
  assert.ok(perf);
  assert.equal(perf.parameters.type, 'OBJECT');
  assert.deepEqual(perf.parameters.properties, {});
  assert.equal(perf.parameters.required, undefined);
});

test('the AI is not offered what this machine cannot do', () => {
  assert.ok(aiFunctions({ frameStats: true }).some(f => f.name === 'get_game_performance'));
  assert.ok(!aiFunctions({ frameStats: false }).some(f => f.name === 'get_game_performance'));
});

test('an AI call becomes its Deck action, with only catalog params', () => {
  assert.deepEqual(aiAction('get_game_performance', { evil: 'x' }), { type: 'perfStats' });
  assert.equal(aiAction('toggle_mic', {}), null);
  assert.equal(aiAction('get_game_performance', null).type, 'perfStats');
});

test('server.js offers the generated functions and runs calls through deckRegistry', () => {
  assert.match(SERVER, /\.\.\.capabilities\.aiFunctions\(capabilityRunner\.probes\(\)\)/);
  assert.match(SERVER, /fnResult = await runAction\(capabilities\.aiAction\(fnName, fnArgs\)\)/);
  assert.match(SERVER, /const runAction = async \(action\) => \{[\s\S]{0,300}: deckRegistry\.run\(action\);/);
  assert.match(SERVER, /runCapability: \(action\) => capabilityRunner\.run\(action\)/);
  assert.match(SERVER, /\.\.\.capabilityRunner\.probes\(\) \} \}\);/);
});

// ── Running ──────────────────────────────────────────────────────────────────

const STATS = { process: 'game.exe', side: 'display', count: 1500, avgFps: 142.3, low1Fps: 98.1, low01Fps: 71.4, p99Ms: 10.2, maxMs: 14 };
const fakeFps = (over = {}) => ({
  backend: 'presentmon', isAvailable: () => true,
  getFrameStats: () => STATS, getFpsDetail: () => ({ fps: 141, presentFps: 141, displayFps: 141 }),
  ...over,
});

test('the registry hands a validated capability to the runner', async () => {
  const seen = [];
  const reg = createRegistry({ runCapability: async (a) => { seen.push(a); return { ok: true, x: 1 }; } });
  assert.deepEqual(await reg.run({ type: 'perfStats', junk: 1 }), { ok: true, x: 1 });
  assert.deepEqual(seen, [{ type: 'perfStats' }]);
});

test('without a runner the registry says unavailable rather than pretending', async () => {
  assert.deepEqual(await createRegistry({}).run({ type: 'perfStats' }), { ok: false, error: 'unavailable' });
});

test('perfStats returns the frame rate with its lows', async () => {
  const r = await createCapabilities({ fps: fakeFps() }).run({ type: 'perfStats' });
  assert.deepEqual(r, { ok: true, process: 'game.exe', fps: 141, presentFps: 141, displayFps: 141, side: 'display', frames: 1500, avgFps: 142.3, low1Fps: 98.1, low01Fps: 71.4, p99Ms: 10.2, maxMs: 14, exclusive: false });
});

test('perfStats says no_game when nothing presents frames', async () => {
  const r = await createCapabilities({ fps: fakeFps({ getFrameStats: () => null }) }).run({ type: 'perfStats' });
  assert.deepEqual(r, { ok: false, error: 'no_game' });
});

test('frame statistics are only claimed where every frame is seen', () => {
  assert.equal(createCapabilities({ fps: fakeFps() }).probes().frameStats, true);
  assert.equal(createCapabilities({ fps: fakeFps({ isAvailable: () => false }) }).probes().frameStats, false);
  assert.equal(createCapabilities({ fps: fakeFps({ backend: 'mangohud' }) }).probes().frameStats, false);
  assert.equal(createCapabilities({ fps: fakeFps({ backend: null }) }).probes().frameStats, false);
  assert.equal(createCapabilities({}).probes().frameStats, false);
});

test('a capability the machine cannot do is refused before it runs', async () => {
  let called = false;
  const fps = fakeFps({ isAvailable: () => false, getFrameStats: () => { called = true; return STATS; } });
  assert.deepEqual(await createCapabilities({ fps }).run({ type: 'perfStats' }), { ok: false, error: 'unavailable' });
  assert.equal(called, false);
});

test('the runner refuses anything that is not a capability', async () => {
  assert.deepEqual(await createCapabilities({}).run({ type: 'openApp' }), { ok: false, error: 'unsupported' });
  assert.deepEqual(await createCapabilities({}).run(null), { ok: false, error: 'unsupported' });
});

// ── Layers ───────────────────────────────────────────────────────────────────

const { createLayersEdit } = require('../layers-edit.js');
const LayersModel = require('../js/layers-model.js');

// A settings store in memory with the same contract as server.js
// updateLayersSetting: the edit sees the current value, { error } writes nothing.
function fakeLayers(initial, catalog) {
  const state = { layers: initial, writes: 0 };
  return {
    state,
    get: () => state.layers,
    update: async (edit) => {
      const res = edit(state.layers);
      if (!res || res.error || !res.layers) return res || { error: 'failed' };
      state.layers = LayersModel.normalize(res.layers);
      state.writes++;
      return { ...res, layers: state.layers };
    },
    catalog: async () => catalog || { tiles: ['weather', 'media', 'system'], packages: [{ id: 'wall-plate', name: 'Wall Plate' }] },
  };
}
const shell = (over = {}) => ({ available: () => true, secondMonitor: () => 'DISPLAY2', ...over });
const runner = (layers, host = shell()) => createCapabilities({ layers, layersHost: host });

test('the layer option lists in the catalog match js/layers-model.js', () => {
  const place = CAPABILITIES.find(c => c.type === 'layerPlace');
  const opt = (n) => place.params.find(p => p.name === n).options;
  assert.deepEqual([...opt('position')].sort(), [...LayersModel.POSITIONS].sort());
  assert.deepEqual([...opt('size')].sort(), Object.keys(LayersModel.SIZES).sort());
  assert.ok(opt('surface').every(s => LayersModel.SURFACES.includes(s)));
});

test('layers are offered only while a shell draws them', () => {
  assert.equal(createCapabilities({}).probes().layers, false);
  assert.equal(runner(fakeLayers(), shell({ available: () => false })).probes().layers, false);
  assert.equal(runner(fakeLayers()).probes().layers, true);
  assert.ok(!aiFunctions({ layers: false }).some(f => f.name === 'place_widget'));
  const place = aiFunctions({ layers: true }).find(f => f.name === 'place_widget');
  assert.deepEqual(place.parameters.required, ['widget']);
  assert.deepEqual(place.parameters.properties.surface.enum, ['desktop', 'overlay']);
});

test('"put the weather top left, small" places it and turns layers on', async () => {
  const L = fakeLayers();
  const action = aiAction('place_widget', { widget: 'Weather', position: 'top-left', size: 'small' });
  const r = await createRegistry({ runCapability: (a) => runner(L).run(a) }).run(action);
  assert.equal(r.ok, true);
  assert.deepEqual({ ...r.placed, id: 'x' }, { id: 'x', widget: 'weather', surface: 'desktop', screen: 'main', show: 'always' });
  assert.equal(L.state.layers.enabled, true);
  assert.deepEqual(L.state.layers.widgets[0].rect, LayersModel.rectFor('top-left', 'small'));
});

test('a Store widget is found by its name and placed by its package id', async () => {
  const L = fakeLayers();
  const r = await runner(L).run({ type: 'layerPlace', widget: 'wall plate', surface: 'overlay', position: 'center', size: 'large', screen: 'main' });
  assert.equal(r.ok, true);
  assert.deepEqual(L.state.layers.widgets[0].kind, 'sdk');
  assert.deepEqual(L.state.layers.widgets[0].pkg, 'wall-plate');
  assert.equal(r.placed.widget, 'Wall Plate');
});

test('an unknown widget writes nothing and tells the AI what exists', async () => {
  const L = fakeLayers();
  const r = await runner(L).run({ type: 'layerPlace', widget: 'toaster', surface: 'desktop', position: 'top', size: 'small', screen: 'main' });
  assert.equal(r.error, 'unknown_widget');
  assert.deepEqual(r.choices, { tiles: ['weather', 'media', 'system'], widgets: ['Wall Plate'] });
  assert.equal(L.state.writes, 0);
});

test('"on my other monitor" needs one, and uses its key', async () => {
  const L = fakeLayers();
  const none = await runner(L, shell({ secondMonitor: () => '' })).run({ type: 'layerPlace', widget: 'media', screen: 'second' });
  assert.deepEqual(none, { ok: false, error: 'no_second_screen' });
  const ok = await runner(L).run({ type: 'layerPlace', widget: 'media', screen: 'second' });
  assert.equal(ok.placed.screen, 'other');
  assert.equal(L.state.layers.widgets[0].monitor, 'DISPLAY2');
});

test('edit mode asks for the pictures; the list Bit reads stays without addresses', async () => {
  const L = fakeLayers();
  L.shots = async () => ({ 'wall-plate': 'https://assets.example/wall.webp' });
  const run = runner(L);
  assert.equal((await run.run({ type: 'layerList' })).pictures, undefined);
  assert.equal(validateAction({ type: 'layerList', pictures: 'yes' }).pictures, 'yes', 'the field survives the check every action goes through');
  const { pictures } = await run.run({ type: 'layerList', pictures: 'yes' });
  assert.equal(pictures.weather, 'assets/tile-previews/weather.webp');
  assert.equal(pictures['Wall Plate'], 'https://assets.example/wall.webp');
});

test('list, remove by name and the show/hide switch', async () => {
  const L = fakeLayers();
  const run = runner(L);
  await run.run({ type: 'layerPlace', widget: 'weather' });
  await run.run({ type: 'layerPlace', widget: 'weather', surface: 'overlay' });
  await run.run({ type: 'layerPlace', widget: 'Wall Plate' });
  const list = await run.run({ type: 'layerList' });
  assert.equal(list.enabled, true);
  assert.deepEqual(list.placed.map(p => p.widget), ['weather', 'weather', 'Wall Plate']);

  assert.equal(list.overlayShortcut, 'Ctrl + Shift + F9');
  assert.equal(list.hidden, undefined);

  assert.deepEqual(await run.run({ type: 'layersToggle', mode: 'toggle' }), { ok: true, surface: 'all', shown: false, enabled: false });
  assert.deepEqual(await run.run({ type: 'layersToggle', mode: 'on' }), { ok: true, surface: 'all', shown: true, enabled: true });
  assert.equal(L.state.layers.widgets.length, 3, 'hiding keeps every placement');

  // Only the widgets over the game: the desktop ones stay.
  assert.deepEqual(await run.run({ type: 'layersToggle', mode: 'toggle', surface: 'overlay' }), { ok: true, surface: 'overlay', shown: false, enabled: true });
  assert.deepEqual(L.state.layers.hidden, ['overlay']);
  assert.deepEqual((await run.run({ type: 'layerList' })).hidden, ['overlay']);
  assert.deepEqual(await run.run({ type: 'layersToggle', mode: 'toggle', surface: 'overlay' }), { ok: true, surface: 'overlay', shown: true, enabled: true });
  assert.deepEqual(L.state.layers.hidden, []);
  // An unknown surface is the whole switch, never a write to a made-up key.
  assert.equal((await run.run({ type: 'layersToggle', mode: 'off', surface: 'kitchen' })).surface, 'all');
  assert.equal(L.state.layers.enabled, false);
  // Showing one surface with everything off shows that one alone.
  assert.deepEqual(await run.run({ type: 'layersToggle', mode: 'on', surface: 'overlay' }), { ok: true, surface: 'overlay', shown: true, enabled: true });
  assert.deepEqual(L.state.layers.hidden, ['desktop', 'anchor']);
  await run.run({ type: 'layersToggle', mode: 'on' });

  assert.deepEqual(await run.run({ type: 'layerRemove', target: 'Weather' }), { ok: true, removed: 2 });
  assert.deepEqual(await run.run({ type: 'layerRemove', target: 'Wall Plate' }), { ok: true, removed: 1 });
  assert.deepEqual(await run.run({ type: 'layerRemove', target: 'weather' }), { ok: false, error: 'not_found' });
});

test('the overlay shortcut: default, a new combo, off, and the ones that are taken', async () => {
  const L = fakeLayers();
  const run = runner(L);
  const placed = await run.run({ type: 'layerPlace', widget: 'weather', surface: 'overlay' });
  assert.equal(placed.toggleShortcut, 'Ctrl + Shift + F9', 'the AI can say how to hide it');
  assert.equal((await run.run({ type: 'layerPlace', widget: 'media' })).toggleShortcut, undefined, 'desktop widgets have none');

  assert.deepEqual(await run.run({ type: 'layersShortcut', combo: 'Alt+Shift+O' }), { ok: true, key: 'overlay', shortcut: 'Alt + Shift + O' });
  assert.equal(L.state.layers.overlayKey, 'alt+shift+o');
  assert.deepEqual(await run.run({ type: 'layersShortcut', combo: 'none' }), { ok: true, key: 'overlay', shortcut: 'off' });
  assert.equal(L.state.layers.overlayKey, 'off');
  assert.equal((await run.run({ type: 'layerPlace', widget: 'system', surface: 'overlay' })).toggleShortcut, undefined);
  assert.deepEqual(await run.run({ type: 'layersShortcut', combo: '' }), { ok: true, key: 'overlay', shortcut: 'Ctrl + Shift + F9' });

  const writes = L.state.writes;
  assert.equal((await run.run({ type: 'layersShortcut', combo: 'alt+f10' })).error, 'reserved', 'NVIDIA instant replay');
  assert.equal((await run.run({ type: 'layersShortcut', combo: 'banana' })).error, 'bad_shortcut');
  assert.equal(L.state.writes, writes, 'a refused combo writes nothing');
  assert.equal(L.state.layers.overlayKey, 'ctrl+shift+f9');

  // A search, page or Deck key shortcut on the same combo: named, nothing written.
  const asked = [];
  const held = createCapabilities({ layers: L, layersHost: shell(), deck: { heldBy: (c, except) => { asked.push([c, except]); return c === 'ctrl+alt+f7' ? 'Foto' : ''; } } });
  assert.deepEqual(await held.run({ type: 'layersShortcut', combo: 'ctrl+alt+f7', key: 'menu' }), { ok: false, error: 'in_use', by: 'Foto' });
  assert.deepEqual(asked, [['ctrl+alt+f7', 'menu']], 'its own slot does not count');
  assert.equal(L.state.writes, writes);
});

test('the controller chord: on, off, toggle, and nothing else', async () => {
  const L = fakeLayers();
  const run = runner(L);
  assert.deepEqual(await run.run({ type: 'layersShortcut', key: 'pad', combo: 'off' }), { ok: true, key: 'pad', shortcut: 'off' });
  assert.equal(L.state.layers.menuPad, false);
  assert.deepEqual(await run.run({ type: 'layersShortcut', key: 'pad', combo: 'toggle' }), { ok: true, key: 'pad', shortcut: 'on' });
  assert.deepEqual(await run.run({ type: 'layersShortcut', key: 'pad', combo: '' }), { ok: true, key: 'pad', shortcut: 'on' }, 'empty = the default, on');
  const writes = L.state.writes;
  assert.equal((await run.run({ type: 'layersShortcut', key: 'pad', combo: 'ctrl+alt+p' })).error, 'bad_shortcut', 'a pad has no combo');
  assert.equal(L.state.writes, writes);
  assert.equal(L.state.layers.menuKey, 'alt+shift+x', 'the keyboard shortcut is untouched');
});

test('widgets in captures: on, off, toggle, only where the shell can keep them out', async () => {
  const L = fakeLayers();
  const run = runner(L, shell({ hides: () => true }));
  assert.equal(run.probes().layersCaptures, true);
  assert.deepEqual(await run.run({ type: 'layersCaptures', mode: 'on' }), { ok: true, shown: true });
  assert.equal(L.state.layers.excludeFromCapture, false);
  assert.deepEqual(await run.run({ type: 'layersCaptures', mode: 'toggle' }), { ok: true, shown: false });
  assert.equal(L.state.layers.excludeFromCapture, true);
  assert.deepEqual(await run.run({ type: 'layersCaptures' }), { ok: true, shown: true }, 'no mode = toggle');
  const writes = L.state.writes;
  assert.equal((await run.run({ type: 'layersCaptures', mode: 'maybe' })).error, 'bad_mode');
  assert.equal(L.state.writes, writes);
  const elsewhere = runner(fakeLayers(), shell());
  assert.equal(elsewhere.probes().layersCaptures, false, 'a shell that cannot keep windows out offers nothing');
  assert.deepEqual(await elsewhere.run({ type: 'layersCaptures', mode: 'on' }), { ok: false, error: 'unavailable' });
  assert.deepEqual(aiAction('show_widgets_in_captures', { mode: 'on', junk: 1 }), { type: 'layersCaptures', mode: 'on' });
});

test('edit mode brings back a hidden surface, so every widget can be moved', async () => {
  const L = fakeLayers();
  let on = false;
  const run = createCapabilities({ layers: L, layersHost: shell(), layersEdit: { get: () => on, set: (v) => (on = v) } });
  await run.run({ type: 'layerPlace', widget: 'weather', surface: 'overlay' });
  await run.run({ type: 'layersToggle', mode: 'off', surface: 'overlay' });
  assert.deepEqual(L.state.layers.hidden, ['overlay']);
  assert.equal((await run.run({ type: 'layersEdit', mode: 'on' })).editing, true);
  assert.deepEqual(L.state.layers.hidden, []);
});

test('placing a widget on a hidden surface shows that surface again', async () => {
  const L = fakeLayers();
  const run = runner(L);
  await run.run({ type: 'layerPlace', widget: 'weather', surface: 'overlay' });
  await run.run({ type: 'layersToggle', mode: 'off', surface: 'overlay' });
  await run.run({ type: 'layerPlace', widget: 'media', surface: 'overlay' });
  assert.deepEqual(L.state.layers.hidden, []);
});

test('the 25th widget is refused without writing', async () => {
  const L = fakeLayers();
  const run = runner(L);
  for (let i = 0; i < 24; i++) assert.equal((await run.run({ type: 'layerPlace', widget: 'system' })).ok, true);
  const writes = L.state.writes;
  assert.deepEqual(await run.run({ type: 'layerPlace', widget: 'system' }), { ok: false, error: 'too_many' });
  assert.equal(L.state.writes, writes);
});

test('server.js gives the runner the shell report, the settings lock and the real widget list', () => {
  assert.match(SERVER, /settings: \{\n\s+setAiEdgeGlow: \(mode\) => updateAiEdgeGlowSetting\(mode\),\n\s+setUsageMode: \(mode\) => updateUsageModeSetting\(mode\),\n\s+setScreenAlerts: \(on\) => updateScreenAlertsSetting\(on\),\n\s+setDesktopScene: \(patch\) => updateDesktopSceneSetting\(patch\),\n\s+desktopScenes: async [^\n]+\n\s+\},/);
  assert.match(SERVER, /layersHost,\n\s+layersEdit,\n\s+drawShell,\n\s+\/\/ Open windows.*\n\s+windows: \(\) => runWindowsTool\(\['list'\], 8000\),\n\s+menu: screenMenu,\n\s+settings: \{\n(?:.*\n){5}\s+\},\n\s+layers: \{\n\s+get: \(\) => _serverHubSettings && _serverHubSettings\.layers,\n\s+update: \(edit\) => updateLayersSetting\(edit\),/);
  assert.match(SERVER, /tiles: DASHBOARD_WIDGET_IDS\.filter\(id => !LAYER_TILE_EXCLUDED\.has\(id\)\)/);
});

test('"put the music as a tab under the weather": one box, the music shown, and back out', async () => {
  const L = fakeLayers();
  const run = runner(L);
  await run.run({ type: 'layerPlace', widget: 'weather' });
  await run.run({ type: 'layerPlace', widget: 'media', position: 'bottom-left' });
  const joined = await run.run({ type: 'layerGroup', widget: 'media', with: 'Weather' });
  assert.equal(joined.ok, true);
  const [weather, media] = L.state.layers.widgets;
  assert.equal(media.group, weather.group);
  assert.deepEqual(media.rect, weather.rect, 'the tab takes the box it joins');
  assert.equal(joined.widget.active, true);
  const list = await run.run({ type: 'layerList' });
  assert.deepEqual(list.placed.map(p => [p.widget, p.group === weather.group, p.active]), [['weather', true, false], ['media', true, true]]);

  const left = await run.run({ type: 'layerGroup', widget: 'media', mode: 'leave' });
  assert.equal(left.ok, true);
  assert.equal(left.widget.group, undefined);
  assert.equal(L.state.layers.widgets.some(w => w.group), false, 'a tab left alone is a plain widget again');
});

test('grouping names what is wrong and writes nothing', async () => {
  const L = fakeLayers();
  const run = runner(L);
  await run.run({ type: 'layerPlace', widget: 'weather' });
  await run.run({ type: 'layerPlace', widget: 'weather', surface: 'overlay' });
  await run.run({ type: 'layerPlace', widget: 'system' });
  const writes = L.state.writes;
  const amb = await run.run({ type: 'layerGroup', widget: 'system', with: 'weather' });
  assert.equal(amb.error, 'ambiguous');
  assert.equal(amb.ids.length, 2, 'the ids to use instead');
  assert.equal((await run.run({ type: 'layerGroup', widget: 'media', with: 'system' })).error, 'not_placed');
  assert.equal((await run.run({ type: 'layerGroup', widget: 'system', with: 'system' })).error, 'same_widget');
  assert.equal((await run.run({ type: 'layerGroup', widget: 'system', mode: 'leave' })).error, 'not_grouped');
  assert.equal(L.state.writes, writes);
  const byId = await run.run({ type: 'layerGroup', widget: 'system', with: amb.ids[0] });
  assert.equal(byId.ok, true, 'an id from the list picks the copy');
});

// A widget sized by its own content (manifest `fit`) has no box to share: Bit
// gets a reason instead of a tab group the screen could not draw.
test('a widget sized by itself is never a tab, on either side', async () => {
  const catalog = { tiles: ['weather', 'media', 'system'], packages: [{ id: 'alibi', name: 'Alibi', fit: true }] };
  const L = fakeLayers(undefined, catalog);
  const run = runner(L);
  await run.run({ type: 'layerPlace', widget: 'weather' });
  await run.run({ type: 'layerPlace', widget: 'Alibi' });
  const writes = L.state.writes;
  assert.equal((await run.run({ type: 'layerGroup', widget: 'Alibi', with: 'weather' })).error, 'sized_by_itself');
  assert.equal((await run.run({ type: 'layerGroup', widget: 'weather', with: 'Alibi' })).error, 'sized_by_itself');
  assert.equal(L.state.writes, writes);
});

test('"move the weather bottom left, bigger": position and size by name, or kept', async () => {
  const L = fakeLayers();
  const run = runner(L);
  await run.run({ type: 'layerPlace', widget: 'weather', size: 'small' });
  const moved = await run.run({ type: 'layerMove', target: 'weather', position: 'bottom-left', size: 'keep' });
  assert.equal(moved.ok, true);
  assert.deepEqual(L.state.layers.widgets[0].rect, LayersModel.rectFor('bottom-left', 'small'));
  const bigger = await run.run({ type: 'layerMove', target: 'weather', position: 'keep', size: 'large' });
  const r = L.state.layers.widgets[0].rect;
  assert.equal(bigger.ok, true);
  assert.deepEqual([r.w, r.h], LayersModel.SIZES.large);
  assert.equal(r.x, LayersModel.rectFor('bottom-left', 'small').x, 'the place is kept');
});

test('a placed widget changes place and screen, and its tabs go with it', async () => {
  const L = fakeLayers();
  const run = runner(L);
  await run.run({ type: 'layerPlace', widget: 'weather' });
  await run.run({ type: 'layerPlace', widget: 'media' });
  await run.run({ type: 'layerGroup', widget: 'media', with: 'weather' });
  const id = L.state.layers.widgets.find((w) => w.widget === 'media').id;
  const over = await run.run({ type: 'layerMove', target: id, surface: 'overlay' });
  assert.equal(over.ok, true, 'by the id the menu sends, on a tab that is not the first');
  assert.deepEqual(L.state.layers.widgets.map((w) => w.surface), ['overlay', 'overlay']);
  await run.run({ type: 'layerMove', target: id, monitor: 'DISPLAY2' });
  assert.deepEqual(L.state.layers.widgets.map((w) => w.monitor), ['DISPLAY2', 'DISPLAY2']);
  await run.run({ type: 'layerMove', target: id, screen: 'main' });
  assert.deepEqual(L.state.layers.widgets.map((w) => w.monitor), ['', '']);
  assert.equal((await run.run({ type: 'layerMove', target: id, surface: 'anchor' })).error, 'nothing_to_change', 'an app is asked for by name, never through a move');
});

test('an exact rectangle from edit mode lands clamped on screen, and a group moves through its lead', async () => {
  const L = fakeLayers();
  const run = runner(L);
  await run.run({ type: 'layerPlace', widget: 'weather' });
  await run.run({ type: 'layerPlace', widget: 'media' });
  await run.run({ type: 'layerGroup', widget: 'media', with: 'weather' });
  const res = await run.run({ type: 'layerMove', target: 'media', rect: '0.9,0.1,0.25,0.3' });
  assert.equal(res.ok, true);
  const [weather, media] = L.state.layers.widgets;
  assert.deepEqual(weather.rect, { x: 0.75, y: 0.1, w: 0.25, h: 0.3 }, 'the lead carries the box, kept inside the screen');
  assert.deepEqual(media.rect, weather.rect, 'the tab follows its box');
});

test('a move names what is wrong and writes nothing', async () => {
  const L = fakeLayers();
  const run = runner(L);
  await run.run({ type: 'layerPlace', widget: 'weather' });
  await run.run({ type: 'layerPlace', widget: 'weather', surface: 'overlay' });
  const writes = L.state.writes;
  assert.equal((await run.run({ type: 'layerMove', target: 'weather', rect: '1,2,x' })).error, 'bad_rect');
  assert.equal((await run.run({ type: 'layerMove', target: 'weather' })).error, 'nothing_to_change');
  assert.equal((await run.run({ type: 'layerMove', target: 'weather', position: 'top' })).error, 'ambiguous');
  assert.equal((await run.run({ type: 'layerMove', target: 'media', position: 'top' })).error, 'not_placed');
  assert.equal(L.state.writes, writes);
});

test('with no widgets, moving or showing them says so instead of doing nothing', async () => {
  const L = fakeLayers();
  let on = false;
  const run = createCapabilities({ layers: L, layersHost: shell(), layersEdit: { get: () => on, set: (v) => (on = v) } });
  assert.deepEqual(await run.run({ type: 'layersEdit', mode: 'toggle' }), { ok: false, error: 'no_widgets' });
  assert.equal(on, false, 'edit mode with nothing on screen could never be ended');
  assert.deepEqual(await run.run({ type: 'layersToggle', mode: 'toggle' }), { ok: false, error: 'no_widgets' });
  assert.deepEqual(await run.run({ type: 'layersEdit', mode: 'off' }), { ok: true, editing: false }, 'ending is always allowed');
});

test('edit mode switches through the runtime state and writes no setting', async () => {
  const L = fakeLayers(LayersModel.normalize(placedOne()));
  let on = false;
  const edit = { get: () => on, set: (v) => (on = v) };
  const run = createCapabilities({ layers: L, layersHost: shell(), layersEdit: edit });
  assert.deepEqual(await run.run({ type: 'layersEdit', mode: 'toggle' }), { ok: true, editing: true });
  assert.deepEqual(await run.run({ type: 'layersEdit', mode: 'on' }), { ok: true, editing: true });
  assert.deepEqual(await run.run({ type: 'layersEdit', mode: 'off' }), { ok: true, editing: false });
  assert.equal(L.state.writes, 0);
  assert.equal((await runner(L).run({ type: 'layersEdit', mode: 'on' })).error, 'unavailable', 'no state, no pretending');
});

test('Put it back restores the widgets edit mode started from, and only during edit mode', async () => {
  const start = LayersModel.normalize(placedOne());
  const L = fakeLayers(start);
  let on = false;
  let before = null;
  let touched = 0;
  const edit = { get: () => on, set: (v) => (on = v), remember: (v) => (before = v), earlier: () => before, forget() {}, touch: () => touched++ };
  const run = createCapabilities({ layers: L, layersHost: shell(), layersEdit: edit });
  assert.equal((await run.run({ type: 'layersUndo' })).error, 'nothing_to_undo', 'not while edit mode is off');
  await run.run({ type: 'layersEdit', mode: 'on' });
  await L.update((cur) => ({ layers: { ...cur, hidden: ['overlay'] } }));
  assert.deepEqual(await run.run({ type: 'layersUndo' }), { ok: true, editing: true });
  assert.deepEqual(L.get().hidden, start.hidden);
  assert.equal(touched, 1, 'undoing counts as an edit for the idle timer');
});

test('Undo takes one change back at a time, however many writes it took, made anywhere', async () => {
  const W = (id, x) => ({ id, kind: 'tile', widget: 'weather', surface: 'overlay', rect: { x, y: 0, w: 0.2, h: 0.2 } });
  const L = fakeLayers(LayersModel.normalize({ widgets: [W('lw_st000001', 0.1)] }));
  const edit = createLayersEdit();
  const run = createCapabilities({ layers: L, layersHost: shell(), layersEdit: edit });
  const x = () => L.get().widgets[0].rect.x;
  await run.run({ type: 'layerMove', target: 'lw_st000001', rect: '0.3,0,0.2,0.2' });
  await run.run({ type: 'layerMove', target: 'lw_st000001', rect: '0.5,0,0.2,0.2' });
  assert.equal(x(), 0.5);
  assert.equal((await run.run({ type: 'layersUndo', mode: 'step' })).ok, true, 'edit mode is not needed');
  assert.equal(x(), 0.3);
  await run.run({ type: 'layersUndo', mode: 'step' });
  assert.equal(x(), 0.1);
  assert.equal((await run.run({ type: 'layersUndo', mode: 'step' })).error, 'nothing_to_undo');
  edit.stop();
});

test('"Put it back" empties the steps: they led to a state that is gone', async () => {
  const L = fakeLayers(LayersModel.normalize({ widgets: [{ id: 'lw_st000002', kind: 'tile', widget: 'weather', surface: 'overlay', rect: { x: 0.1, y: 0, w: 0.2, h: 0.2 } }] }));
  const edit = createLayersEdit();
  const run = createCapabilities({ layers: L, layersHost: shell(), layersEdit: edit });
  await run.run({ type: 'layersEdit', mode: 'on' });
  await run.run({ type: 'layerMove', target: 'lw_st000002', rect: '0.3,0,0.2,0.2' });
  await run.run({ type: 'layersUndo' });
  assert.equal(L.get().widgets[0].rect.x, 0.1);
  assert.equal((await run.run({ type: 'layersUndo', mode: 'step' })).error, 'nothing_to_undo');
  edit.set(false);
});

test('edit mode shows the hidden surfaces and keeps them for the end; already on keeps nothing new', async () => {
  const L = fakeLayers(LayersModel.normalize({ ...placedOne(), hidden: ['overlay'] }));
  let on = false;
  const kept = [];
  const edit = { get: () => on, set: (v) => (on = v), keep: (v) => kept.push(v) };
  const run = createCapabilities({ layers: L, layersHost: shell(), layersEdit: edit });
  await run.run({ type: 'layersEdit', mode: 'on' });
  assert.deepEqual(L.state.layers.hidden, [], 'every widget can be moved');
  assert.deepEqual(kept, [['overlay']]);
  await run.run({ type: 'layersEdit', mode: 'on' });
  assert.equal(kept.length, 1);
});

test('the AI never sees the exact-rectangle param: it is for edit mode only', () => {
  const fns = aiFunctions({ layers: true });
  const move = fns.find(f => f.name === 'move_layer_widget');
  assert.ok(move);
  assert.deepEqual(Object.keys(move.parameters.properties).sort(), ['bare', 'opacity', 'page', 'position', 'screen', 'show', 'size', 'surface', 'target', 'visible', 'when'], 'where it sits, see-through and when it shows by voice, never the exact box');
  const act = aiAction('move_layer_widget', { target: 'weather', position: 'top', rect: '0,0,1,1' });
  assert.equal(act.rect, undefined);
});

test('server.js wires edit mode: read-only GET, the SSE event, kept open by edits, stopped on shutdown', () => {
  assert.match(SERVER, /require\('\.\/layers-edit'\)\.createLayersEdit\(\{\s*broadcast: \(on\) => broadcastSSE\('layers-edit', \{ on \}\),/);
  // The hidden surfaces come back hidden only if the user chose nothing meanwhile.
  assert.match(SERVER, /onEnd: \(hidden\) => \{\s*updateLayersSetting\(\(cur\) => \{\s*const now = LayersModel\.normalize\(cur\);\s*if \(now\.hidden\.length\) return \{ error: 'unchanged' \};/);
  assert.match(SERVER, /'\/layers\/edit'[\s\S]{0,300}json\(\{ on: layersEdit\.get\(\), peek: layersPeek\.get\(\) \}\)/);
  assert.match(SERVER, /function updateLayersSetting[\s\S]{0,600}layersEdit\.touch\(saved\.layers\)/);
  assert.match(SERVER, /function _gracefulShutdown\(\) \{[\s\S]{0,1500}layersEdit\.stop\(\)/);
});

test('"Add" in edit mode places on the screen of the window it was pressed on; a bad key falls back to the main one', async () => {
  const L = fakeLayers();
  const run = runner(L);
  const res = await run.run({ type: 'layerPlace', widget: 'weather', position: 'center', monitor: 'DISPLAY2' });
  assert.equal(res.ok, true);
  assert.equal(L.state.layers.widgets[0].monitor, 'DISPLAY2');
  await run.run({ type: 'layerPlace', widget: 'media', monitor: 'bad\nkey' });
  assert.equal(L.state.layers.widgets[1].monitor, '');
  assert.equal(validateAction({ type: 'layerPlace', widget: 'weather' }).monitor, undefined, 'saved keys keep their shape');
  const ai = aiFunctions({ layers: true }).find(f => f.name === 'place_widget');
  assert.equal(ai.parameters.properties.monitor, undefined, 'the AI names screens as main or second');
});

// ── Xenon AI edge glow ───────────────────────────────────────────────────────

const shellUp = { available: () => true };

test('"light up all my screens when we talk": the glow screens change by voice', async () => {
  const writes = [];
  const caps = createCapabilities({ layersHost: shellUp, settings: { setAiEdgeGlow: async (m) => { writes.push(m); return m; } } });
  assert.equal(caps.probes().aiGlow, true);
  const action = aiAction('set_voice_edge_glow', { screens: 'all', junk: 1 });
  assert.deepEqual(action, { type: 'aiEdgeGlow', screens: 'all' });
  assert.deepEqual(await caps.run(validateAction(action)), { ok: true, screens: 'all' });
  assert.deepEqual(writes, ['all']);
});

test('the glow choice names what is wrong and writes nothing', async () => {
  const writes = [];
  const caps = createCapabilities({ layersHost: shellUp, settings: { setAiEdgeGlow: async (m) => { writes.push(m); return m; } } });
  const r = await caps.run({ type: 'aiEdgeGlow', screens: 'everywhere' });
  assert.equal(r.error, 'bad_screens');
  assert.deepEqual(r.choices, ['auto', 'main', 'second', 'all', 'off']);
  assert.deepEqual(writes, []);
});

test('without the native shell the glow is neither offered nor run', async () => {
  const caps = createCapabilities({ settings: { setAiEdgeGlow: async (m) => m } });
  assert.equal(caps.probes().aiGlow, false);
  assert.ok(!aiFunctions(caps.probes()).some((f) => f.name === 'set_voice_edge_glow'));
  assert.deepEqual(await caps.run({ type: 'aiEdgeGlow', screens: 'all' }), { ok: false, error: 'unavailable' });
  assert.ok(aiFunctions({ aiGlow: true }).some((f) => f.name === 'set_voice_edge_glow'));
});

test('server.js keeps the glow setting on both sides and writes it under the settings lock', () => {
  const rule = (v) => `aiEdgeGlow: ['auto', 'main', 'second', 'all', 'off'].includes(${v}.aiEdgeGlow) ? ${v}.aiEdgeGlow : 'auto'`;
  assert.ok(SERVER.includes(rule('source')));
  assert.match(SERVER, /async function updateAiEdgeGlowSetting\(mode\) \{\n {2}return withHubSettingsLock\(/);
  const client = readFileSync(new URL('../js/settings.js', import.meta.url));
  assert.ok(client.includes(rule('value')));
});

// ── Widget pages ─────────────────────────────────────────────────────────────
const placedOne = () => ({ enabled: true, widgets: [{ id: 'lw_pg000001', kind: 'tile', widget: 'weather', surface: 'desktop', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 } }] });

test('"make a Games page" by voice, then "show it when I play", then switch with a Deck key', async () => {
  const L = fakeLayers(placedOne());
  const caps = runner(L);
  const made = await caps.run(validateAction(aiAction('manage_widget_pages', { mode: 'create', name: 'Games' })));
  assert.equal(made.ok, true);
  assert.deepEqual(made.pages.map(p => [p.name, p.active]), [['Page 1', false], ['Games', true]]);
  assert.equal((await caps.run({ type: 'layerPageEdit', mode: 'gaming', page: 'games' })).pages[1].gaming, true);
  const list = await caps.run({ type: 'layerList' });
  assert.equal(list.placed[0].page, 'Page 1');
  assert.equal(list.pages.length, 2);
  // A Deck key with the page left empty goes round.
  assert.deepEqual(await caps.run(validateAction({ type: 'layerPage' })), { ok: true, page: 'Page 1' });
  assert.deepEqual(await caps.run({ type: 'layerPage', page: '2' }), { ok: true, page: 'Games' });
  assert.deepEqual(await caps.run({ type: 'layerPage', page: 'Kitchen' }), { ok: false, error: 'unknown_page', choices: ['Page 1', 'Games'] });
});

test('without pages, switching says so and writes nothing', async () => {
  const L = fakeLayers(placedOne());
  assert.equal((await runner(L).run({ type: 'layerPage', page: 'next' })).error, 'no_pages');
  assert.equal((await runner(L).run({ type: 'layerPageEdit', mode: 'rename', page: '1', name: 'x' })).error, 'no_pages');
  assert.equal(L.state.writes, 0);
});

test('placing on a named page, moving to another, deleting a page with its widgets', async () => {
  const L = fakeLayers(placedOne());
  const caps = runner(L);
  await caps.run({ type: 'layerPageEdit', mode: 'create', name: 'Games' });
  const placed = await caps.run({ type: 'layerPlace', widget: 'media', page: 'Page 1' });
  assert.equal(placed.placed.page, 'Page 1', 'a page named wins over the one shown');
  assert.equal((await caps.run({ type: 'layerPlace', widget: 'media', page: 'Nope' })).error, 'unknown_page');
  const moved = await caps.run({ type: 'layerMove', target: placed.placed.id, page: 'Games' });
  assert.equal(moved.ok, true);
  assert.equal(moved.widget.page, 'Games');
  const both = await caps.run({ type: 'layerMove', target: 'weather', page: 'Games', position: 'bottom-left' });
  assert.equal(both.widget.page, 'Games');
  assert.ok(L.state.layers.widgets.find(w => w.widget === 'weather').rect.y > 0.5);
  const del = await caps.run({ type: 'layerPageEdit', mode: 'delete', page: 'Games' });
  assert.deepEqual([del.deleted, del.widgetsRemoved, del.pages.length], ['Games', 2, 0]);
  assert.deepEqual(L.state.layers.widgets, []);
});

test('"show my Games page on desktop 2": only where the shell says which desktop is shown; untying always works', async () => {
  const L = fakeLayers(placedOne());
  const off = runner(L);
  await off.run({ type: 'layerPageEdit', mode: 'create', name: 'Games' });
  const writes = L.state.writes;
  assert.deepEqual(await off.run(validateAction(aiAction('manage_widget_pages', { mode: 'desktop', page: 'Games', desktop: '2' }))), { ok: false, error: 'no_desktops' });
  assert.equal(L.state.writes, writes, 'nothing written');
  const on = runner(L, shell({ desks: () => true, shownDesk: () => ({ current: 1, count: 3 }) }));
  const tied = await on.run(validateAction(aiAction('manage_widget_pages', { mode: 'desktop', page: 'Games', desktop: '2' })));
  assert.equal(tied.ok, true);
  assert.equal(tied.desktop, 2);
  assert.deepEqual(tied.desktopShown, { current: 1, count: 3 });
  assert.deepEqual(tied.pages.map(p => p.desktop), [0, 2]);
  assert.equal((await on.run({ type: 'layerPageEdit', mode: 'desktop', page: 'Games', desktop: 12 })).ok, false);
  const freed = await off.run({ type: 'layerPageEdit', mode: 'desktop', page: 'Games', desktop: 0 });
  assert.deepEqual([freed.ok, freed.pages[1].desktop], [true, 0]);
  assert.match(aiFunctions({ layers: true }).find(f => f.name === 'manage_widget_pages').description, /no_desktops/);
});

test('the AI gets both page tools with the Deck-only bits hidden; the switch is a Deck key, the edit is not', () => {
  const fns = aiFunctions({ layers: true });
  assert.deepEqual(Object.keys(fns.find(f => f.name === 'switch_widget_page').parameters.properties), ['page']);
  assert.deepEqual(Object.keys(fns.find(f => f.name === 'manage_widget_pages').parameters.properties).sort(), ['desktop', 'mode', 'name', 'page', 'when']);
  assert.match(fns.find(f => f.name === 'manage_widget_pages').description, /removes the page AND the widgets on it/);
  assert.ok(Object.keys(fns.find(f => f.name === 'place_widget').parameters.properties).includes('page'));
  assert.equal(CAPABILITIES.find(c => c.type === 'layerPage').hidden, undefined);
  assert.equal(CAPABILITIES.find(c => c.type === 'layerPageEdit').hidden, true);
  assert.equal(aiFunctions({ layers: false }).some(f => /widget_page/.test(f.name)), false);
});

test('a move can take a widget out of its panel and put it back, on its box', async () => {
  const L = fakeLayers();
  const run = runner(L);
  await run.run({ type: 'layerPlace', widget: 'weather' });
  await run.run({ type: 'layerPlace', widget: 'media' });
  await run.run({ type: 'layerGroup', widget: 'media', with: 'weather' });
  const rect = L.state.layers.widgets[0].rect;
  const res = await run.run({ type: 'layerMove', target: 'media', bare: 'on' });
  assert.equal(res.ok, true);
  assert.equal(res.widget.bare, true, 'Bit can say so');
  assert.deepEqual(L.state.layers.widgets.map((w) => w.bare), [true, true]);
  assert.deepEqual(L.state.layers.widgets[0].rect, rect, 'the place is kept');
  await run.run({ type: 'layerMove', target: 'weather', opacity: '60' });
  assert.equal(L.state.layers.widgets[0].bare, true, 'another change leaves it');
  await run.run({ type: 'layerMove', target: 'weather', bare: 'off' });
  assert.equal('bare' in L.state.layers.widgets[0], false);
  const writes = L.state.writes;
  assert.equal((await run.run({ type: 'layerMove', target: 'weather', bare: 'keep' })).error, 'nothing_to_change');
  assert.equal((await run.run({ type: 'layerMove', target: 'weather', bare: 'maybe' })).error, 'nothing_to_change');
  assert.equal(L.state.writes, writes);
});

test('a move can hide one widget and show it again, in its place', async () => {
  const L = fakeLayers();
  const run = runner(L);
  await run.run({ type: 'layerPlace', widget: 'weather' });
  await run.run({ type: 'layerPlace', widget: 'media' });
  const rect = L.state.layers.widgets[0].rect;
  const res = await run.run({ type: 'layerMove', target: 'weather', visible: 'off' });
  assert.equal(res.ok, true);
  assert.equal(res.widget.hidden, true, 'Bit can say so');
  assert.equal(L.state.layers.widgets[0].off, true);
  assert.equal('off' in L.state.layers.widgets[1], false, 'only that one');
  assert.deepEqual(L.state.layers.widgets[0].rect, rect, 'the place is kept');
  await run.run({ type: 'layerMove', target: 'weather', visible: 'on' });
  assert.equal('off' in L.state.layers.widgets[0], false);
  const writes = L.state.writes;
  assert.equal((await run.run({ type: 'layerMove', target: 'weather', visible: 'keep' })).error, 'nothing_to_change');
  assert.equal((await run.run({ type: 'layerMove', target: 'weather', visible: 'maybe' })).error, 'nothing_to_change');
  assert.equal(L.state.writes, writes);
});

test('a move can change only how see-through a widget is, kept on its box', async () => {
  const L = fakeLayers();
  const run = runner(L);
  await run.run({ type: 'layerPlace', widget: 'weather' });
  await run.run({ type: 'layerPlace', widget: 'media' });
  await run.run({ type: 'layerGroup', widget: 'media', with: 'weather' });
  const rect = L.state.layers.widgets[0].rect;
  const res = await run.run({ type: 'layerMove', target: 'media', opacity: '60' });
  assert.equal(res.ok, true);
  const [weather, media] = L.state.layers.widgets;
  assert.equal(weather.opacity, 0.6, 'the box lead carries it');
  assert.equal(media.opacity, 0.6, 'and the tab follows');
  assert.deepEqual(weather.rect, rect, 'the place is kept');
  await run.run({ type: 'layerMove', target: 'weather', opacity: '5' });
  assert.equal(L.state.layers.widgets[0].opacity, 0.2, 'never invisible');
  const writes = L.state.writes;
  assert.equal((await run.run({ type: 'layerMove', target: 'weather', opacity: 'half' })).error, 'bad_opacity');
  assert.equal(L.state.writes, writes);
  const list = await run.run({ type: 'layerList' });
  assert.ok(JSON.stringify(list).includes('"opacity":20'), 'the list says it in percent');
});

// Capture features are probed one by one (capture-host.js `has`), so a macOS
// engine hides what it cannot do instead of offering it and failing.
test('capture probes follow the engine feature list', () => {
  const { MAC_FEATURES } = require('../capture-host.js');
  const mac = { host: { available: () => true, has: (f) => MAC_FEATURES.includes(f), request: async () => ({ ok: true }) }, store: () => ({}) };
  const p = createCapabilities({ capture: mac }).probes();
  assert.equal(p.capture, true);
  for (const k of ['captureVideo', 'captureOcr', 'captureSpeech', 'captureTuning', 'captureLapse', 'captureInspect', 'captureMeasure', 'captureCover', 'captureExport', 'captureReplay', 'captureSteps']) assert.equal(p[k], true, k);
  // macOS draws its own recording indicator, so there is no Xenon pill to switch.
  for (const k of ['captureBadge', 'captureDraw']) assert.equal(p[k], false, k);
  // A host without `has` (older tests, older wiring) can do them all; no engine, none.
  const all = createCapabilities({ capture: { host: { available: () => true }, store: () => ({}) } }).probes();
  assert.equal(all.captureReplay, true);
  const none = createCapabilities({}).probes();
  assert.equal(none.captureVideo, false);
});

test('every capture capability requires a probe that exists', () => {
  const probes = createCapabilities({}).probes();
  const needs = CAPABILITIES.map(c => [c.type, c.capability.requires]).filter(([, r]) => /^capture/.test(r || ''));
  assert.ok(needs.length >= 15, 'the capture capabilities are all seen');
  for (const [type, r] of needs) assert.ok(r in probes, `${type}: ${r}`);
});

test('"show the music widget only while I listen", by voice or by a Deck key', async () => {
  const L = fakeLayers(placedOne());
  const caps = runner(L);
  const id = 'lw_pg000001';
  assert.equal((await caps.run({ type: 'layerMove', target: id, when: 'music, app:obs64' })).ok, true);
  assert.deepEqual(L.state.layers.widgets[0].when, { any: [{ c: 'music' }, { c: 'app', app: 'obs64' }] });
  assert.equal((await caps.run({ type: 'layerList' })).placed[0].when, 'music,app:obs64');
  assert.equal((await caps.run({ type: 'layerMove', target: id, when: 'hide:call' })).ok, true);
  assert.equal(L.state.layers.widgets[0].when.hide, true);
  assert.equal((await caps.run({ type: 'layerMove', target: id, when: 'gaming mode' })).error, 'bad_when', 'a typo never hides a widget');
  assert.equal(L.state.layers.widgets[0].when.hide, true);
  assert.equal((await caps.run({ type: 'layerMove', target: id, when: 'always' })).ok, true);
  assert.equal(L.state.layers.widgets[0].when, undefined);
  assert.equal(L.state.layers.widgets[0].show, 'always');
});

test('"bring the Music page forward when I listen", and a rule that is not a situation', async () => {
  const L = fakeLayers(placedOne());
  const caps = runner(L);
  await caps.run({ type: 'layerPageEdit', mode: 'create', name: 'Music' });
  const res = await caps.run({ type: 'layerPageEdit', mode: 'when', page: 'music', when: 'music' });
  assert.equal(res.ok, true);
  assert.equal(res.pages[1].when, 'music');
  assert.equal((await caps.run({ type: 'layerPageEdit', mode: 'when', page: 'music', when: 'nonsense' })).error, 'bad_when');
  assert.equal((await caps.run({ type: 'layerPageEdit', mode: 'when', page: 'music', when: 'always' })).pages[1].when, undefined);
});
