// "Move with the mouse" from the menu: the menu steps aside while the widgets are moved
// and comes back, where it was, when the person presses Done.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const { createScreenMenu } = require('../screen-menu.js');
const { createLayersEdit } = require('../layers-edit.js');

function rig() {
  const said = [];
  let editing = false;
  const menu = createScreenMenu({
    host: { menus: () => true },
    broadcast: (s) => said.push(s),
    run: async (a) => { editing = a.type === 'edit'; return { ok: a.type !== 'broken' }; },
    holding: () => editing,
    delayMs: 0,
  });
  return { menu, said, end: () => { editing = false; } };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

test('the menu stays aside for as long as the widgets are being moved', async () => {
  const { menu, said, end } = rig();
  menu.show({ section: 'widgets' });
  assert.equal(menu.stepAside({ type: 'edit' }), 'aside');
  await settle();
  assert.equal(said.at(-1).aside, true, 'the action ended, the mode did not');
  end();
  menu.holdEnded(true);
  assert.deepEqual(said.at(-1), { open: true, section: 'widgets' });
});

test('a one-shot function still comes back at once', async () => {
  const { menu, said } = rig();
  menu.show({ section: 'capture' });
  menu.stepAside({ type: 'shot' });
  await settle();
  assert.equal(said.at(-1).aside, undefined);
  assert.equal(said.at(-1).open, true);
});

test('left alone until the mode timed out, the menu does not come up by itself', async () => {
  const { menu, said, end } = rig();
  menu.show({ section: 'widgets' });
  menu.stepAside({ type: 'edit' });
  await settle();
  end();
  menu.holdEnded(false);
  assert.equal(said.at(-1).open, false);
});

test('moving widgets started anywhere else does not open a closed menu', () => {
  const { menu, said } = rig();
  menu.holdEnded(true);
  assert.equal(said.length, 0);
  menu.show({ section: 'now' });
  menu.holdEnded(true);
  assert.equal(said.length, 1, 'an open menu is left as it is');
});

test('edit mode says whether it ended by hand or by itself', () => {
  const ends = [];
  let fire = null;
  const edit = createLayersEdit({ onOff: (byHand) => ends.push(byHand), setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} });
  edit.set(true);
  edit.set(false);
  edit.set(false);
  edit.set(true);
  fire();
  assert.deepEqual(ends, [true, false]);
});

test('both ways into the mode from the menu come back, and the page keeps the screen it was on', () => {
  const widgets = engineSource('server/menu-widgets.js');
  assert.match(widgets, /id: 'edit'[^\n]*closes: true, returns: true/);
  const functions = readFileSync(join(HERE, '..', 'menu-functions.js'), 'utf8');
  assert.match(functions, /\{ id: 'edit'[^\n]*returns: true/);
  const page = readFileSync(join(HERE, '..', 'js', 'screen-menu-page.js'), 'utf8');
  assert.match(page, /d\.section && !stepped\) view\.show\(d\.section\)/);
  const server = engineSource();
  assert.match(server, /onOff: \(byHand\) => screenMenu\.holdEnded\(byHand\)/);
  assert.match(server, /holding: \(\) => layersEdit\.get\(\)/);
});

test('a menu out of sight holds up no widget: the shell knows, the page does not', () => {
  const { menu } = rig();
  menu.show({ section: 'widgets' });
  assert.equal(menu.isBehind(), false);
  menu.setBehind(true);
  assert.equal(menu.isBehind(), true);
  menu.setBehind(false);
  assert.equal(menu.isBehind(), false);
  const server = engineSource();
  assert.match(server, /layersPeek\.set\(screenMenu\.isBehind\(\) \? null : body\.peek\)/, 'its repeats are refused while it is away');
  assert.match(server, /if \(screenMenu\.isBehind\(\)\) layersPeek\.set\(null\)/, 'and the widget lets go at once');
});
