// Tab groups under the Minimal clock island, in a real browser on the built demo:
// three groups side by side on a 2560x720 screen, as on the Xeneon Edge. A group
// the island only bites a corner of keeps its tabs at the tile top beside the
// cutout; a group the island covers starts under it. The Playback tile's wide
// layout starts its cover right under the tabs, and leaves the waveform its strip.
// Run: node tools/island-tabs-check/check.mjs [--out <dir>]
// Needs docs/demo: node tools/build-demo.mjs

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { startSite } from '../site-shots/serve.mjs';
import { withScene } from '../site-shots/shoot.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const OUT = outAt >= 0 ? path.resolve(args[outAt + 1]) : null;
const RING = 8; // island-notch.js GAP
// A wide island (clock, date, weather, track, badges) as tall as a big clock, so
// it bites the side tiles' corners and reaches below where their content starts.
const WIDE_PILL = '#topbar-mini { min-width: 910px !important; min-height: 60px !important; }';

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(`${name}${detail ? ': ' + detail : ''}`);
}

// Three groups across the screen; `mid` columns for the middle one (Chat, Playback).
function scene({ viz, mid = 8 } = {}) {
  const tile = (at) => ({ ...at, visible: true, page: 'dashboard' });
  const group = (id, members, active, at) => ({ id, members, active, page: 'dashboard', ...at });
  const side = (24 - mid) / 2;
  const L = { x: 0, y: 0, w: side, h: 8 }, M = { x: side, y: 0, w: mid, h: 8 }, R = { x: side + mid, y: 0, w: side, h: 8 };
  return {
    viewport: { width: 2560, height: 720, scale: 1 },
    settings: { topbarStyle: 'minimal', ...(viz ? { mediaVisualizer: viz } : {}) },
    layout: {
      gridCols: 24,
      widgets: { deck: tile(L), agenda: tile(L), discord: tile(L), chat: tile(M), media: tile(M), system: tile(R), weather: tile(R), perf: tile(R) },
      groups: {
        gl: group('gl', ['deck', 'agenda', 'discord'], 'deck', L),
        gm: group('gm', ['chat', 'media'], 'media', M),
        gr: group('gr', ['system', 'weather', 'perf'], 'system', R),
      },
      pages: [{ id: 'dashboard', name: '', nameKey: 'page_dashboard' }],
    },
    fixtures: ['weather'],
    wait: 1500,
  };
}

// Runs in the page: the island, each group's strip and content, the Playback tile.
function measure() {
  const box = (n) => {
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
  };
  const pill = box(document.querySelector('#topbar-mini'));
  const groups = [...document.querySelectorAll('.grid-stack-item')]
    .filter((item) => item.offsetParent && item.querySelector(':scope > .grid-stack-item-content > .tabgroup'))
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
    .map((item) => {
      const surface = item.querySelector(':scope > .grid-stack-item-content > .tabgroup');
      return {
        clear: item.classList.contains('island-clear'),
        beside: item.classList.contains('island-beside'),
        ms: getComputedStyle(item).getPropertyValue('--island-notch-ms').trim(),
        surface: box(surface),
        bar: box(surface.querySelector(':scope > .tabgroup-bar')),
        body: box(surface.querySelector(':scope > .tabgroup-body')),
        bodyPad: parseFloat(getComputedStyle(surface.querySelector(':scope > .tabgroup-body')).paddingTop) || 0,
      };
    });
  const mp = document.querySelector('.tabgroup-body > .media-panel');
  const media = mp && {
    body: box(mp.parentElement), pane: box(mp.querySelector('.media-pane-play')),
    art: box(mp.querySelector('.media-art')), vol: box(mp.querySelector('.media-volume')),
    viz: box(mp.querySelector(':scope > .media-viz')),
  };
  return { pill, groups, media, scrollX: document.documentElement.scrollWidth - innerWidth };
}

async function look(browser, base, name, { css = '', viz, mid, reduced = false } = {}) {
  return withScene(browser, base, scene({ viz, mid }), async (page, errors) => {
    if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
    if (css) await page.addStyleTag({ content: css });
    await page.waitForTimeout(900);
    if (OUT) await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    check(`${name}: no page errors`, !errors.length, errors.join(' | '));
    return page.evaluate(measure);
  });
}

// The cutout's edges in page px: one ring around the island.
const cut = (pill) => ({ left: pill.left - RING, right: pill.right + RING, bottom: pill.bottom + RING });

function checkWide(m, name) {
  const c = cut(m.pill);
  const [left, mid, right] = m.groups;
  check(`${name}: three groups`, m.groups.length === 3, String(m.groups.length));
  if (m.groups.length !== 3) return;
  check(`${name}: the island bites both side tiles`, c.left < left.surface.right && c.right > right.surface.left,
    `cut ${c.left}-${c.right}`);
  for (const [label, g] of [['left', left], ['right', right]]) {
    check(`${name}: ${label} tabs stay beside the cutout`, g.clear && g.beside);
    check(`${name}: ${label} tabs at the tile top`, g.bar.top - g.surface.top < 12, `${g.bar.top - g.surface.top}px down`);
    check(`${name}: ${label} content starts below the cutout`, g.body.top + g.bodyPad >= c.bottom - 0.5,
      `content ${g.body.top + g.bodyPad}, cut ${c.bottom}`);
  }
  check(`${name}: left tabs end a ring before the cutout`, left.bar.right <= c.left - RING + 0.5, `${left.bar.right} vs ${c.left}`);
  check(`${name}: right tabs start a ring after the cutout`, right.bar.left >= c.right + RING - 0.5, `${right.bar.left} vs ${c.right}`);
  check(`${name}: right tabs stay inside the tile`, right.bar.right <= right.surface.right, `${right.bar.right} vs ${right.surface.right}`);
  check(`${name}: the covered tile starts under the island`, mid.clear && !mid.beside && mid.bar.top >= c.bottom - 0.5,
    `bar ${mid.bar.top}, cut ${c.bottom}`);
}

function checkMedia(m, name, { viz } = {}) {
  const md = m.media;
  check(`${name}: a Playback tile`, !!(md && md.art && md.pane));
  if (!md || !md.art || !md.pane) return;
  check(`${name}: the cover starts right under the tabs`, Math.abs(md.art.top - md.pane.top) < 1, `${md.art.top - md.pane.top}px gap`);
  check(`${name}: the volume is level with the cover's bottom`, Math.abs(md.vol.bottom - md.art.bottom) < 1.5,
    `${md.vol.bottom} vs ${md.art.bottom}`);
  check(`${name}: the cover fits the tile`, md.art.bottom <= md.pane.bottom + 0.5, `${md.art.bottom} vs ${md.pane.bottom}`);
  if (viz) {
    check(`${name}: a waveform strip`, !!md.viz);
    if (md.viz) check(`${name}: the cover leaves the waveform its strip`, md.art.bottom <= md.viz.top, `${md.art.bottom} vs ${md.viz.top}`);
  }
}

if (OUT) await mkdir(OUT, { recursive: true });
const site = await startSite(0);
const browser = await loadPlaywright().chromium.launch();
try {
  const base = `http://127.0.0.1:${site.port}/`;
  const plain = await look(browser, base, 'island-plain');
  check('plain: no sideways scroll', plain.scrollX <= 0);
  check('plain: side tiles untouched', plain.groups.length === 3 && !plain.groups[0].clear && !plain.groups[2].clear);
  checkMedia(plain, 'plain');

  const wide = await look(browser, base, 'island-wide', { css: WIDE_PILL });
  checkWide(wide, 'wide');
  checkMedia(wide, 'wide');

  // A wider Playback tile, where the tile's height and not its width sizes the cover.
  const waveform = await look(browser, base, 'island-wide-waveform', { css: WIDE_PILL, viz: 'wave', mid: 10 });
  checkMedia(waveform, 'waveform', { viz: true });

  const reduced = await look(browser, base, 'island-wide-reduced', { css: WIDE_PILL, reduced: true });
  checkWide(reduced, 'reduced');
  check('reduced: the cutout does not animate', reduced.groups.every((g) => !g.clear || g.ms === '0ms'),
    reduced.groups.map((g) => g.ms).join(','));
} finally {
  await browser.close();
  await site.stop();
}

if (failures.length) {
  for (const f of failures) console.log('FAIL ' + f);
  process.exitCode = 1;
} else {
  console.log('island tabs clean');
}
