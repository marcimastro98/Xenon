'use strict';

// Critique of the two placed layouts: a dashboard page (tiles on the 24-column
// grid) and a native Ambient scene (elements in percent of the screen). Each
// check reads the NORMALIZED layout, the one the import would build, and
// returns findings (ai-preset-critique-core.js); none means nothing objective
// to fix.

const DashboardPresets = require('./js/dashboard-presets.js');
const DashboardInstances = require('./js/dashboard-instances.js');
const DashboardGrid = require('./js/dashboard-grid.js');
const AmbientScene = require('./js/ambient-scene.js');
const themePalette = require('./js/theme-palette.js');
const { BODY_TEXT, LARGE_TEXT, finding, contrastFinding, overlapArea, contains, boxText } = require('./ai-preset-critique-core.js');

// ── page ───────────────────────────────────────────────────────────────────

const COLS = DashboardPresets.PRESET_GRID_COLUMNS;
// Below this share of the page covered by tiles, the page reads as half empty.
const MIN_COVERAGE = 0.6;
// An empty block at least this share of the page is worth naming.
const BIG_GAP = 0.25;
// largestFreeRect is brute force; past this many rows only coverage is measured.
const GAP_SCAN_ROWS = 48;

function normalizedItems(page, deps) {
  const ids = deps.dashboardWidgets.map((w) => w.id);
  const norm = DashboardPresets.normalizePresets([{ kind: 'page', gridCols: COLS, data: page }], ids)[0];
  return norm ? norm.data.items : [];
}

const itemName = (it, i) => 'items[' + i + '] (' + (it.type === 'group' ? 'group' : it.widget) + ')';

function pageOutside(items) {
  return items.flatMap((it, i) => (it.x + it.w > COLS
    ? [finding('fix', itemName(it, i), 'ends at column ' + (it.x + it.w) + ' of ' + COLS, 'keep x + w at most ' + COLS)]
    : []));
}

function pageOverlaps(items) {
  const out = [];
  items.forEach((a, i) => items.slice(i + 1).forEach((b, k) => {
    if (overlapArea(a, b)) {
      out.push(finding('fix', itemName(a, i) + ' and ' + itemName(b, i + 1 + k), 'the tiles overlap (' + boxText(a) + ' and ' + boxText(b) + ')',
        'move one so the boxes do not share any cell'));
    }
  }));
  return out;
}

// A widget the dashboard holds only once is dropped the second time; copies of
// a mirror widget show the same content twice.
function pageDuplicates(items) {
  const seen = new Map();
  for (const it of items) {
    const bases = it.type === 'group' ? it.members : [it.widget];
    for (const base of bases) {
      const key = base + (it.pkg ? ':' + it.pkg : '');
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  const out = [];
  for (const [key, count] of seen) {
    if (count < 2) continue;
    const base = key.split(':')[0];
    if (!DashboardInstances.isDuplicable(base)) {
      out.push(finding('fix', base, 'placed ' + count + ' times; the dashboard holds one ' + base + ' tile, the import drops the others', 'keep one'));
    } else if (DashboardInstances.isMirrorWidget(base) || key.includes(':')) {
      out.push(finding('consider', base, 'placed ' + count + ' times; the copies show the same content', 'keep one unless the repeat is the point'));
    }
  }
  return out;
}

// Rows stretch to fill the screen, so the page is COLS x its lowest edge; a
// lone tile stretches only down to MIN_FILL_ROWS (js/dashboard-grid.js).
function pageSpace(items) {
  const bottom = Math.max(...items.map((it) => it.y + it.h));
  const rows = items.length === 1 ? Math.max(bottom, DashboardGrid.MIN_FILL_ROWS) : bottom;
  const cells = new Set();
  for (const it of items) {
    for (let y = it.y; y < it.y + it.h; y++) for (let x = it.x; x < Math.min(it.x + it.w, COLS); x++) cells.add(y * COLS + x);
  }
  const total = COLS * rows;
  const coverage = cells.size / total;
  const gap = rows <= GAP_SCAN_ROWS ? DashboardGrid.largestFreeRect(items, COLS, rows) : null;
  const gapShare = gap ? (gap.w * gap.h) / total : 0;
  if (coverage >= MIN_COVERAGE && gapShare < BIG_GAP) return [];
  const where = gap ? 'empty block at ' + boxText(gap) : 'page';
  return [finding('consider', where, 'tiles cover ' + Math.round(coverage * 100) + '% of the page (' + COLS + 'x' + rows + ')',
    'grow the tiles or add one to fill the space')];
}

function critiquePage(page, deps) {
  const items = normalizedItems(page, deps);
  if (!items.length) return [];
  return [...pageOutside(items), ...pageOverlaps(items), ...pageDuplicates(items), ...pageSpace(items)];
}

// ── native Ambient scene ───────────────────────────────────────────────────

// Elements that draw text the viewer reads (everything but pictures and shapes).
const SILENT_TYPES = new Set(['image', 'shape', 'sdk']);
// The text element's size is CSS px on the real screen (js/ambient-canvas.js).
const MIN_TEXT_PX = 12;
const COMFORT_TEXT_PX = 16;
// WCAG "large": 24px regular, or about 18.7px bold.
const isLargeText = (p) => p.size >= 24 || (p.size >= 19 && p.weight >= 700);
// Two text boxes sharing more than this share of the smaller one collide.
const TEXT_OVERLAP = 0.15;

const compName = (c, i) => 'components[' + i + '] (' + c.type + ')';
const samePage = (a, b) => a.page == null || b.page == null || a.page === b.page;

function sceneEmpty(scene) {
  if (!scene.components.length) return [finding('fix', 'scene', 'no elements: the scene shows only its background', 'add at least a clock or a text')];
  if (!scene.pages) return [];
  const out = [];
  for (let p = 0; p < scene.pages.count; p++) {
    if (!scene.components.some((c) => c.page == null || c.page === p)) {
      out.push(finding('fix', 'page ' + (p + 1), 'no element on this page', 'put an element on it or lower pages.count'));
    }
  }
  return out;
}

function sceneOutside(scene) {
  return scene.components.flatMap((c, i) => (c.x + c.w > 100 || c.y + c.h > 100
    ? [finding('fix', compName(c, i), 'runs off the screen (' + boxText(c) + ' in percent)', 'keep x + w and y + h at most 100')]
    : []));
}

function sceneTextOverlaps(scene) {
  const texty = scene.components.map((c, i) => ({ c, i })).filter(({ c }) => !SILENT_TYPES.has(c.type));
  const out = [];
  texty.forEach((a, n) => texty.slice(n + 1).forEach((b) => {
    if (!samePage(a.c, b.c)) return;
    const shared = overlapArea(a.c, b.c) / Math.min(a.c.w * a.c.h, b.c.w * b.c.h);
    if (shared > TEXT_OVERLAP) {
      out.push(finding('fix', compName(a.c, a.i) + ' and ' + compName(b.c, b.i), 'text over text (' + Math.round(shared * 100) + '% of the smaller box)',
        'move them apart, or give them different pages or time windows'));
    }
  }));
  return out;
}

function sceneTextSize(scene) {
  return scene.components.flatMap((c, i) => {
    if (c.type !== 'text') return [];
    if (!c.props.text.trim()) return [finding('fix', compName(c, i), 'the text is empty', 'write the text or remove the element')];
    if (c.props.size < MIN_TEXT_PX) return [finding('fix', compName(c, i), 'size ' + c.props.size + 'px is too small to read', 'use ' + COMFORT_TEXT_PX + 'px or more')];
    if (c.props.size < COMFORT_TEXT_PX) return [finding('consider', compName(c, i), 'size ' + c.props.size + 'px is hard to read from a distance', 'use ' + COMFORT_TEXT_PX + 'px or more')];
    return [];
  });
}

const dimmed = (color, dim) => (dim ? themePalette.mix(color, '#000000', dim / 100) : color);
const gradColors = (g) => (g.stops ? g.stops.map((s) => s.color) : [g.from, g.to]);

// The colours behind a text element: an opaque shape under it that holds the
// whole box, else the scene background. null when unknowable (a picture, the
// user's wallpaper, a see-through or blurred shape).
function backdropOf(scene, comp, index) {
  const order = (c, i) => c.z * 1000 + i;
  const under = scene.components
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => c.type === 'shape' && order(c, i) < order(comp, index) && samePage(c, comp) && contains(c, comp))
    .sort((a, b) => order(b.c, b.i) - order(a.c, a.i))[0];
  if (under) {
    const s = under.c;
    const solid = (s.opacity == null || s.opacity === 100) && !s.props.blur && !['ring', 'line'].includes(s.props.kind);
    if (!solid) return null;
    return s.props.grad ? gradColors(s.props.grad) : [s.props.color];
  }
  const bg = scene.bg;
  if (bg.type === 'color') return [dimmed(bg.color, bg.dim)];
  if (bg.type === 'gradient' && bg.grad) return gradColors(bg.grad).map((c) => dimmed(c, bg.dim));
  return null;
}

function sceneTextContrast(scene) {
  return scene.components.flatMap((c, i) => {
    if (c.type !== 'text' || !c.props.text.trim()) return [];
    const backs = backdropOf(scene, c, i);
    if (!backs) return [];
    // A see-through element blends its colour into what is behind it.
    const alpha = c.opacity == null ? 1 : c.opacity / 100;
    const pairs = backs.map((b) => ({ b, fg: themePalette.mix(b, c.props.color, alpha) }));
    const worst = pairs.reduce((a, p) => (themePalette.contrast(p.fg, p.b) < themePalette.contrast(a.fg, a.b) ? p : a));
    const out = contrastFinding(compName(c, i), worst.fg, [worst.b], isLargeText(c.props) ? LARGE_TEXT : BODY_TEXT, 'props.color');
    if (out && alpha < 1) out.hint = 'opacity ' + c.opacity + ' fades the text: raise it, or change props.color';
    return out ? [out] : [];
  });
}

function critiqueScene(rawScene) {
  const scene = AmbientScene.normalizeScene(rawScene);
  if (!scene) return [];
  return [...sceneEmpty(scene), ...sceneOutside(scene), ...sceneTextOverlaps(scene), ...sceneTextSize(scene), ...sceneTextContrast(scene)];
}

module.exports = { critiquePage, critiqueScene, MIN_COVERAGE, MIN_TEXT_PX, COMFORT_TEXT_PX };
