// The "When you see it" sheet's moving picture: the real map of the Widgets section,
// with real drags, on a side copy of the server (.claude/scripts/side-server.mjs).
// It clears that copy's widgets to set the scene, so it refuses the real port.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export const CLIP = { width: 960, height: 920, fps: 30 };
const VIEWPORT = { width: 1180, height: 1130 };
const REAL_PORT = '3030';
const CURSOR_STEPS = 26;
const SETTLE_MS = 1100;

export const SCREENS = Object.freeze([
  { key: 'MAIN', primary: true, name: 'Big screen', width: 3840, height: 2160, x: 0, y: 0 },
  { key: 'WIDE', primary: false, name: 'Touch bar', width: 2560, height: 720, x: 573, y: 2160 },
  { key: 'SIDE', primary: false, name: 'Side screen', width: 1920, height: 1080, x: -1920, y: 592 },
]);

const SCENE = Object.freeze([
  { widget: 'weather', position: 'top-left', size: 'medium', surface: 'overlay', show: 'always' },
  { widget: 'notes', position: 'bottom-left', size: 'medium', surface: 'desktop' },
  { widget: 'perf', position: 'top-right', size: 'hud', surface: 'overlay', show: 'gaming' },
]);

/** A copy on any port but the real one: the clip wipes the widgets it finds. */
export function assertSideCopy(base) {
  if (new URL(base).port === REAL_PORT) throw new Error('map clip: point WN_MENU_URL at a side copy, never the real server');
}

async function seed(base) {
  const post = async (route, body) => {
    const res = await fetch(new URL(route, base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(base).origin }, body: JSON.stringify(body) });
    return res.json();
  };
  await post('/layers/host', { layers: true, menu: true, anchor: true, monitors: SCREENS });
  const { placed = [] } = await post('/actions/run', { type: 'layerList' });
  for (const w of placed) await post('/actions/run', { type: 'layerRemove', target: w.id });
  for (const w of SCENE) await post('/actions/run', { type: 'layerPlace', ...w });
}

async function dragTo(page, node, x, y) {
  const box = await node.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: CURSOR_STEPS });
  await page.waitForTimeout(160);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: CURSOR_STEPS * 2 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(SETTLE_MS);
}

async function pressView(page, view) {
  const box = await page.locator(`[data-keep="view:${view}"]`).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: CURSOR_STEPS });
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(SETTLE_MS);
}

/** What the clip shows: one widget to the very top, one to another monitor, then a game. */
async function play(page) {
  const screens = page.locator('.xm-mapscreen');
  await page.waitForTimeout(600);
  const main = await screens.nth(0).boundingBox();
  await dragTo(page, page.locator('.xm-mapw').nth(1), main.x + main.width * 0.62, main.y + main.height * 0.1);
  const wide = await screens.nth(1).boundingBox();
  await dragTo(page, page.locator('.xm-mapw').first(), wide.x + wide.width * 0.5, wide.y + wide.height * 0.5);
  await pressView(page, 'game');
  await pressView(page, 'now');
}

export async function recordMap(browser, base, dir, cursor) {
  assertSideCopy(base);
  await seed(base);
  const ctx = await browser.newContext({ viewport: VIEWPORT, locale: 'en-US', colorScheme: 'dark' });
  const frames = [];
  const timer = setInterval(() => { seedReport(base); }, 5000);
  try {
    await ctx.addInitScript({ content: cursor });
    const page = await ctx.newPage();
    await page.goto(new URL('/menu', base).href, { waitUntil: 'load' });
    await page.locator('.xm-nav button', { hasText: 'Widgets' }).first().click();
    await page.locator('.xm-map').waitFor();
    await page.waitForTimeout(1500);
    const cdp = await ctx.newCDPSession(page);
    cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
      const file = path.join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      frames.push({ file, at: metadata.timestamp });
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
    await play(page);
    await cdp.send('Page.stopScreencast');
    return frames;
  } finally {
    clearInterval(timer);
    await ctx.close();
  }
}

// A report lasts a few seconds on the server: the shell repeats it, here so does this.
function seedReport(base) {
  fetch(new URL('/layers/host', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(base).origin }, body: JSON.stringify({ layers: true, menu: true, anchor: true, monitors: SCREENS }) }).catch(() => {});
}
