// Where the person's own Bit meets widgets: the SDK stream and action category, what a widget
// sees of /api/bit, the Bit kit a widget carries (the app's own engine, the site's copy the same
// text) and the MCP starter that writes it. Every seed and name here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync as readDisk } from 'node:fs';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const SDK = require('../widget-sdk/surface.js');
const sdk = require('../sdk-widgets.js');
const Model = require('../bit/model.js');
const { bitKit, FILES } = require('../bit/kit.js');
const T = require('../mcp/mcp-dev-tools.js');
const { MOVES } = require('../js/capabilities/catalog-bit.js');

const NOW = new Date(2026, 11, 3, 12);
const SEED = '0123456789abcdef';

function hatchedView() {
  const egg = Model.normalize({ eggAt: '2026-01-01T00:00:00.000Z' });
  const born = Model.hatched(egg, { seed: SEED, number: 7, born: NOW.toISOString(), sig: 'made-up' }, NOW).model;
  return Model.view(born, NOW);
}

// What a widget sees of a pulled reply (js/custom-widget/stream-readers.js), run on its own.
function reader() {
  const window = {};
  vm.runInNewContext(readFileSync(new URL('../js/custom-widget/stream-readers.js', import.meta.url), 'utf8'), { window });
  return (d, played) => JSON.parse(JSON.stringify(window.CustomWidgetStreamReaders.bit(d, played)));
}

test('SDK: a bit stream and a bit category with the move alone', () => {
  assert.ok(SDK.SDK_STREAMS.includes('bit'));
  assert.deepEqual([...SDK.SDK_ACTION_CATEGORIES.bit], ['bitReact']);
  const granted = Object.values(SDK.SDK_ACTION_CATEGORIES).flat();
  for (const type of ['bitWear', 'bitRename', 'bitPlace', 'bitGet']) assert.ok(!granted.includes(type), `${type} is never a widget's`);
});

test('SDK: the bridge pulls /api/bit every second with the last move, and mirrors the category', () => {
  const src = readFileSync(new URL('../js/custom-widget/custom-widget.js', import.meta.url), 'utf8');
  assert.ok(src.includes("    bit: Object.freeze({ ttl: 1000, load: async () => Readers.bit(await api('/api/bit'), window.BitMoments?.lastPlayed()) }),"));
  assert.ok(src.includes("    bit: ['bitReact'],"));
  const allowed = readFileSync(new URL('../js/settings/allowed-values.js', import.meta.url), 'utf8');
  for (const list of ['SDK_WIDGET_STREAMS', 'SDK_WIDGET_ACTION_CATS']) {
    assert.ok(allowed.match(new RegExp(`const ${list} = .*`))[0].includes("'bit'"), `${list} grants bit`);
  }
});

// Found while wiring Pump Bit: the pump, layer, scene and service pages ran the bridge without
// the readers, so every pulled stream that needs one (bit, airflow, netPath) failed there.
test('SDK: every page that hosts widgets loads the stream readers before the bridge', () => {
  for (const page of ['index', 'layer-lite', 'pump-widget', 'scene', 'sdk-service']) {
    const html = readDisk(new URL(`../${page}.html`, import.meta.url), 'utf8');
    const readers = html.indexOf('src="js/custom-widget/stream-readers.js"');
    assert.ok(readers > 0 && readers < html.indexOf('src="js/custom-widget/custom-widget.js"'), page);
  }
});

test('SDK: the stream draws the Bit and nothing it learned about the person', () => {
  const view = hatchedView();
  assert.ok(view.traits && view.owned && view.genes, 'the app\'s own view has more than a widget gets');
  const out = reader()({ ok: true, ...view, seed: SEED }, { clip: 'wave', at: 5 });
  assert.deepEqual(Object.keys(out).sort(), ['everywhere', 'founder', 'genes', 'hatched', 'name', 'number', 'ok', 'played', 'stage', 'worn']);
  assert.equal(out.number, 7);
  assert.deepEqual(out.played, { clip: 'wave', at: 5 });
  assert.deepEqual(out.genes, view.genes);
  assert.ok(!JSON.stringify(out).includes(SEED), 'never the seed');
});

test('SDK: an egg, a bad reply and odd fields', () => {
  const read = reader();
  assert.deepEqual(read({ ok: true, hatched: false }), { ok: true, hatched: false, stage: 'egg' });
  assert.deepEqual(read({ ok: false, error: 'boom' }), { ok: false, error: 'failed' });
  assert.deepEqual(read(null), { ok: false, error: 'failed' });
  const view = hatchedView();
  assert.deepEqual(read({ ...view, ok: true, genes: { ...view.genes, palette: '<b>' } }), { ok: true, hatched: false, stage: 'egg' });
  const odd = read({ ...view, ok: true, name: 'n'.repeat(80), number: -3, stage: 'boss', worn: ['scarf', '../x', 7, ...Array(20).fill('cap')] },
    { clip: 'Not A Clip', at: 1 });
  assert.equal(odd.name.length, 24);
  assert.equal(odd.number, null);
  assert.equal(odd.stage, 'baby');
  assert.deepEqual(odd.worn, ['scarf', ...Array(7).fill('cap')]);
  assert.equal(odd.played, null);
});

// A page just big enough for the player: elements that take what it sets.
function fakePage() {
  const el = () => ({
    setAttribute() {}, removeAttribute() {}, appendChild: (c) => c, append() {}, remove() {}, replaceChildren() {},
    insertBefore() {}, querySelector: () => null, style: {}, classList: { add() {}, remove() {}, toggle() {} }, children: [],
  });
  const ctx = {
    document: { createElementNS: el, createElement: el, addEventListener() {}, removeEventListener() {}, hidden: false },
    setTimeout, clearTimeout, performance, requestAnimationFrame: (f) => setTimeout(f, 16), cancelAnimationFrame: clearTimeout,
  };
  ctx.globalThis = ctx;
  return { ctx, el };
}

test('kit: the app\'s engine in load order, and the site\'s copy is the same text', async () => {
  const order = JSON.parse(readDisk(new URL('./fixtures/bit-engine.json', import.meta.url), 'utf8'));
  const engine = FILES.filter((f) => f.startsWith('shared/'));
  assert.deepEqual(engine, order.filter((f) => engine.includes(f)), 'the dashboard\'s order');
  assert.ok(FILES.at(-1).endsWith('kit-api.js'));
  const site = readDisk(new URL('../../docs/create/bit-kit.js', import.meta.url), 'utf8');
  assert.equal(site, await bitKit(), 'docs/create/bit-kit.js is stale: run node tools/bit-kit.mjs');
});

test('kit: draws the egg, then the Bit, the classic one on request, and plays only a move made after it opened', async () => {
  const { ctx, el } = fakePage();
  vm.createContext(ctx);
  new vm.Script(await bitKit()).runInContext(ctx);
  const played = [];
  let lookNow = () => undefined;
  const real = ctx.Xenon.bitPlayer.mount;
  ctx.Xenon.bitPlayer.mount = (host, opts) => {
    lookNow = opts.look;
    const p = real(host, opts);
    const play = p.play;
    p.play = (c) => { played.push(c); return play(c); };
    return p;
  };
  const b = ctx.XenonBit.mount(el(), { label: 'Bit' });
  b.set({ ok: true, hatched: false, stage: 'egg' });
  const out = reader()({ ok: true, ...hatchedView() }, { clip: 'dance', at: 5 });
  b.set(out);
  assert.deepEqual(played, [], 'a move from before is not replayed');
  assert.ok(lookNow(), 'their own look');
  b.set({ ...out, everywhere: false }, { classic: true });
  assert.equal(lookNow(), null, 'the classic Bit');
  b.set(out);
  assert.ok(lookNow());
  b.set({ ...out, played: { clip: 'wave', at: 9 } });
  b.set({ ...out, played: { clip: 'wave', at: 9 } });
  assert.deepEqual(played, ['wave']);
  assert.ok(MOVES.filter((m) => m !== 'surprise').every((m) => ctx.XenonBit.clips().includes(m)), 'every move is a clip');
  b.destroy();
});

test('MCP: the Bit starter carries the kit, installs, and check_widget asks for the kit when it is missing', async () => {
  const deps = { validateWidgetPayload: sdk.validateWidgetPayload, critiqueWidget: () => null, scanWidgetSource: () => [] };
  const r = await T.runOp('widget_template', { id: 'my-bit', bit: true }, deps);
  assert.equal(r.ok, true);
  const file = (p) => Buffer.from(r.files.find((f) => f.path === p).data, 'base64').toString('utf8');
  const manifest = JSON.parse(file('manifest.json'));
  assert.deepEqual([manifest.streams, manifest.actions], [['bit'], ['bit']]);
  assert.equal(file('bit-kit.js'), await bitKit());
  assert.ok(file('index.html').indexOf('bit-kit.js') < file('index.html').indexOf('main.js'), 'the kit loads first');
  assert.ok(file('main.js').includes('textContent') && !file('main.js').includes('innerHTML'));
  assert.equal(sdk.validateWidgetPayload({ id: 'my-bit', files: r.files }).ok, true);
  const checked = await T.runOp('check_widget', { id: 'my-bit', files: r.files }, deps);
  assert.equal(checked.bitHint, undefined);
  const noKit = await T.runOp('check_widget', { id: 'my-bit', files: r.files.filter((f) => f.path !== 'bit-kit.js') }, deps);
  assert.match(noKit.bitHint, /bit-kit\.js/);
});
