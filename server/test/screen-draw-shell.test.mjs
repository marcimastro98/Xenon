// Drawing on the screen where the capture engine has no sheet (macOS, Linux):
// the server's open/closed state (screen-draw-shell.js), the shell's report
// (layers-host.js `draw`), the capability's shell path, the page's wiring and
// its strings. Pinned here: it opens only while a shell can show it, the
// Deck/Bit/SDK see one feature whoever draws it, and the page posts the same
// stop the Deck does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { createScreenDrawShell } = require('../screen-draw-shell.js');
const { createLayersHost } = require('../layers-host.js');
const draw = require('../capabilities/screen-draw.js');
const { PALETTE } = require('../js/screen-draw-model.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function shellWith(can) {
  const pushes = [];
  const host = { draws: () => can.value };
  return { shell: createScreenDrawShell({ host, broadcast: (d) => pushes.push(d) }), pushes };
}

test('it opens only while a shell can show it, and says so once per change', () => {
  const can = { value: true };
  const { shell, pushes } = shellWith(can);
  assert.equal(shell.set(true), true);
  assert.equal(shell.set(true), true);
  assert.deepEqual(pushes, [{ drawing: true }]);
  // The shell quit: the sheet went with it.
  can.value = false;
  assert.equal(shell.get(), false);
  assert.equal(shell.set(true), false);
  assert.deepEqual(pushes.at(-1), { drawing: false });
  assert.equal(shell.set('yes'), false, 'only true opens it');
  assert.equal(createScreenDrawShell({}).set(true), false, 'no host, nothing to open');
});

test('the shell report: `draw` counts only with layers, and expires with the report', () => {
  let t = 0;
  const host = createLayersHost({ now: () => t });
  host.accept({ layers: true, draw: true, monitors: [] });
  assert.equal(host.draws(), true);
  host.accept({ layers: false, draw: true });
  assert.equal(host.draws(), false);
  host.accept({ layers: true, draw: 'yes' });
  assert.equal(host.draws(), false);
  host.accept({ layers: true, draw: true });
  t = 11 * 60 * 1000;
  assert.equal(host.draws(), false);
});

test('without the engine the capability opens the shell sheet, with the same modes and answer', async () => {
  const { shell } = shellWith({ value: true });
  const noEngine = { available: () => true, has: (f) => f !== 'draw', request: async () => assert.fail('no engine call') };
  const d = { capture: { host: noEngine }, drawShell: shell };
  assert.equal(draw.canDraw(d), true);
  assert.deepEqual(await draw.run(d, { mode: 'toggle' }), { ok: true, drawing: true });
  assert.deepEqual(await draw.run(d, { mode: 'start' }), { ok: true, drawing: true });
  assert.deepEqual(await draw.run(d, {}), { ok: true, drawing: false });
  assert.deepEqual(await draw.run(d, { mode: 'stop' }), { ok: true, drawing: false });
  // No shell that can draw, no engine: unavailable, and not offered.
  const none = { capture: d.capture, drawShell: shellWith({ value: false }).shell };
  assert.equal(draw.canDraw(none), false);
  assert.deepEqual(await draw.run(none, {}), { ok: false, error: 'unavailable' });
  // The engine wins where it draws (Windows).
  const engine = { available: () => true, has: () => true, request: async () => ({ ok: true, drawing: true }) };
  assert.deepEqual(await draw.run({ capture: { host: engine }, drawShell: shell }, { mode: 'start' }), { ok: true, drawing: true });
  assert.equal(shell.get(), false, 'the shell sheet stayed closed');
});

test('the page loads its model and stops through the same action the Deck runs', () => {
  const html = read('../draw.html');
  for (const src of ['js/state.js', 'layer-i18n.js', 'js/screen-draw-model.js', 'js/screen-draw-page.js']) {
    assert.ok(html.includes(`src="${src}"`), src);
  }
  assert.ok(html.indexOf('src="js/screen-draw-model.js"') < html.indexOf('src="js/screen-draw-page.js"'));
  assert.doesNotMatch(html, /style="/, 'no inline styles');
  const page = read('../js/screen-draw-page.js');
  assert.match(page, /type: 'screenDraw', mode: 'stop'/);
  assert.doesNotMatch(page, /innerHTML/);
  const server = read('../server.js');
  assert.match(server, /reqPath === '\/draw' && req\.method === 'GET'/);
  assert.match(server, /reqPath === '\/screen-draw' && req\.method === 'GET'/);
});

test('every label on the bar exists in 11 languages', () => {
  const i18n = read('../js/i18n.js');
  const html = read('../draw.html');
  const keys = new Set([...html.matchAll(/data-i18n(?:-title|-aria-label)?="([a-z_]+)"/g)].map((m) => m[1]));
  for (const p of PALETTE) keys.add(p.label);
  assert.ok(keys.size >= 12);
  for (const k of keys) {
    assert.equal((i18n.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 11, k);
  }
});
