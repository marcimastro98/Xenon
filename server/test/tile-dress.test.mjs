// Bit's style_tile on the client: which tile a word means, and what is written to it.
// The style goes through the same two functions as the window, so a tile dressed by
// voice keeps everything else it was wearing.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const DI = require('../js/dashboard-instances.js');
globalThis.window = { DashboardInstances: DI, innerWidth: 1920 };
const TileMaterial = require('../js/tile-material.js');
const PageTarget = require('../js/page-target.js');
const { workingCopy, buildStyle } = require('../js/tile-style-editor.js');

const IT = { layout_widget_media: 'Riproduzione', layout_widget_system: 'Sistema', tile_style_title: 'Stile del widget', tile_dress_not_found: 'Non trovo "{name}".' };
const EN = { layout_widget_media: 'Playback', layout_widget_system: 'System', layout_widget_chat: 'Bit' };

const node = (id, left = 10) => ({
  getAttribute: () => id,
  getBoundingClientRect: () => ({ width: 300, left, right: left + 300 }),
});

let layout;
let nodes;
let written;
let toasts;
let closed;

beforeEach(() => {
  layout = { widgets: { chat: {}, system: { style: { mode: 'inherit', radius: 2 } } }, groups: { g1: { id: 'g1', members: ['media', 'agenda'] } } };
  nodes = [node('chat'), node('system'), node('g1')];
  written = [];
  toasts = [];
  closed = 0;
  Object.assign(globalThis, {
    i18n: { en: EN },
    t: (key) => IT[key] ?? EN[key] ?? key,
    document: { querySelectorAll: () => nodes },
    getDashboardLayout: () => layout,
    tileStyleForId: (l, id) => (l.widgets[id] && l.widgets[id].style) || null,
    setTileStyle: (id, style) => written.push({ id, style }),
  });
  Object.assign(globalThis.window, {
    TileMaterial,
    PageTarget,
    TileStyleWork: { workingCopy, buildStyle },
    XenonToast: { show: (o) => toasts.push(o) },
    closeTileStyleEditor: () => { closed += 1; return false; },
    CustomWidget: { assignedName: (id) => (id === 'custom~1' ? 'Keyring' : '') },
  });
});

const { findTile, dress } = require('../js/tile-dress.js');

test('a tile answers to its id, its name here and its name in English, without case or accents', () => {
  assert.equal(findTile('system'), 'system');
  assert.equal(findTile('Sistema'), 'system');
  assert.equal(findTile('SISTEMÀ'), 'system');
  assert.equal(findTile('bit'), 'chat');
});

test('a tile inside a tab group answers for the group, which is what wears the style', () => {
  assert.equal(findTile('media'), 'g1');
  assert.equal(findTile('Riproduzione'), 'g1');
  assert.equal(findTile('playback'), 'g1');
  assert.equal(findTile('agenda'), 'g1');
});

test('the empty item a member leaves behind never takes the style from its group', () => {
  nodes = [node('media'), ...nodes];
  assert.equal(findTile('media'), 'g1');
});

test('part of a name is enough, a word too short to mean anything is not', () => {
  assert.equal(findTile('riprod'), 'g1');
  assert.equal(findTile('si'), '');
});

test('an installed widget answers to its own name', () => {
  nodes.push(node('custom~1'));
  assert.equal(findTile('keyring'), 'custom~1');
});

test('the tile on the page in front of the user beats a copy on another page', () => {
  nodes = [node('system~2', 4000), node('system', 10)];
  assert.equal(findTile('sistema'), 'system');
});

test('a page word or a number is no tile', () => {
  assert.equal(findTile('next'), '');
  assert.equal(findTile('2'), '');
});

test('a material lands in the tile and leaves the rest of its style alone', () => {
  assert.equal(dress({ tile: 'system', material: 'clear' }), true);
  const [{ id, style }] = written;
  assert.equal(id, 'system');
  assert.equal(TileMaterial.materialOf(style), 'clear');
  assert.equal(style.radius, 2);
});

test('a tint is the colour of the panel, and none hands it back to the theme', () => {
  layout.widgets.system.style = { mode: 'custom', panel: '#112233', panelAlpha: 0.54 };
  dress({ tile: 'system', tint: '#6d28d9' });
  assert.equal(written[0].style.panel, '#6d28d9');
  assert.equal(written[0].style.mode, 'custom');
  assert.equal(written[0].style.panelAlpha, 0.54, 'the material stays');
  dress({ tile: 'system', tint: 'none' });
  assert.equal(written[1].style.panel, undefined);
  assert.equal(written[1].style.mode, 'inherit');
});

test('the theme material takes the three values off the tile', () => {
  layout.widgets.system.style = { mode: 'inherit', panelAlpha: 0.35, glassBlur: 10, glassSaturate: 180 };
  dress({ tile: 'system', material: 'theme' });
  const style = written[0].style || {};
  ['panelAlpha', 'glassBlur', 'glassSaturate'].forEach((key) => assert.equal(style[key], undefined, key));
});

test('an open style window closes first, or its own copy would write over this', () => {
  dress({ tile: 'system', material: 'solid' });
  assert.equal(closed, 1);
});

test('a tile nobody can find is said on screen and nothing is written', () => {
  assert.equal(dress({ tile: 'fridge', material: 'clear' }), false);
  assert.equal(written.length, 0);
  assert.equal(closed, 0, 'the open window is left alone');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].type, 'error');
  assert.equal(toasts[0].message, 'Non trovo "fridge".');
});

test('the server knows the tool and hands it to the client, which knows the action', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const server = read('../server.js');
  assert.match(server, /\{ name: 'style_tile',/);
  assert.match(server.match(/const CLIENT_ACTIONS = new Set\(\[([^\]]*)\]\)/)[1], /'style_tile'/);
  assert.match(server, /fnName === 'style_tile' \? TileMaterial\.requestMiss\(fnArgs\)/);
  assert.match(read('../js/ai.js'), /case 'style_tile':\s+if \(window\.TileDress\) window\.TileDress\.dress\(args\);/);
  const page = read('../index.html');
  assert.ok(page.indexOf('js/tile-style-editor.js') < page.indexOf('js/tile-dress.js'));
  // Each material the tool names is one the window has, and the other way round.
  const at = server.indexOf("{ name: 'style_tile',");
  const declared = server.slice(at, server.indexOf("required: ['tile']", at));
  TileMaterial.MATERIALS.forEach(({ id }) => assert.match(declared, new RegExp(`\\b${id} \\(`), id));
});
