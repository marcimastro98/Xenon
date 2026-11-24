'use strict';
// Xenon on a pump screen with no other program in between: when a screen Xenon has a driver
// for is plugged in (detect.js, lcd-*.js) and none of its own programs runs (direct-apps.js),
// a hidden browser draws the pump's face (direct-browser.js) and lcd-link.js sends it to the
// screen. The person can turn it off (`direct` in the pump model); off, or with iCUE open,
// nothing is written to the screen. Checks every CHECK_MS while it draws or waits for a
// program to close, so Xenon steps aside within seconds when iCUE comes back; slower while no
// such screen is plugged in, and not at all while it is off. A failure stops everything and
// waits longer each time before the next try. The state is what the menu and Bit say.

const CHECK_MS = 5000;
const IDLE_MS = 60000;
const RETRY_MS = Object.freeze([15000, 60000, 300000]);
// Drawing this long without a failure counts as working again.
const HEALTHY_MS = 120000;

/**
 * @param {{ wanted: () => boolean, detect: () => Promise<any[]>, panelOf: (p: any) => any,
 *   holding: (panel: any) => Promise<string[]>, faceUrl: (panel: any) => string,
 *   makeLink: (o: { panel: any, onError: (e: Error) => void }) => { show: (jpeg: Buffer) => void, close: () => Promise<void> },
 *   makeBrowser: (o: { panel: any, url: string, onFrame: (jpeg: Buffer) => void, onError: (reason: string) => void }) => { start: () => Promise<void>, stop: () => void },
 *   changed?: () => void, clock?: () => number, later?: typeof setTimeout, cancel?: typeof clearTimeout }} d
 */
function createPumpDirect(d) {
  const later = d.later || setTimeout;
  const cancel = d.cancel || clearTimeout;
  const clock = d.clock || Date.now;
  const changed = d.changed || (() => {});
  let state = { state: 'off' };
  let drawing = null;
  let timer = null;
  let running = false;
  let again = false;
  let failures = 0;
  let stopped = false;

  function set(next) {
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    changed();
  }

  function arm(ms) {
    if (stopped) return;
    if (timer) cancel(timer);
    timer = later(tick, ms);
    timer?.unref?.();
  }

  async function halt() {
    const now = drawing;
    drawing = null;
    if (!now) return;
    now.browser.stop();
    await now.link.close();
  }

  function failed(reason) {
    failures += 1;
    set({ state: 'failed', reason: String(reason || 'unknown').slice(0, 120) });
    arm(RETRY_MS[Math.min(failures, RETRY_MS.length) - 1]);
  }

  // The link or the browser broke while drawing.
  function broke(owner, reason) {
    if (drawing !== owner) return;
    halt().catch(() => {});
    failed(reason);
  }

  async function begin(panel) {
    const owner = { panel, since: clock(), link: null, browser: null };
    owner.link = d.makeLink({ panel, onError: (e) => broke(owner, e.message) });
    owner.browser = d.makeBrowser({
      panel, url: d.faceUrl(panel),
      onFrame: (jpeg) => { try { owner.link.show(jpeg); } catch (e) { broke(owner, e.message); } },
      onError: (reason) => broke(owner, reason),
    });
    drawing = owner;
    await owner.browser.start();
  }

  async function step() {
    if (!d.wanted()) { await halt(); set({ state: 'off' }); return; }
    const panel = (await d.detect()).map(d.panelOf).find(Boolean);
    if (!panel) { await halt(); set({ state: 'none' }); arm(IDLE_MS); return; }
    const apps = await d.holding(panel);
    if (apps.length) { await halt(); set({ state: 'busy', app: apps[0] }); arm(CHECK_MS); return; }
    if (!drawing) {
      await begin(panel);
      // It broke while starting: broke() already chose when to try again.
      if (!drawing) return;
    }
    if (clock() - drawing.since >= HEALTHY_MS) failures = 0;
    set({ state: 'drawing', model: panel.model });
    arm(CHECK_MS);
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try {
      await step();
    } catch (e) {
      await halt().catch(() => {});
      failed(e?.message);
    } finally {
      running = false;
      if (again && !stopped) { again = false; arm(0); }
    }
  }

  return {
    // Look again now: the person turned it on or off, or asked to try again.
    refresh: () => { failures = 0; arm(0); },
    state: () => state,
    async stop() {
      stopped = true;
      if (timer) cancel(timer);
      timer = null;
      await halt();
    },
  };
}

module.exports = { createPumpDirect, CHECK_MS, IDLE_MS, RETRY_MS, HEALTHY_MS };
