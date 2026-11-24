// Tries Xenon's own driver for the CORSAIR pump screen (server/pump-screen/lcd-link.js) on the real
// screen, with iCUE closed. Numbered test cards at 10 pictures a second, then pictures further and
// further apart, each card saying the pause that follows it, then it stops. What to look at on the
// pump: whether the cards show at all (the screen takes pictures with no iCUE), and after which pause
// the CORSAIR picture comes back between two cards (how often Xenon must feed it).
// Only picture parts are ever written (lcd-corsair.js isPictureReport). Refuses while iCUE runs.
// Needs Playwright (XENON_PLAYWRIGHT, or the xenon-maker checkout beside this one) to draw the cards.
// Run: node tools/pump-direct/try.mjs [--fps 10] [--seconds 10] [--pauses 2,4,8,15,30]
// Windows and Linux. Test: server/test/pump-direct-tool.test.mjs.
import { createRequire } from 'node:module';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const require = createRequire(import.meta.url);
const Lcd = require('../../server/pump-screen/lcd-corsair.js');
const { createLcdLink } = require('../../server/pump-screen/lcd-link.js');
const { createLinkBusy } = require('../../server/airflow/link-busy.js');

const PANEL = Lcd.panelOf(0x1b1c, 0x0c4e);
const QUALITY = 80;
const COLOURS = ['#e8453c', '#f2a93b', '#3fb37f', '#3b82f6', '#a855f7'];

export function parseArgs(argv) {
  const out = { fps: 10, seconds: 10, pauses: [2, 4, 8, 15, 30] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--fps') out.fps = Number(argv[++i]);
    else if (argv[i] === '--seconds') out.seconds = Number(argv[++i]);
    else if (argv[i] === '--pauses') out.pauses = String(argv[++i]).split(',').map(Number);
  }
  if (!(out.fps > 0 && out.fps <= 30)) throw new Error('--fps: 1..30');
  if (!(out.seconds > 0 && out.seconds <= 60)) throw new Error('--seconds: 1..60');
  if (!out.pauses.length || out.pauses.some((p) => !(p > 0 && p <= 120))) throw new Error('--pauses: seconds 1..120, comma separated');
  return out;
}

// One card: a colour, a big number, and the line under it. Drawn as plain HTML, nothing loaded.
export function cardHtml(n, line) {
  const bg = COLOURS[n % COLOURS.length];
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return `<!doctype html><html><body style="margin:0;width:${PANEL.width}px;height:${PANEL.height}px;background:${bg};color:#fff;`
    + 'font:700 150px system-ui,sans-serif;display:grid;place-items:center;text-align:center">'
    + `<div>${n}<div style="font-size:34px;font-weight:600">${esc(line)}</div></div></body></html>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString();

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const busy = await createLinkBusy()();
  if (busy.length) throw new Error(`close ${busy.join(', ')} first: two programs on the screen at once draw over each other`);
  const hid = require(process.platform === 'win32' ? '../../server/hid/hid-windows.js' : '../../server/hid/hid-linux.js');
  const { openReports } = require(process.platform === 'win32' ? '../../server/hid/hid-reports-windows.js' : '../../server/hid/hid-reports-linux.js');
  const errors = [];
  // No keeper here: the pauses must be real.
  const link = createLcdLink({ panel: PANEL, hid, openReports, onError: (e) => errors.push(e.message), setTimer: () => 0, clearTimer: () => {} });
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: PANEL.width, height: PANEL.height } });
    try {
      const page = await context.newPage();
      const show = async (n, line) => {
        await page.setContent(cardHtml(n, line));
        link.show(await page.screenshot({ type: 'jpeg', quality: QUALITY }));
      };
      console.log(`${stamp()} ${opts.seconds} s at ${opts.fps} pictures a second`);
      const frames = Math.round(opts.seconds * opts.fps);
      for (let n = 1; n <= frames; n += 1) {
        const t = Date.now();
        await show(n, `${opts.fps} al secondo`);
        await sleep(Math.max(0, 1000 / opts.fps - (Date.now() - t)));
      }
      let n = frames;
      for (const p of opts.pauses) {
        n += 1;
        await show(n, `ora pausa ${p} s`);
        console.log(`${stamp()} card ${n}, then nothing for ${p} s`);
        await sleep(p * 1000);
      }
      await show(n + 1, 'fine');
      await sleep(500);
      console.log(`${stamp()} last card ${n + 1}: stopped, the screen goes back to its own picture`);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
    await link.close();
  }
  if (errors.length) throw new Error(`the screen refused: ${[...new Set(errors)].join('; ')}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
