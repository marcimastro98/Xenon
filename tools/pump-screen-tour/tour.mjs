// A person's first afternoon with a pump screen, on a throwaway engine (tools/ci/engine-rig.mjs):
// the pump says hello while the menu is open, the person opens it, opens a line and changes the
// numbers, picks an example, puts a GIF of their own on it, adds a line for the night, a face
// shown by hand and the way back to automatic, the alerts, turns the pump, Xenon restarts, the
// menu on a phone, and the widget taken off in iCUE (the pump's page closes).
// After every step a picture of the pump and of the menu, to look at with your own eyes.
// Checks on the way, exit 1 on any: the pump card shows up by itself, no page error, the pump's
// words stay in the language after its first refresh, no sideways scroll on the phone, the pump
// leaves the menu within GONE_WITHIN_MS of its page closing.
// Requests go only to the copy, and only reads, the pump's own routes and pump actions.
// Run: node tools/pump-screen-tour/tour.mjs [outDir] [--lang it] [--port 3071]
// (default <temp>/xenon-pump-tour); about a minute and a half. Test: pump-screen-tour.test.mjs.

import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startRig } from '../ci/engine-rig.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GIF = path.join(ROOT, 'docs', 'images', 'widget-expand.gif');
const PUMP = { width: 480, height: 480 };
const SETTLE_MS = 1500;
const PHONE = { width: 390, height: 844 };
// The pump face's English word for a reading, never on screen in another language.
const ENGLISH_WORD = 'CPU temp';
// The page holds a connection (pump-screen/presence.js GONE_MS), and the menu redraws on the news.
const GONE_WITHIN_MS = 8000;

// Same host only; reads, the pump page's and the menu's own routes, a picture of the person's
// own, and actions that are pump actions. Anything else is stopped and listed.
export function allowRequest({ method, url, body }, origin) {
  const u = new URL(url);
  if (u.origin !== origin) return false;
  if (method === 'GET' || method === 'HEAD') return true;
  if (method !== 'POST') return false;
  if (/^\/pump(\/|$)/.test(u.pathname) || /^\/(screen-menu|xenon-menu)(\/|$)/.test(u.pathname)) return true;
  if (u.pathname !== '/actions/run') return false;
  try { return /^pump[A-Z]/.test(JSON.parse(body || '{}').type || ''); } catch { return false; }
}

const keep = (id) => `[data-keep="${id}"]`;
const tabs = '.xm-wtab';

// A face shown by hand, as Bit or a Deck key does it (the menu offers only the way back).
const pin = (face) => (m) => m.evaluate(async (f) => {
  const post = (body) => fetch('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const got = await post({ type: 'pumpGet' });
  return post({ type: 'pumpFace', screen: got.screens[0].screen, face: f });
}, face);

// Back on the first tab, the line for the rest of the time opened if it is not, its ring set to
// run round; the saved line must say so.
async function ringSpin(m) {
  await m.locator(tabs).nth(0).click();
  if (!(await m.locator('[data-row="pump-base-leds"]').count())) await m.click(keep('pump-base:head'));
  await m.click(keep('pump-base-leds:spin'));
  await m.waitForTimeout(SETTLE_MS);
  const leds = await m.evaluate(async () => {
    const r = await fetch('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'pumpGet' }) });
    return (await r.json()).screens?.[0]?.base?.leds;
  });
  if (leds !== 'spin') throw new Error(`the line's ring says ${leds}, not spin`);
  await m.locator('[data-row="pump-base-leds"]').scrollIntoViewIfNeeded();
}

// Each step: what the person does in the menu, and whether a picture of the menu is worth it.
export const STEPS = [
  { name: 'open-pump', menu: true, act: async (m) => { await m.locator('.xm-scrpump').first().click(); await m.waitForSelector('.xm-pumpframe.is-ready', { timeout: 8000 }).catch(() => {}); } },
  { name: 'open-rest', menu: true, act: (m) => m.click(keep('pump-base:head')) },
  { name: 'add-fps', act: (m) => m.click(keep('pump-base-readings:fps')) },
  { name: 'setup-music', menu: true, act: (m) => m.click(keep('pump-setup:music')) },
  { name: 'picture-face', act: (m) => m.click(keep('pump-base:face:picture')) },
  { name: 'own-gif', menu: true, act: (m) => m.setInputFiles('.xm-pumpown input[type=file]', GIF) },
  { name: 'open-game', menu: true, act: (m) => m.click(keep('pump-m-0:head')) },
  { name: 'add-night', menu: true, act: async (m) => { await m.click(keep('pump-add:head')); await m.click(keep('pump-add:night')); } },
  { name: 'now-game', menu: true, act: pin('game') },
  { name: 'now-music', act: pin('music') },
  { name: 'now-auto', menu: true, act: (m) => m.click(keep('pump:auto')) },
  { name: 'alerts', menu: true, act: (m) => m.locator(tabs).nth(1).click() },
  { name: 'turned-90', menu: true, act: async (m) => { await m.locator(tabs).nth(2).click(); await m.click(keep('pump-rotate:90')); } },
  { name: 'upright', act: (m) => m.click(keep('pump-rotate:0')) },
  // The ring takes the screen's colours, then the line for the rest of the time runs it round.
  { name: 'ring-screen', menu: true, act: (m) => m.click(keep('pump-leds:screen')) },
  { name: 'ring-spin', menu: true, act: ringSpin },
];

function parseArgs(argv) {
  const out = { dir: '', lang: 'it', port: 3071 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--lang') out.lang = argv[++i];
    else if (argv[i] === '--port') out.port = Number(argv[++i]);
    else out.dir = argv[i];
  }
  out.dir = path.resolve(out.dir || path.join(os.tmpdir(), 'xenon-pump-tour'));
  return out;
}

async function guard(context, origin, blocked) {
  await context.route('**/*', (route) => {
    const req = route.request();
    if (allowRequest({ method: req.method(), url: req.url(), body: req.postData() }, origin)) return route.continue();
    blocked.push(`${req.method()} ${req.url()}`);
    return route.abort();
  });
}

// The menu scrolls inside its own pane, so a whole picture of it grows the window to the
// pane's length for the shot, then puts it back.
const TALLEST = 6000;
async function menuShot(page, file) {
  const size = page.viewportSize();
  const tall = await page.evaluate(() => {
    const main = document.querySelector('.xm-main');
    return Math.max(document.documentElement.scrollHeight, main ? main.scrollHeight + main.getBoundingClientRect().top : 0);
  });
  const grow = tall > size.height;
  if (grow) await page.setViewportSize({ width: size.width, height: Math.min(Math.ceil(tall), TALLEST) });
  try { await page.screenshot({ path: file }); } finally { if (grow) await page.setViewportSize(size); }
}

async function tour({ dir, lang, port }) {
  await mkdir(dir, { recursive: true });
  const rig = await startRig({ port, seed: { language: lang } });
  if (!rig.up) throw new Error('the engine copy did not start:\n' + rig.output().slice(-2000));
  const origin = `http://127.0.0.1:${port}`;
  const problems = [];
  const blocked = [];
  let n = 0;
  const shot = (page, name, whole = false) => {
    const file = path.join(dir, `${String(++n).padStart(2, '0')}-${name}.png`);
    return whole ? menuShot(page, file) : page.screenshot({ path: file });
  };
  const browser = await loadPlaywright().chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      await guard(context, origin, blocked);
      const menu = await context.newPage();
      const pump = await context.newPage();
      menu.on('pageerror', (e) => problems.push('menu: ' + e.message));
      pump.on('pageerror', (e) => problems.push('pump: ' + e.message));
      await menu.goto(origin + '/menu', { waitUntil: 'load' });
      await menu.waitForSelector('.xm-scrmap', { timeout: 10000 });
      await pump.setViewportSize(PUMP);
      await pump.goto(`${origin}/pump-face?via=icue&shape=round&w=${PUMP.width}&h=${PUMP.height}`, { waitUntil: 'load' });
      if (!(await menu.waitForSelector('.xm-scrpump', { timeout: 8000 }).then(() => true, () => false))) problems.push('the pump card did not show up in the open menu');
      await pump.waitForTimeout(SETTLE_MS * 3);
      if (lang !== 'en' && (await pump.locator('body').allInnerTexts()).join(' ').includes(ENGLISH_WORD)) problems.push(`the pump writes English after its refresh (${lang})`);
      await shot(pump, 'pump-hello');
      for (const step of STEPS) {
        try { await step.act(menu); } catch (e) { problems.push(`${step.name}: ${e.message.split('\n')[0]}`); }
        await pump.waitForTimeout(SETTLE_MS);
        await shot(pump, step.name + '-pump');
        if (step.menu) await shot(menu, step.name + '-menu', true);
      }
      if (!(await rig.restart())) problems.push('the engine copy did not come back after a restart');
      await pump.waitForTimeout(SETTLE_MS * 4);
      await shot(pump, 'after-restart-pump');
      await menu.setViewportSize(PHONE);
      await menu.waitForTimeout(SETTLE_MS);
      await shot(menu, 'phone-menu', true);
      if (await menu.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) problems.push('the menu scrolls sideways on a phone');
      const closed = Date.now();
      await pump.close();
      const gone = await menu.waitForSelector('.xm-scrpump:not(.is-add)', { state: 'detached', timeout: GONE_WITHIN_MS }).then(() => true, () => false);
      if (!gone) problems.push(`the pump stayed in the menu ${GONE_WITHIN_MS / 1000} s after its page closed`);
      else console.log(`the pump left the menu ${((Date.now() - closed) / 1000).toFixed(1)} s after its page closed`);
      await shot(menu, 'widget-off-menu', true);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
    await rig.stop();
  }
  return { problems, blocked, shots: n };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { problems, blocked, shots } = await tour(args);
  console.log(`${shots} pictures in ${args.dir}`);
  for (const b of blocked) console.log('stopped: ' + b);
  for (const p of problems) console.error('PROBLEM ' + p);
  process.exitCode = problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
