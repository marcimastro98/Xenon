import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Discord: "no wave line at all", with Xenon Helper running and the Media tile
// showing the track from Firefox and from foobar2000 alike. The wave was only
// ever drawn on the original Media tile (#media-panel). A duplicated Media tile,
// or one in view while the original was hidden or on another page, never got it.

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function fakeTile(id, rect, hidden = false) {
  const tile = {
    id, children: [], parentNode: null, dataset: { dashboardHidden: hidden ? 'true' : 'false' },
    classList: { contains: () => false },
    getBoundingClientRect: () => tile.rect,
    rect,
    appendChild(kid) {
      if (kid.parentNode) kid.parentNode.children = kid.parentNode.children.filter((c) => c !== kid);
      kid.parentNode = tile;
      tile.children.push(kid);
      return kid;
    },
  };
  return tile;
}

function fakeCanvas() {
  const noop = () => {};
  const classes = new Set();
  return {
    parentNode: null, style: {}, width: 0, height: 0,
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    setAttribute: noop,
    getContext: () => ({ setTransform: noop, clearRect: noop, save: noop, restore: noop, beginPath: noop, roundRect: noop, fill: noop, createLinearGradient: () => ({ addColorStop: noop }) }),
  };
}

function load(tiles) {
  const ctx = {
    console,
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => '#1ed760' }),
    innerWidth: 1920, innerHeight: 720, devicePixelRatio: 1,
    listeners: {},
    addEventListener(type, fn) { (ctx.listeners[type] ||= []).push(fn); },
    document: {
      hidden: false,
      body: { classList: { contains: () => false } },
      documentElement: {},
      addEventListener() {},
      getElementById: (id) => tiles.find((tile) => tile.id === id) || null,
      querySelectorAll: () => tiles.slice(),
      createElement: fakeCanvas,
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('../js/media-viz.js'), ctx);
  ctx.MediaViz.fire = (type) => (ctx.listeners[type] || []).forEach((fn) => fn());
  return ctx.MediaViz;
}

const ON = { left: 0, right: 600, top: 0, bottom: 400, width: 600, height: 400 };
const OFF_PAGE = { left: 1920, right: 2520, top: 0, bottom: 400, width: 600, height: 400 };
const PARKED = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };

function play(viz) {
  viz.setStyle('wave');
  viz.setPlaying(true);
  viz.onLevels({ peaks: { foobar2000: 0.6 } });
}

test('the wave is drawn on the Media tile in view, not on a hidden original', () => {
  const original = fakeTile('media-panel', PARKED, true);
  const copy = fakeTile('', ON);
  const viz = load([original, copy]);
  play(viz);
  assert.equal(copy.children.length, 1, 'the copy in view carries the wave');
  assert.equal(original.children.length, 0);
  assert.equal(viz._state().running, true);
});

test('the original keeps it while it is in view, and the wave moves with the page', () => {
  const original = fakeTile('media-panel', ON);
  const copy = fakeTile('', OFF_PAGE);
  const viz = load([original, copy]);
  play(viz);
  assert.equal(original.children.length, 1);
  // The user swipes to the page with the copy.
  original.rect = { ...ON, left: -1920, right: -1320 };
  copy.rect = ON;
  viz.fire('xenon:page-change');
  assert.equal(copy.children.length, 1, 'one canvas, now on the tile in view');
  assert.equal(original.children.length, 0);
});

test('a Media tile that appears after the setting was applied still gets the wave', () => {
  const tiles = [];
  const viz = load(tiles);
  play(viz);
  assert.equal(viz._state().running, false);
  tiles.push(fakeTile('media-panel', ON));
  viz.onLevels({ peaks: { foobar2000: 0.5 } });
  assert.equal(tiles[0].children.length, 1);
  assert.equal(viz._state().running, true);
});

test('a copy of the Media tile does not inherit a dead canvas', () => {
  const src = read('../js/dashboard-layout.js');
  const fn = src.slice(src.indexOf('function stripMediaClone(clone) {'), src.indexOf('\n}\n', src.indexOf('function stripMediaClone(clone) {')));
  assert.match(fn, /clone\.querySelectorAll\('\.media-viz'\)\.forEach\(el => el\.remove\(\)\);/);
});
