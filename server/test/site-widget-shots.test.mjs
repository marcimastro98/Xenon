// tools/site-shots/widgets.mjs and desktop-scene.mjs: the home page's single widgets and
// its desktop picture. Each tile is shot alone at a grid size that fits, every extra data
// set is invented, and the desktop's tiles are light layer tiles apart from the window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { WIDGET_CELLS, moreDataFor, soloLayout } from '../../tools/site-shots/widgets.mjs';
import { SCENE_PLAN, backdropHtml } from '../../tools/site-shots/desktop-scene.mjs';
import * as aiFixtures from '../../tools/tile-previews/fixtures-ai.mjs';

const require = createRequire(import.meta.url);
const LayerTiles = require('../js/layer-tiles.js');

const NOW = Date.UTC(2026, 10, 5, 12);
const GRID_COLS = 24;
const GRID_ROWS = 8;
const WINDOW_RIGHT = 698 / 1600;

test('every widget fits the grid and is the only tile on the page', () => {
  for (const [id, [w, h]] of Object.entries(WIDGET_CELLS)) {
    assert.ok(w > 0 && w <= GRID_COLS && h > 0 && h <= GRID_ROWS, `${id} does not fit the grid`);
    const layout = soloLayout(id, null);
    const shown = Object.entries(layout.widgets).filter(([, tile]) => tile.visible).map(([name]) => name);
    assert.deepEqual(shown, [id]);
    assert.deepEqual(Object.keys(layout.groups), ['media', 'chat'].includes(id) ? ['media-group'] : [], 'a layout without groups falls back to the stacked page');
  }
});

test('a fixture keeps its own cards next to the layout defaults', () => {
  const layout = soloLayout('system', { cards: { extra: { a: { order: 1 } } } });
  assert.ok(layout.cards.net && layout.cards.extra);
});

test('the calendar has events both sides of today, in the demo events route', () => {
  const { answers } = moreDataFor('calendar', NOW);
  const dates = answers['/events'].events.map((e) => Date.parse(e.startsAt));
  assert.ok(dates.every(Number.isFinite), 'an event has no start');
  assert.ok(dates.some((d) => d < NOW) && dates.some((d) => d > NOW), 'one side of today is empty');
});

test('news fills the tile with invented sources and local pictures', () => {
  const origin = 'http://127.0.0.1:1';
  const { answers, files } = moreDataFor('news', NOW, origin);
  const { items } = answers['/api/news'];
  assert.ok(items.length >= 6, 'too few headlines leave the tile half empty');
  for (const item of items) {
    assert.match(item.source, /^Sample /);
    assert.ok(item.image.startsWith(origin));
    assert.ok(files[new URL(item.image).pathname], `no art for ${item.title}`);
  }
});

test('the Claude tile is shot as a session open in a terminal, with its tool lines', () => {
  const { answers, stage } = aiFixtures.claude(NOW);
  const [session] = answers['/api/claude'].live.sessions;
  assert.equal(session.modCommands, true, 'without it model and effort are static chips, not the real selects');
  assert.ok(session.permissionMode, 'the permission chip is part of a live session');
  assert.ok(answers['/api/claude/transcript'].messages.some((m) => m.tools?.length), 'a thread without tool lines is not what the tile shows');
  assert.match(stage, /cw-aside-hide/, 'at this width the side panel would cover the thread');
});

test('the Codex tile is shot on a request that names the files it touches', () => {
  const { answers } = aiFixtures.openaicodex(NOW);
  const [request] = answers['/api/codex'].live.approvals;
  assert.equal(request.detail.kind, 'patch');
  assert.ok(request.detail.files.length > 1);
});

test('a tile without extra data asks for none', () => {
  assert.equal(moreDataFor('spotify', NOW), null);
});

test('the desktop tiles are light tiles, on the screen, clear of the window and each other', () => {
  for (const [tile, r] of SCENE_PLAN) {
    assert.ok(LayerTiles.LITE.includes(tile), `${tile} is not a light layer tile`);
    assert.ok(r.x >= WINDOW_RIGHT && r.y >= 0 && r.x + r.w <= 1 && r.y + r.h <= 1, `${tile} out of bounds`);
  }
  const rects = SCENE_PLAN.map(([, r]) => r);
  rects.forEach((a, i) => rects.slice(i + 1).forEach((b) => {
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'tiles overlap');
  }));
});

test('the desktop around the tiles is invented: no system logo, nothing from a real site', () => {
  const html = backdropHtml();
  assert.match(html, /lanterntrail\.example/);
  assert.doesNotMatch(html, /windows|microsoft|apple|https?:\/\//i);
});
