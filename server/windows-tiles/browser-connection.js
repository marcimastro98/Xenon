'use strict';
// The embedded browser's one Edge and its DevTools socket: started when a tile needs it and
// tried again when the start fails, asked a command with a time limit, primed for protected
// video, and stopped whole when idle, hung or shut down.

const { killProcessTree } = require('./browser-launch.js');

function makeConnection({
  WebSocketImpl, idleMs, cmdTimeoutMs, navTimeoutMs, edge, launch, pending, tiles, bySession,
  orphanSweep, scratchTargets, pendingAdoption, createTargetWindow, onMessage, clearResizeSettle,
  releaseFrameWaiters, checkAlive,
}) {
  // Tear down the current Edge + CDP socket without touching `ready`. Used both
  // by the retry loop (between attempts) and by killBrowser (which also clears
  // `ready` so the next open re-launches).
  function teardown(reason) {
    if (edge.idleTimer) { clearTimeout(edge.idleTimer); edge.idleTimer = null; }
    if (orphanSweep.sweepTimer) { clearTimeout(orphanSweep.sweepTimer); orphanSweep.sweepTimer = null; }
    pending.forEach((p) => p.reject(new Error(reason || 'browser_closed')));
    pending.clear();
    tiles.forEach(clearResizeSettle);
    tiles.forEach(releaseFrameWaiters);
    tiles.clear();
    bySession.clear();
    orphanSweep.initialTargetId = null;
    scratchTargets.clear();
    pendingAdoption.clear();
    if (edge.ws) { try { edge.ws.close(); } catch (e) { /* ignore */ } edge.ws = null; }
    if (edge.proc) { killProcessTree(edge.proc); edge.proc = null; }
    edge.widevineReady = null;   // per-Edge state; a fresh launch warms up again
  }

  function killBrowser(reason) { teardown(reason); edge.ready = null; }

  function armIdle() {
    if (edge.idleTimer) { clearTimeout(edge.idleTimer); edge.idleTimer = null; }
    if (tiles.size > 0) return;
    edge.idleTimer = setTimeout(() => { if (tiles.size === 0) killBrowser('idle'); }, idleMs);
    edge.idleTimer.unref && edge.idleTimer.unref();
  }

  // One launch+connect attempt. Resolves when the CDP socket is open, rejects on
  // any failure. Post-connect death (Edge exits, socket drops) routes through
  // killBrowser so the next open transparently re-launches.
  function attemptLaunch() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => { if (settled) return; settled = true; err ? reject(err) : resolve(); };
      Promise.resolve().then(launch).then(({ proc: p, wsUrl }) => {
        edge.proc = p;
        if (edge.proc && edge.proc.on) {
          edge.proc.on('exit', () => { if (edge.proc === p) killBrowser('edge_exited'); });
          edge.proc.on('error', () => { if (edge.proc === p) killBrowser('edge_error'); });
        }
        let sock;
        try { sock = new WebSocketImpl(wsUrl); } catch (e) { done(e); return; }
        edge.ws = sock;
        const timer = setTimeout(() => done(new Error('cdp_connect_timeout')), 10000);
        timer.unref && timer.unref();
        sock.addEventListener('open', () => { clearTimeout(timer); done(); });
        sock.addEventListener('error', () => { clearTimeout(timer); done(new Error('cdp_connect_failed')); });
        sock.addEventListener('close', () => { clearTimeout(timer); if (settled) killBrowser('cdp_closed'); else done(new Error('cdp_closed')); });
        sock.addEventListener('message', (ev) => onMessage(ev.data));
      }, (e) => done(e instanceof Error ? e : new Error('launch_failed')));
    });
  }

  // Launch with automatic self-healing: a failed attempt is fully torn down
  // (tree-killed) and — since `launch` sweeps stale profile Edge and clears the
  // profile lock — the next attempt starts clean. This recovers from an orphaned
  // headless Edge locking the profile after an unclean shutdown, with no manual
  // intervention. `ready` is held across retries so concurrent callers coalesce.
  function ensureBrowser() {
    if (edge.ready) return edge.ready;
    edge.ready = (async () => {
      const maxTries = 3;
      let lastErr;
      for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
          await attemptLaunch();
          // Passively discover new targets so we can render popups (window.open,
          // OAuth "Continue with…" windows) opened by our pages. Discovery is used
          // instead of Target.setAutoAttach because auto-attach, in flatten mode,
          // takes over the attachment of our manually-attached page sessions and
          // invalidates them ("Session with given id not found"), killing the
          // screencast — the tile then hangs on the loading spinner. Discovery only
          // NOTIFIES; we attach popups ourselves, exactly like the base page.
          await send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
          // Remember the tab Edge itself opened at launch (the trailing about:blank
          // in edgeArgs). It's the only page target that legitimately belongs to no
          // tile, so the orphan sweep must never close it — closing the last page
          // of the launch window is not worth risking.
          try {
            const r = await send('Target.getTargets', {});
            const page = (Array.isArray(r && r.targetInfos) ? r.targetInfos : []).find((t) => t && t.type === 'page');
            orphanSweep.initialTargetId = page ? page.targetId : null;
          } catch (e) { orphanSweep.initialTargetId = null; }
          warmUpWidevine();
          return;
        }
        catch (e) {
          lastErr = e;
          teardown('launch_retry');
          if (attempt < maxTries) await new Promise((r) => { const tm = setTimeout(r, 500 * attempt); tm.unref && tm.unref(); });
        }
      }
      throw lastErr || new Error('launch_failed');
    })();
    edge.ready.catch(() => { edge.ready = null; });   // let the next open try again fresh
    return edge.ready;
  }

  // Prime Widevine right after launch. Edge registers its bundled Widevine CDM
  // lazily and asynchronously, on the first `requestMediaKeySystemAccess` call —
  // so the first DRM site loaded on a fresh Edge (e.g. a tile auto-reopening to
  // twitch.tv right after a server restart) can ask before it's ready, get told
  // "unsupported", and keep showing its "browser not supported" wall until a
  // manual reload. This kicks the registration off on a scratch page and exposes
  // completion as `widevineReady`, which open() awaits (capped) before navigating,
  // so the first real page never races the CDM registration.
  function warmUpWidevine() {
    edge.widevineReady = (async () => {
      let targetId;
      try {
        ({ targetId } = await createTargetWindow('about:blank'));
        scratchTargets.add(targetId);   // ours, internal — the orphan sweep must skip it
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
        const expr = "navigator.requestMediaKeySystemAccess('com.widevine.alpha',[{initDataTypes:['cenc'],videoCapabilities:[{contentType:'video/mp4;codecs=\"avc1.42E01E\"',robustness:'SW_SECURE_DECODE'}]}]).then(function(){return 'ok';}).catch(function(){return 'no';})";
        for (let i = 0; i < 40; i++) {
          if (!edge.ws) break;   // browser torn down (idle/close) meanwhile — stop
          const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId).catch(() => null);
          // No `result` shape at all means a non-CDP environment (tests) — bail.
          if (!r || !r.result) break;
          if (r.result.value === 'ok') break;   // CDM registered
          await new Promise((res) => { const tm = setTimeout(res, 250); tm.unref && tm.unref(); });
        }
      } catch (e) { /* best effort — the on-demand path still works, just slower */ }
      finally {
        if (targetId) {
          send('Target.closeTarget', { targetId }).catch(() => {});
          scratchTargets.delete(targetId);
        }
      }
    })();
  }

  // Await Widevine registration before the first navigation, but never stall a
  // tile for long: cap the wait. Resolves instantly once the CDM is registered
  // (the warm-up promise is already settled for every launch after the first).
  function widevineGate() {
    if (!edge.widevineReady) return Promise.resolve();
    return Promise.race([
      edge.widevineReady,
      new Promise((r) => { const tm = setTimeout(r, 8000); tm.unref && tm.unref(); }),
    ]);
  }

  function send(method, params, sessionId, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!edge.ws) { reject(new Error('no_socket')); return; }
      const id = edge.nextId++;
      const sock = edge.ws;
      const limit = Number.isFinite(timeoutMs) ? timeoutMs
        : (method === 'Page.navigate' ? navTimeoutMs : cmdTimeoutMs);
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error('cdp_timeout'));
        checkAlive(sock);
      }, limit);
      timer.unref && timer.unref();
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const frame = { id, method, params: params || {} };
      if (sessionId) frame.sessionId = sessionId;
      try { edge.ws.send(JSON.stringify(frame)); }
      catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  return { killBrowser, armIdle, ensureBrowser, widevineGate, send };
}

module.exports = { makeConnection };
