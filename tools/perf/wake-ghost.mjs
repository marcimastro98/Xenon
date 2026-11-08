// A loop started on an element that left the page: no sweep can see it, and it asks for a frame on
// every vsync until the page reloads. This waits for the idle freeze, changes page while idle so a
// tile re-renders, wakes the page and lists every play() on something not paused or not in the
// page, then cancels those and reads again: if the rate falls, they were the cause.
//   node tools/perf/wake-ghost.mjs <port> [pageIndex]
// CPU_MS sets the length of each CPU reading, 15000 by default.
import { browserCpu, eventRates, formatCpu, keepLockScreenAway, withDashboard } from './browser.mjs';

const CPU_MS = Number(process.env.CPU_MS || 15000);
const IDLE_TIMEOUT_MS = 80000;
const RATES = ['MainFrameAborted', 'UpdateLayoutTree'];

function recordPlays() {
  window.__ghosts = [];
  const { play } = Animation.prototype;
  Animation.prototype.play = function recorded() {
    const target = this.effect && this.effect.target;
    const connected = Boolean(target && target.isConnected);
    if (this.playState !== 'paused' || !connected) {
      const name = this.animationName || this.transitionProperty || 'script';
      window.__ghosts.push({ animation: this, row: `${this.playState} ${name} on ${target ? target.tagName : 'no target'}, in the page: ${connected}` });
    }
    return play.call(this);
  };
}

async function wake(page) {
  await page.mouse.move(400, 300);
  await page.mouse.move(420, 320);
  await page.waitForTimeout(600);
}

async function main() {
  const [port, pageIndex = '1'] = process.argv.slice(2);
  if (!port) throw new Error('usage: node tools/perf/wake-ghost.mjs <port> [pageIndex]');
  await withDashboard(port, async ({ browser, page }) => {
    await page.waitForTimeout(7000);
    await keepLockScreenAway(page);
    const ids = await page.evaluate(() => [...document.querySelectorAll('.pager-page')].map((element) => element.id));
    await page.waitForFunction(() => document.body.classList.contains('ambient-idle'), null, { timeout: IDLE_TIMEOUT_MS });
    await page.waitForTimeout(500);
    await page.evaluate((id) => document.getElementById(id).scrollIntoView({ behavior: 'instant', inline: 'start' }), ids[Number(pageIndex)]);
    await page.waitForTimeout(1500);
    await page.evaluate(() => { window.__ghosts.length = 0; });
    await wake(page);
    console.log('after the wake', JSON.stringify(await eventRates(browser, page, RATES)));
    console.log('cpu with them:', formatCpu(await browserCpu(browser, page, CPU_MS)));
    const rows = await page.evaluate(() => window.__ghosts.map((ghost) => ghost.row));
    console.log(`play() on something not paused or not in the page: ${rows.length}`);
    for (const row of new Set(rows)) console.log(`  ${rows.filter((other) => other === row).length}x ${row}`);
    await page.evaluate(() => { for (const ghost of window.__ghosts) ghost.animation.cancel(); });
    await page.waitForTimeout(400);
    console.log('after cancelling them', JSON.stringify(await eventRates(browser, page, RATES)));
    console.log('cpu without them:', formatCpu(await browserCpu(browser, page, CPU_MS)));
  }, { beforeLoad: (context) => context.addInitScript(recordPlays) });
}

await main();
