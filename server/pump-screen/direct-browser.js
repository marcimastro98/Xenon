'use strict';
// The hidden browser that draws a pump's face for a screen Xenon speaks to itself
// (direct.js): the same /pump-face page iCUE or NZXT CAM would show, opened at the panel's
// size in a headless Edge or Chrome of its own (windows-tiles/browser-launch.js, its own
// profile), and filmed with DevTools' screencast: a JPEG each time the page changes, so a
// still face costs nothing. The next picture is asked for only after the gap the fps cap
// leaves. A command unanswered within CMD_MS, a page that stops answering the probe, or a
// browser that exits fail the whole thing once (onError, or start() rejecting while it runs);
// direct.js decides when to try again. stop() ends the browser with everything it started.

const CMD_MS = 8000;
const OPEN_MS = 10000;
const PROBE_MS = 30000;

/**
 * @param {{ launch: () => Promise<{ proc: any, wsUrl: string }>, WebSocketImpl: any, kill: (proc: any) => void,
 *   url: string, width: number, height: number, fps: number, quality: number,
 *   onFrame: (jpeg: Buffer) => void, onError: (reason: string) => void,
 *   later?: typeof setTimeout, cancel?: typeof clearTimeout, every?: typeof setInterval, stopEvery?: typeof clearInterval }} o
 */
function createDirectBrowser(o) {
  const later = o.later || setTimeout;
  const cancel = o.cancel || clearTimeout;
  const every = o.every || setInterval;
  const stopEvery = o.stopEvery || clearInterval;
  const gapMs = Math.round(1000 / o.fps);
  const waiting = new Map();
  let proc = null;
  let ws = null;
  let session = '';
  let probe = null;
  let lastFrame = 0;
  let ackTimer = null;
  let nextId = 1;
  let done = false;
  let started = false;
  let loaded = null;

  function fail(reason) {
    if (done) return;
    stop();
    // While start() runs its own rejection says what went wrong.
    if (started) o.onError(reason);
  }

  function cdp(method, params = {}, sessionId) {
    if (!ws || done) return Promise.reject(new Error('closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = later(() => { waiting.delete(id); reject(new Error('cdp_timeout')); fail('hung'); }, CMD_MS);
      timer?.unref?.();
      waiting.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  function frame(msg) {
    const { data, sessionId: ack } = msg.params || {};
    if (typeof data === 'string' && data) o.onFrame(Buffer.from(data, 'base64'));
    const wait = Math.max(0, lastFrame + gapMs - Date.now());
    lastFrame = Date.now() + wait;
    ackTimer = later(() => { ackTimer = null; cdp('Page.screencastFrameAck', { sessionId: ack }, session).catch(() => {}); }, wait);
    ackTimer?.unref?.();
  }

  function onMessage(ev) {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (msg.id && waiting.has(msg.id)) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      cancel(w.timer);
      if (msg.error) w.reject(new Error(msg.error.message || 'cdp_error'));
      else w.resolve(msg.result || {});
      return;
    }
    if (msg.sessionId !== session) return;
    if (msg.method === 'Page.screencastFrame') frame(msg);
    else if (msg.method === 'Page.loadEventFired' && loaded) loaded();
  }

  // The page loaded: the screencast refuses a page still on its way ("Not attached to an active page").
  function pageLoaded() {
    return new Promise(/** @param {(v?: any) => void} resolve */ (resolve, reject) => {
      const timer = later(() => { loaded = null; reject(new Error('page_load_timeout')); }, OPEN_MS);
      timer?.unref?.();
      loaded = () => { loaded = null; cancel(timer); resolve(); };
    });
  }

  function connect(wsUrl) {
    return new Promise(/** @param {(v?: any) => void} resolve */ (resolve, reject) => {
      const timer = later(() => reject(new Error('cdp_connect_timeout')), OPEN_MS);
      ws = new o.WebSocketImpl(wsUrl);
      ws.addEventListener('open', () => { cancel(timer); resolve(); });
      ws.addEventListener('error', () => { cancel(timer); reject(new Error('cdp_connect_failed')); });
      ws.addEventListener('close', () => fail('closed'));
      ws.addEventListener('message', onMessage);
    });
  }

  // The empty tab the browser starts with is a page process of its own that nobody films:
  // closed, so only the face page runs. Best effort: a tab that will not close costs memory, not
  // the screen.
  async function closeOthers(keep) {
    try {
      const { targetInfos } = await cdp('Target.getTargets', {});
      const spare = (Array.isArray(targetInfos) ? targetInfos : []).filter((t) => t?.type === 'page' && t.targetId !== keep);
      for (const t of spare) await cdp('Target.closeTarget', { targetId: t.targetId });
    } catch { /* refused: the page still films */ }
  }

  async function start() {
    const launched = await o.launch();
    proc = launched.proc;
    proc?.on?.('exit', () => fail('exited'));
    await connect(launched.wsUrl);
    // A window of its own: a page opened as a background tab is never drawn, so it has no
    // frames to film (embedded-browser.js createTargetWindow, the same for the Browser tile).
    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank', newWindow: true, width: o.width, height: o.height });
    ({ sessionId: session } = await cdp('Target.attachToTarget', { targetId, flatten: true }));
    await closeOthers(targetId);
    await cdp('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: 1, mobile: false }, session);
    await cdp('Page.enable', {}, session);
    const ready = pageLoaded();
    await cdp('Page.navigate', { url: o.url }, session);
    await ready;
    await cdp('Page.startScreencast', { format: 'jpeg', quality: o.quality, maxWidth: o.width, maxHeight: o.height, everyNthFrame: 1 }, session);
    probe = every(() => { cdp('Runtime.evaluate', { expression: '1' }, session).catch(() => {}); }, PROBE_MS);
    probe?.unref?.();
  }

  function stop() {
    if (done) return;
    done = true;
    if (probe) stopEvery(probe);
    if (ackTimer) cancel(ackTimer);
    for (const w of waiting.values()) { cancel(w.timer); w.reject(new Error('closed')); }
    waiting.clear();
    try { ws?.close(); } catch { /* already closed */ }
    ws = null;
    if (proc) o.kill(proc);
    proc = null;
  }

  async function begin() {
    try { await start(); started = true; } catch (e) { stop(); throw e; }
  }

  return { start: begin, stop };
}

module.exports = { createDirectBrowser, CMD_MS, PROBE_MS };
