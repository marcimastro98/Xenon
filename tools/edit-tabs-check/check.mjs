// Layout mode on the built demo, in a real browser, on every skin: the controls meant
// to work while editing (a tab group's tabs and their remove buttons, the System and
// Agenda tab bars) must take the pointer, and the rest of each tile must still be the
// drag surface. Then it really switches a tab, drags one past the next and removes one.
// 5.0.0 broke all of it on its default look (Liquid Glass): the panel's backdrop-filter
// trapped the tab bar under the drag overlay.
// The demo's DashboardGrid.css is swapped for the working tree's (docs/ is the live
// site and is never written); --old serves the demo's own, to see the bug.
// Run: node tools/edit-tabs-check/check.mjs [--old]
// Needs docs/demo: node tools/build-demo.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSite } from '../site-shots/serve.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKING_CSS = path.resolve(HERE, '..', '..', 'server', 'components', 'DashboardGrid', 'DashboardGrid.css');
const SKINS = ['liquid', 'classic', 'comic', 'retro'];
const CONTROLS = '.tabgroup-tab, .tabgroup-remove, .sys-tab, .cal-task-toggle button, .cw-body .cw-btn, .cw-swap-btn, .vol-hidden-hint button';
const SETTLE_MS = 3000;

// Runs in the page: which controls get the pointer, and whether the tile body still drags.
function readHits(controls) {
  const name = (el) => (el ? String(el.className || el.tagName).split(' ')[0] : 'nothing');
  const out = { blocked: [], bodiesNotDragging: [] };
  for (const el of document.querySelectorAll(controls)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !(hit === el || el.contains(hit))) out.blocked.push(name(el) + ' under ' + name(hit));
  }
  for (const body of document.querySelectorAll('.tabgroup-body, .system-tabs ~ *')) {
    const r = body.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) continue;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !hit.classList.contains('gs-edit-overlay')) out.bodiesNotDragging.push(name(body) + ' hits ' + name(hit));
  }
  return out;
}

// The first tab group on screen with at least two tabs, as the saved layout holds it.
// `gid` pins the same group once it is chosen.
function groupState(gid) {
  const groups = getDashboardLayout().groups || {};
  const shown = Array.from(document.querySelectorAll('.tabgroup[data-group-id]'))
    .filter((t) => t.getClientRects().length && t.querySelectorAll('.tabgroup-tab').length > 1)
    .map((t) => t.dataset.groupId);
  const id = gid || shown.find((g) => groups[g]);
  const g = id && groups[id];
  return g ? { id, members: g.members.slice(), active: g.active } : null;
}

async function tabBox(page, gid, mid, sel = '') {
  const loc = page.locator(`.tabgroup[data-group-id="${gid}"] .tabgroup-tab[data-member="${mid}"] ${sel}`.trim());
  return loc.boundingBox();
}

// Switch to the second tab, drag the first past the last, remove one: by mouse.
async function interact(page) {
  const before = await page.evaluate(groupState);
  if (!before) return ['no tab group in the demo layout'];
  const fails = [];
  const [first, second] = before.members;
  const target = before.active === first ? second : first;
  const t = await tabBox(page, before.id, target);
  await page.mouse.click(t.x + t.width / 2, t.y + t.height / 2);
  await page.waitForTimeout(300);
  if ((await page.evaluate(groupState, before.id)).active !== target) fails.push('a tap on a tab did not switch to it');

  const a = await tabBox(page, before.id, first);
  const last = await tabBox(page, before.id, before.members[before.members.length - 1]);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + a.width / 2 + ((last.x + last.width - 4) - (a.x + a.width / 2)) * i / 8, a.y + a.height / 2);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const moved = await page.evaluate(groupState, before.id);
  if (moved.members[0] === first) fails.push('dragging the first tab past the last did not reorder: ' + moved.members.join(','));

  const x = await tabBox(page, before.id, moved.members[0], '.tabgroup-remove');
  await page.mouse.click(x.x + x.width / 2, x.y + x.height / 2);
  await page.waitForTimeout(400);
  const after = await page.evaluate(groupState, before.id);
  const left = after && after.id === before.id ? after.members.length : 1;
  if (left !== before.members.length - 1) fails.push('the remove button did not take the tab out');
  return fails;
}

async function runSkin(browser, port, css, skin) {
  const ctx = await browser.newContext({ viewport: { width: 2560, height: 720 }, locale: 'en-US' });
  try {
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    if (css) await ctx.route('**/components/DashboardGrid/DashboardGrid.css', (r) => r.fulfill({ contentType: 'text/css', body: css }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/demo/`, { waitUntil: 'load' });
    await page.waitForTimeout(SETTLE_MS);
    await page.evaluate((s) => {
      if (s === 'classic') delete document.documentElement.dataset.style; else document.documentElement.dataset.style = s;
      setDashboardLayoutEditMode(true);
    }, skin);
    await page.waitForTimeout(500);
    const hits = await page.evaluate(readHits, CONTROLS);
    const fails = [...hits.blocked.map((b) => 'blocked: ' + b), ...hits.bodiesNotDragging.map((b) => 'tile body does not drag: ' + b)];
    fails.push(...await interact(page));
    fails.push(...errors.map((e) => 'page error: ' + e));
    return fails;
  } finally {
    await ctx.close();
  }
}

async function main() {
  const old = process.argv.includes('--old');
  const css = old ? '' : await readFile(WORKING_CSS, 'utf8');
  const { port, stop } = await startSite(0);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  let failed = 0;
  try {
    for (const skin of SKINS) {
      const fails = await runSkin(browser, port, css, skin);
      failed += fails.length ? 1 : 0;
      console.log((fails.length ? 'FAIL ' : 'ok   ') + skin + (fails.length ? '\n  ' + [...new Set(fails)].join('\n  ') : ''));
    }
  } finally {
    await browser.close();
    await stop();
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
