// tools/menu-shots: its invented desk still draws the Screens page the pictures are of, and
// its little server never hands out the user's data folder or climbs out of server/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MONITORS, PHONES, menuState } from '../../tools/menu-shots/fixture.mjs';
import { inside } from '../../tools/menu-shots/shoot.mjs';

const require = createRequire(import.meta.url);
const Menu = require('../xenon-menu.js');
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the invented desk draws two screens, the Edge with the dashboard, and two phones', () => {
  const home = Menu.compose(menuState()).sections.find((s) => s.id === 'screens').rows.find((r) => r.kind === 'home');
  assert.deepEqual(home.screens.map((v) => [v.key, v.dashboard]), [['M1', false], ['M2', true]]);
  assert.deepEqual(home.screens[0].widgets, ['lw_wthr01', 'lw_clck01']);
  assert.equal(MONITORS.filter((m) => m.primary).length, 1);
  assert.ok(PHONES.every((p) => /^dev_/.test(p.id) && p.name));
});

test('the shot server serves the page files only', () => {
  assert.equal(inside(SERVER_DIR, '/js/xenon-menu.js'), path.join(SERVER_DIR, 'js', 'xenon-menu.js'));
  assert.equal(inside(SERVER_DIR, '/../../package.json'), path.join(SERVER_DIR, 'package.json'), 'a climb stops at server/');
  for (const bad of ['/data/hub-settings.json', '/DATA/notes.json', '/../data/notes.json', '/%2e%2e/data/x', '/js/../data/x', '/.git/config', '/%E0%A4%A']) {
    assert.equal(inside(SERVER_DIR, bad), null, bad);
  }
});
