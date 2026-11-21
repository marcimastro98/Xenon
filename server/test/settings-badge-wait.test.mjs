// Settings → Top bar → apps in the bar: a badge widget that is switched on but has
// no room in the bar (four badges at most) says so under its name, and the line
// follows the bar while the page is open. Without it, a fifth badge widget read as
// broken (21 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'js', 'settings', 'dynamic-island.js'), 'utf8');

function rig(packages, waiting) {
  const { document } = makeDom();
  const host = document.createElement('div');
  host.id = 'settings-island-sources';
  document.body.append(host);
  const listeners = {};
  const window = {
    addEventListener: (type, fn) => { listeners[type] = fn; listeners.added = (listeners.added || 0) + 1; },
    CustomWidget: { getPackages: async () => ({ packages }) },
    SdkBadges: { MAX_BADGES: 4, waiting: () => waiting.slice() },
  };
  const ctx = {
    window, document, hubSettings: { topbarClock: { hiddenSources: [] } },
    $: (id) => document.getElementById(id),
    t: (k) => (k === 'island_source_badge_wait' ? 'room for {n}' : k),
  };
  Object.assign(ctx, { CustomWidget: window.CustomWidget });
  vm.runInNewContext(SRC, ctx);
  const notes = () => host.querySelectorAll('.island-source-wait');
  return { ctx, host, listeners, notes };
}

const PKGS = [
  { id: 'gh', name: 'GitHub Stars', badge: true },
  { id: 'tgk', name: 'TGK Battery Level', badge: true },
  { id: 'isl', name: 'Island only', islandDynamic: true },
];

test('only badge widgets carry the line, shown for the one waiting for room', async () => {
  const waiting = ['tgk'];
  const { ctx, notes } = rig(PKGS, waiting);
  await ctx.renderDynamicIslandSources();
  const list = notes();
  assert.equal(list.length, 2, 'the island-only widget has no badge line');
  const byPkg = Object.fromEntries(list.map((n) => [n.dataset.pkg, n]));
  assert.equal(byPkg.tgk.hidden, false);
  assert.equal(byPkg.gh.hidden, true);
  assert.equal(byPkg.tgk.textContent, 'room for 4', 'the cap is the bar\'s own number');
});

test('the line follows the bar while the page is open', async () => {
  const waiting = ['tgk'];
  const { ctx, listeners, notes } = rig(PKGS, waiting);
  await ctx.renderDynamicIslandSources();
  await ctx.renderDynamicIslandSources();
  assert.equal(listeners.added, 1, 'opening the page again adds no second listener');
  waiting.length = 0;
  listeners['xenon:sdk-badges']();
  assert.ok(notes().every((n) => n.hidden), 'a place freed up: no line');
  waiting.push('gh');
  listeners['xenon:sdk-badges']();
  assert.equal(notes().find((n) => n.dataset.pkg === 'gh').hidden, false);
});
