// Who keeps the dashboard drawing: in every frame the loops running and the rate of
// requestAnimationFrame, then the browser's CPU and how many frames it asked for.
//   node tools/perf/frames.mjs <port> [settleMs] [css for every frame]
// Passing `*{animation:none!important;transition:none!important}` as css shows what is left.
// MEASURE_MS sets the length of the reading, 6000 by default.
import { browserCpu, eventRates, formatCpu, keepLockScreenAway, withDashboard } from './browser.mjs';

const MEASURE_MS = Number(process.env.MEASURE_MS || 6000);

function countAnimationFrames() {
  window.__rafCalls = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => { window.__rafCalls += 1; return raf(callback); };
}

function readFrame() {
  const name = (animation) => {
    const target = animation.effect && animation.effect.target;
    const where = target ? `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ''}` : 'no target';
    return `${animation.animationName || animation.transitionProperty || 'script'} on ${where}`;
  };
  return {
    raf: window.__rafCalls,
    loops: document.getAnimations().filter((animation) => animation.playState === 'running').map(name),
  };
}

async function readFrames(page) {
  return Promise.all(page.frames().map((frame) => frame.evaluate(readFrame).catch(() => null)));
}

async function main() {
  const [port, settleMs = '9000', css = ''] = process.argv.slice(2);
  if (!port) throw new Error('usage: node tools/perf/frames.mjs <port> [settleMs] [css]');
  await withDashboard(port, async ({ browser, page }) => {
    await page.waitForTimeout(Number(settleMs));
    await keepLockScreenAway(page);
    if (css) for (const frame of page.frames()) await frame.addStyleTag({ content: css }).catch(() => {});
    await page.waitForTimeout(800);
    const before = await readFrames(page);
    const cpu = await browserCpu(browser, page, MEASURE_MS);
    const after = await readFrames(page);
    after.forEach((frame, index) => {
      if (!frame || !before[index]) return;
      const rate = (frame.raf - before[index].raf) / (MEASURE_MS / 1000);
      if (rate || frame.loops.length) console.log(`[${index}] rAF ${rate.toFixed(1)}/s, ${frame.loops.length} running: ${frame.loops.slice(0, 8).join('; ')}`);
    });
    console.log('body:', await page.evaluate(() => document.body.className));
    console.log('cpu of a core:', formatCpu(cpu));
    console.log('per second:', JSON.stringify(await eventRates(browser, page, ['MainFrameAborted', 'UpdateLayoutTree', 'Paint'])));
  }, { beforeLoad: (context) => context.addInitScript(countAnimationFrames) });
}

await main();
