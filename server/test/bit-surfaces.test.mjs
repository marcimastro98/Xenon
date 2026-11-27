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
const { bitKit, FILES, ENGINE } = require('../bit/kit.js');
const bitSigns = require('../../packages/core/src/bit-signs.js');
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
// `signs: false`: a page without the sign table (a desktop layer, the pump's screen).
function reader({ signs = true } = {}) {
  const window = signs ? { Xenon: { bitSigns } } : {};
  vm.runInNewContext(readFileSync(new URL('../js/custom-widget/stream-readers.js', import.meta.url), 'utf8'), { window });
  return (d, played, signal) => JSON.parse(JSON.stringify(window.CustomWidgetStreamReaders.bit(d, played, signal)));
}
// The shape GET /api/bit answers with.
const reply = (view) => ({ ok: true, bit: view });

test('SDK: a bit stream and a bit category with the move alone', () => {
  assert.ok(SDK.SDK_STREAMS.includes('bit'));
  assert.deepEqual([...SDK.SDK_ACTION_CATEGORIES.bit], ['bitReact']);
  const granted = Object.values(SDK.SDK_ACTION_CATEGORIES).flat();
  for (const type of ['bitWear', 'bitRename', 'bitPlace', 'bitDesk', 'bitWarp', 'bitGet']) assert.ok(!granted.includes(type), `${type} is never a widget's`);
});

test('SDK: the bridge pulls /api/bit every second with the last move, and mirrors the category', () => {
  const src = readFileSync(new URL('../js/custom-widget/custom-widget.js', import.meta.url), 'utf8');
  assert.ok(src.includes("    bit: Object.freeze({ ttl: 1000, load: async () => Readers.bit(await api('/api/bit'), window.BitMoments?.lastPlayed(), window.BitSignals?.top()?.kind) }),"));
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
  const out = reader()(reply({ ok: true, ...view, seed: SEED }), { clip: 'wave', at: 5 });
  assert.deepEqual(Object.keys(out).sort(), ['everywhere', 'founder', 'genes', 'hatched', 'items', 'name', 'number', 'ok', 'played', 'signal', 'stage', 'worn']);
  assert.equal(out.number, 7);
  assert.deepEqual(out.played, { clip: 'wave', at: 5 });
  assert.deepEqual(out.genes, view.genes);
  assert.ok(!JSON.stringify(out).includes(SEED), 'never the seed');
});

test('SDK: the sign over its head reaches the widget as its kind alone', () => {
  const view = reply(hatchedView());
  for (const kind of bitSigns.KINDS) assert.equal(reader()(view, null, kind).signal, kind);
  for (const odd of [undefined, '', 'Done', '<b>', 'claude finished in xenon', 7, { kind: 'done' }]) assert.equal(reader()(view, null, odd).signal, null);
  assert.equal(reader({ signs: false })(view, null, 'done').signal, null, 'no table, no sign');
  assert.ok(!('signal' in reader()(reply({ ok: true, hatched: false }), null, 'done')), 'an egg has none');
});

test('SDK: an egg, a bad reply and odd fields', () => {
  const read = reader();
  assert.deepEqual(read(reply({ ok: true, hatched: false })), { ok: true, hatched: false, stage: 'egg' });
  assert.deepEqual(read({ ok: false, error: 'boom' }), { ok: false, error: 'failed' });
  assert.deepEqual(read(null), { ok: false, error: 'failed' });
  const view = hatchedView();
  assert.deepEqual(read(reply({ ...view, ok: true, genes: { ...view.genes, palette: '<b>' } })), { ok: true, hatched: false, stage: 'egg' });
  const odd = read(reply({ ...view, ok: true, name: 'n'.repeat(80), number: -3, stage: 'boss', worn: ['scarf', '../x', 7, ...Array(20).fill('cap')] }),
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
  assert.deepEqual(ENGINE, order.filter((f) => ENGINE.includes(f)), 'the dashboard\'s order');
  assert.deepEqual(FILES.slice(ENGINE.length), ['shared/src/bit-signs.js', 'js/bit-companion/kit-api.js']);
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
  const out = reader()(reply(hatchedView()), { clip: 'dance', at: 5 });
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

// The kit draws the sign the stream names in the stage's top-right corner, over the frame, from the shared table.
test('kit: the sign in its hand comes, changes and goes with data.signal, and signs: false leaves it out', async () => {
  const { ctx } = fakePage();
  const made = [];
  const node = (tag) => {
    const n = { tag, attrs: {}, kids: [], setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute() {}, append(...c) { this.kids.push(...c); },
      appendChild(c) { this.kids.push(c); return c; }, replaceChildren(...c) { this.kids = c; }, remove() {}, insertBefore() {}, querySelector: () => null,
      style: {}, classList: { add() {}, remove() {}, toggle() {} }, children: [] };
    made.push(n);
    return n;
  };
  ctx.document.createElementNS = (ns, tag) => node(tag);
  vm.createContext(ctx);
  new vm.Script(await bitKit()).runInContext(ctx);
  const out = reader()(reply(hatchedView()), null, 'ask');
  const b = ctx.XenonBit.mount(node('div'), { label: 'Bit' });
  // Drawn with the body by the player: what its stage shows now, as the fills of its paths.
  const svgOf = () => made.find((n) => n.tag === 'svg' && n.attrs.class === 'xbit');
  const fills = (n = svgOf()) => [...(n.attrs.fill ? [n.attrs.fill] : []), ...n.kids.flatMap((k) => fills(k))];
  const holds = (kind) => bitSigns.cells(kind).every((c) => fills().includes('#' + c.hex));
  const SIGN_INK = ['#3fd16b', '#ffd23f', '#f5b83d', '#ff5a4d', '#4a90e2'];
  const none = () => !fills().some((x) => SIGN_INK.includes(x));
  b.set(out);
  assert.ok(holds('ask'), 'the board in its hand');
  b.set({ ...out, signal: 'disk' });
  assert.ok(holds('disk') && !fills().includes('#ffd23f'), 'changed');
  b.set({ ...out, signal: 'not-a-sign' });
  assert.ok(none(), 'an unknown sign is none');
  b.set({ ...out, signal: 'done' });
  b.set({ ok: true, hatched: false, stage: 'egg' });
  assert.ok(none(), 'an egg carries none');
  b.destroy();
  made.length = 0;
  const quiet = ctx.XenonBit.mount(node('div'), { label: 'Bit', signs: false });
  quiet.set(out);
  assert.ok(none(), 'the widget draws it itself');
  quiet.destroy();
  // A Bit drawn without mount, from its own player (the Maker's Bit layer): the sign in its hand too.
  made.length = 0;
  const player = ctx.Xenon.bitPlayer.mount(node('div'), { label: 'Bit' });
  const inHand = ctx.XenonBit.signs(player);
  inHand('done');
  assert.ok(holds('done'));
  inHand(null);
  assert.ok(none());
  player.destroy();
});

// A month's supporters' item is made on the hub (server/bit/items.js): a widget gets the drawing of
// the ones the Bit wears, never their names, prices of others or what it does not wear, and the kit draws it.
test('SDK and kit: a hub item the Bit wears reaches the widget as a drawing and goes on', async (t) => {
  const [crown, cape] = JSON.parse(readDisk(new URL('./fixtures/bit-hub-items.json', import.meta.url), 'utf8'));
  const view = { ok: true, ...hatchedView(), worn: ['crown'], items: [{ ...crown, offered: true }, { ...cape, offered: true }] };
  const out = reader()(reply(view));
  assert.deepEqual(out.items, [{ id: 'crown', slot: 'head', source: 'supporter', month: '2026-12', layers: crown.layers }]);
  const { ctx, el } = fakePage();
  vm.createContext(ctx);
  new vm.Script(await bitKit()).runInContext(ctx);
  let lookNow = () => undefined;
  const real = ctx.Xenon.bitPlayer.mount;
  ctx.Xenon.bitPlayer.mount = (host, opts) => { lookNow = opts.look; return real(host, opts); };
  const b = ctx.XenonBit.mount(el(), { label: 'Bit' });
  t.after(() => b.destroy());
  const drawn = () => JSON.parse(JSON.stringify(lookNow().worn.map((it) => it.id)));
  b.set({ ...out, items: [] });
  assert.deepEqual(drawn(), [], 'an item the kit was never handed is not drawn');
  b.set(out);
  assert.deepEqual(drawn(), ['crown']);
  b.set({ ...out, worn: ['crown2'], items: [{ ...out.items[0], id: 'crown2', layers: [{ fill: '#ffd75e', cells: [[6, 0]] }] }] });
  assert.deepEqual(drawn(), [], 'the wardrobe checks it again: over the antenna, never drawn');
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
  assert.ok(file('main.js').includes("type: 'refresh', id: Date.now(), stream: 'bit'"), 'the stream is pulled: nothing comes unasked');
  assert.equal(sdk.validateWidgetPayload({ id: 'my-bit', files: r.files }).ok, true);
  const checked = await T.runOp('check_widget', { id: 'my-bit', files: r.files }, deps);
  assert.equal(checked.bitHint, undefined);
  const noKit = await T.runOp('check_widget', { id: 'my-bit', files: r.files.filter((f) => f.path !== 'bit-kit.js') }, deps);
  assert.match(noKit.bitHint, /bit-kit\.js/);
});
