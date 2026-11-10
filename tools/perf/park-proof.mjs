// Live proof of the parked pages on the real dashboard: nothing moves behind the lock, loops come
// back with their page, the idle sweep and the park agree, no frames are asked for nothing. It needs
// a dashboard with at least two pages. Exit code 1 when a check fails.
//   node tools/perf/park-proof.mjs <port>
import { eventRates, keepLockScreenAway, withDashboard } from './browser.mjs';

const FRAMES_LIMIT = 60;
const IDLE_TIMEOUT_MS = 80000;

let failed = 0;
function check(ok, label, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} ${detail}`);
}

function installReaders() {
  window.__motion = () => {
    const rows = { parked: {}, shown: {} };
    for (const animation of document.getAnimations()) {
      const target = animation.effect && animation.effect.target;
      if (!target) continue;
      const where = target.closest && target.closest('.pager-page.is-parked') ? 'parked' : 'shown';
      const key = `${animation.playState} ${animation.animationName || animation.transitionProperty || 'script'}`;
      rows[where][key] = (rows[where][key] || 0) + 1;
    }
    return rows;
  };
  window.__pages = () => [...document.querySelectorAll('.pager-page')].map((element) => ({
    id: element.id,
    parked: element.classList.contains('is-parked'),
    parking: element.classList.contains('is-parking'),
    hidden: element.hidden,
  }));
}

const allPaused = (rows) => Object.keys(rows).every((key) => key.startsWith('paused'));
const anyRunning = (rows) => Object.keys(rows).some((key) => key.startsWith('running'));

function forceReadsInsideParkedPages() {
  const paths = [...document.querySelectorAll('.pager-page.is-parked path')].slice(0, 12);
  for (const element of paths) {
    element.setAttribute('d', `M0 ${Math.random() * 20}L30 ${Math.random() * 20}`);
    element.getBBox();
    getComputedStyle(element).d;
  }
  return paths.length;
}

// A loop a script has played no longer listens to CSS: the idle thaw leaves them like that.
function playLoopsFromScript() {
  let touched = 0;
  for (const animation of document.getAnimations()) {
    const target = animation.effect && animation.effect.target;
    if (animation.playState === 'running' && target && target.closest && target.closest('.pager-page:not(.is-parked)')) {
      animation.pause();
      animation.play();
      touched += 1;
    }
  }
  return touched;
}

async function proveAtRest(page, motion, framesForNothing) {
  check(allPaused((await motion()).parked), 'nothing moves on a parked page');
  check((await framesForNothing()) < FRAMES_LIMIT, 'no frames for nothing after boot');
  console.log('paths touched', await page.evaluate(forceReadsInsideParkedPages));
  await page.waitForTimeout(1500);
  const { parked } = await motion();
  check(!Object.keys(parked).some((key) => / d$/.test(key)), 'a forced read starts no glide', JSON.stringify(parked));
  check((await framesForNothing()) < FRAMES_LIMIT, 'and asks for no frames');
}

async function proveRoundTrip(page, motion, framesForNothing, go, parkedId, homeId) {
  await go(parkedId);
  const pages = await page.evaluate(() => window.__pages());
  check(pages.some((entry) => entry.id === parkedId && !entry.parked && !entry.parking), 'the page I went to is free');
  const touched = await page.evaluate(playLoopsFromScript);
  await go(homeId);
  check(allPaused((await motion()).parked), 'a scripted loop stops with its page too');
  check((await framesForNothing()) < FRAMES_LIMIT, 'no frames after the round trip');
  await go(parkedId);
  check(touched === 0 || anyRunning((await motion()).shown), 'and comes back');
  await go(homeId);
}

async function proveIdle(page, motion, framesForNothing, parkedId) {
  await page.waitForFunction(() => document.body.classList.contains('ambient-idle'), null, { timeout: IDLE_TIMEOUT_MS });
  await page.waitForTimeout(300);
  await page.evaluate((id) => document.getElementById(id).scrollIntoView({ behavior: 'instant', inline: 'start' }), parkedId);
  await page.waitForTimeout(1500);
  const running = Object.keys((await motion()).shown)
    .filter((key) => key.startsWith('running') && !key.includes('xe-ticker') && !/ (d|clip-path|opacity|transform)$/.test(key));
  check(running.length === 0, 'a page change while idle wakes no loop', running.join(', '));
  await page.mouse.move(400, 300);
  await page.mouse.move(420, 320);
  await page.waitForTimeout(400);
  check(allPaused((await motion()).parked), 'waking plays nothing on a parked page');
  const frames = await framesForNothing();
  check(frames < FRAMES_LIMIT, 'no frames after the wake', String(frames));
}

async function main() {
  const [port] = process.argv.slice(2);
  if (!port) throw new Error('usage: node tools/perf/park-proof.mjs <port>');
  await withDashboard(port, async ({ browser, page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error).slice(0, 200)));
    await page.waitForTimeout(7000);
    await keepLockScreenAway(page);
    await page.evaluate(installReaders);
    const motion = () => page.evaluate(() => window.__motion());
    const framesForNothing = async () => (await eventRates(browser, page, ['MainFrameAborted'])).MainFrameAborted;
    const go = async (id) => {
      await page.evaluate((target) => document.getElementById(target).scrollIntoView({ behavior: 'instant', inline: 'start' }), id);
      await page.waitForTimeout(1500);
    };
    await proveAtRest(page, motion, framesForNothing);
    const pages = await page.evaluate(() => window.__pages());
    const parkedId = pages.find((entry) => entry.parked)?.id;
    const homeId = pages.find((entry) => !entry.parked && !entry.hidden)?.id;
    check(Boolean(parkedId && homeId), 'the dashboard has a second page to park');
    if (parkedId && homeId) {
      await proveRoundTrip(page, motion, framesForNothing, go, parkedId, homeId);
      await proveIdle(page, motion, framesForNothing, parkedId);
    }
    check(errors.length === 0, 'no page errors', errors.join(' | '));
  });
  console.log(failed ? `${failed} FAILED` : 'all good');
  process.exitCode = failed ? 1 : 0;
}

await main();
