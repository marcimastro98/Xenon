'use strict';
// Finding Wave Link's socket and listening to it: the published port of Wave Link 3 or the
// scanned ports of Wave Link 2, each address asked who it is, every frame read (the answer to a
// request, or a push), and the reason kept when none answers.

const {
  WL_HOSTS, WL_START_PORT, WL_PORT_SPAN, WL3_ORIGIN, REQ_TIMEOUT_MS, PROBE_TIMEOUT_MS,
} = require('./wavelink-ports.js');
const { appIdentity } = require('./wavelink-shape.js');

function makeSocket({
  WebSocketImpl, canSetOrigin, readPublished, wlLink, pending, bumpIdle, applyNotification,
}) {
  // Raw JSON-RPC send over an already-open socket (used during discovery, before
  // `ws`/`ready` are committed).
  function rawSend(sock, method, params) {
    return new Promise((resolve, reject) => {
      const id = ++wlLink.reqId;
      const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error('wl_request_timeout')); }, REQ_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      const frame = { jsonrpc: '2.0', id, method };
      if (params !== undefined) frame.params = params;
      try { sock.send(JSON.stringify(frame)); }
      catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  function handleMessage(raw) {
    const text = typeof raw === 'string' ? raw
      : Buffer.isBuffer(raw) ? raw.toString('utf8')
      : raw instanceof ArrayBuffer ? Buffer.from(raw).toString('utf8') : '';
    let msg; try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.id != null && pending.has(msg.id)) {          // response to one of our requests
      const p = pending.get(msg.id);
      pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new Error((msg.error && msg.error.message) || 'wl_request_failed'));
      else p.resolve(msg.result);
      bumpIdle();
      return;
    }
    if (typeof msg.method === 'string') applyNotification(msg.method, msg.params || {});
  }

  // ── discovery ──────────────────────────────────────────────────────────────
  function socketFor(host, port, origin) {
    const authority = host.includes(':') ? '[' + host + ']' : host;
    const url = 'ws://' + authority + ':' + port;
    return origin ? new WebSocketImpl(url, { origin }) : new WebSocketImpl(url);
  }

  // Open one endpoint and ask who it is. Resolves { sock, identity }, or rejects
  // so the caller can try the next candidate.
  function probeEndpoint(host, port, origin) {
    return new Promise((resolve, reject) => {
      let sock, settled = false;
      const fail = (e) => { if (settled) return; settled = true; try { sock && sock.close(); } catch (x) {} reject(e || new Error('wl_probe_failed')); };
      try { sock = socketFor(host, port, origin); } catch (e) { reject(e); return; }
      const timer = setTimeout(() => fail(new Error('wl_probe_timeout')), PROBE_TIMEOUT_MS);
      sock.addEventListener('error', () => { clearTimeout(timer); fail(new Error('wl_connect_failed')); });
      sock.addEventListener('message', (ev) => handleMessage(ev.data));
      sock.addEventListener('open', () => {
        rawSend(sock, 'getApplicationInfo').then((info) => {
          clearTimeout(timer);
          if (settled) return;
          const ident = appIdentity(info);
          if (ident.isWaveLink) { settled = true; resolve({ sock, identity: ident }); }
          else fail(new Error('wl_wrong_app'));
        }, () => { clearTimeout(timer); fail(new Error('wl_no_appinfo')); });
      });
    });
  }

  // Which failure is worth reporting: a port that ANSWERED and was rejected says
  // far more than the 20 refused connections around it, and "could not reach
  // Wave Link" is the same sentence for both. Highest rank wins.
  const FAIL_RANK = { wl_connect_failed: 1, wl_probe_timeout: 2, wl_no_appinfo: 3, wl_wrong_app: 4, wl_no_origin: 5 };

  // Wave Link 3 first (it is what a new install gets, and its answer is exact),
  // then the 2.x sweep. Returns { sock, identity }.
  async function findSocket(preferredPort) {
    let bestErr = new Error('wl_not_found');
    let bestRank = 0;
    const note = (e) => {
      const rank = FAIL_RANK[(e && e.message) || ''] || 0;
      if (rank >= bestRank) { bestRank = rank; bestErr = e; }
    };

    const published = await readPublished().catch(() => null);
    if (published && published.port) {
      if (!canSetOrigin) {
        // Saying this out loud matters: without `ws` the 3.x door cannot be
        // opened at all, and every symptom looks like "Wave Link is not running".
        note(new Error('wl_no_origin'));
      } else {
        // 3.x refuses ::1 with HTTP 400 — it is 127.0.0.1 only.
        try { return await probeEndpoint('127.0.0.1', published.port, WL3_ORIGIN); }
        catch (e) { note(e); }
      }
    }

    const ports = [];
    const first = Number(preferredPort) || wlLink.goodPort;
    if (first) ports.push(first);
    for (let i = 0; i < WL_PORT_SPAN; i++) { const p = WL_START_PORT + i; if (!ports.includes(p)) ports.push(p); }
    const hosts = wlLink.goodHost ? [wlLink.goodHost].concat(WL_HOSTS.filter((h) => h !== wlLink.goodHost)) : WL_HOSTS.slice();
    for (const host of hosts) {
      for (const port of ports) {
        try {
          // eslint-disable-next-line no-await-in-loop -- sequential by design: stop at the first live port
          const found = await probeEndpoint(host, port, '');
          wlLink.goodPort = port; wlLink.goodHost = host;
          return found;
        } catch (e) { note(e); }
      }
    }
    throw bestErr;
  }

  return { findSocket };
}

module.exports = { makeSocket };
