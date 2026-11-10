// Layout mode covers each tile with a drag overlay (z 40) and lifts the few controls
// meant to work while editing above it. A z-index only lifts out of a panel that is
// not a stacking context of its own, and 5.0.0's Liquid Glass made every panel one
// (backdrop-filter): tabs could no longer be switched, removed or reordered. So the
// panel holding such a control is lifted as a whole and made click-through
// (DashboardGrid.css). This keeps every lifted control in that rule.
// The real-browser check is tools/edit-tabs-check/check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRID_CSS = path.join(SERVER, 'components', 'DashboardGrid', 'DashboardGrid.css');

// Lifted, but not from inside a panel: the edit bar is the tile content's own child,
// the resize handles the grid item's, the dock floats over the page.
const OUTSIDE_PANELS = [/\.gs-edit-bar$/, /\.ui-resizable-(se|nw)$/, /\.layout-dock$/];

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return cssFiles(p);
    return p.endsWith('.css') ? [p] : [];
  });
}

function rules(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return Array.from(clean.matchAll(/([^{}]+)\{([^{}]*)\}/g), (m) => ({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));
}

const zOf = (body) => { const m = /z-index:\s*(\d+)/.exec(body); return m ? Number(m[1]) : null; };

// The part of a selector after `.layout-editing`, e.g. ".cw-body .cw-btn".
const control = (sel) => sel.replace(/^.*?layout-editing\S*\s+/, '').trim();

function splitList(list) {
  return list.split(',').map((s) => s.trim()).filter(Boolean);
}

function liftLists() {
  const grid = rules(readFileSync(GRID_CSS, 'utf8'));
  const lift = grid.find((r) => r.selector.startsWith('.layout-editing .grid-stack-item-content > :has('));
  const reach = grid.find((r) => /^\.layout-editing :is\(/.test(r.selector) && /pointer-events:\s*auto/.test(r.body));
  assert.ok(lift, 'DashboardGrid.css lifts the panels holding edit-mode controls');
  assert.ok(reach, 'DashboardGrid.css gives those controls the pointer back');
  return {
    lift, reach,
    lifted: splitList(/:has\((.*)\)\s*$/.exec(lift.selector)[1]),
    reachable: splitList(/:is\((.*)\)\s*$/.exec(reach.selector)[1]),
  };
}

test('every control lifted above the drag overlay from inside a panel is in the panel lift', () => {
  const { lifted, reachable } = liftLists();
  const found = [];
  for (const file of cssFiles(path.join(SERVER, 'components')).concat(cssFiles(path.join(SERVER, 'styles')))) {
    for (const { selector, body } of rules(readFileSync(file, 'utf8'))) {
      const z = zOf(body);
      if (!selector.includes('layout-editing') || z === null || z <= 40 || selector.includes(':has(')) continue;
      for (const one of splitList(selector)) {
        const c = control(one);
        if (OUTSIDE_PANELS.some((re) => re.test(c))) continue;
        found.push(c);
        assert.ok(lifted.includes(c), `${path.basename(file)}: "${c}" sits above the overlay; add it to the panel lift in DashboardGrid.css`);
        assert.ok(reachable.includes(c), `${path.basename(file)}: "${c}" must get pointer-events back in DashboardGrid.css`);
      }
    }
  }
  assert.ok(found.includes('.tabgroup-bar') && found.includes('.vol-hidden-hint'), 'the scan still finds the known controls');
});

test('a lifted panel sits between the drag overlay and the edit bar, and lets drags through', () => {
  const grid = rules(readFileSync(GRID_CSS, 'utf8'));
  const overlay = zOf(grid.find((r) => r.selector === '.layout-editing .gs-edit-overlay').body);
  const bar = zOf(grid.find((r) => r.selector === '.layout-editing .gs-edit-bar').body);
  const { lift } = liftLists();
  const z = zOf(lift.body);
  assert.ok(z > overlay && z < bar, `panel lift z ${z} must be above the overlay (${overlay}) and below the edit bar (${bar})`);
  assert.match(lift.body, /pointer-events:\s*none/);
});
