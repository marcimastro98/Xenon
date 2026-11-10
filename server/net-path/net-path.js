'use strict';
// net-path: how the way from this PC to the internet is doing, stretch by
// stretch, for the SDK `netPath` stream.
//   read() → { ok, link, linkMbps, signal, dbm, router, provider, internet, traffic }
//     link      'wifi' | 'wired' | 'mobile' | 'vpn' | null (the default route's interface)
//     signal    Wi-Fi level 0-100, dbm the same in dBm (Wi-Fi only, null where the OS hides it)
//     router / provider / internet   stats.js numbers, or null when not measurable here
//     traffic   { downBps, upBps }: this PC's bytes per second on that interface
// Addresses never leave this module.
//
// Nothing runs before a read. The first one finds the default route and starts
// one echo a second per stretch (the provider's hop is looked for in the
// background); IDLE_MS after the last read everything stops. The backend for
// this OS comes from index.js, the only place that picks one.
//
// The provider's first hop is the first hop past the gateway that is not still
// at home. A private address alone does not decide it: many providers number
// their own first hops privately, so a private hop counts as home only when it
// adds less than HOME_HOP_MS to the gateway's delay (a second router on the LAN).

const S = require('./stats.js');
const P = require('./parse.js');

const INTERNET = '1.1.1.1';                 // the backends trace toward it
const INTERNET_TARGETS = Object.freeze([INTERNET, '8.8.8.8']);
const ROLES = Object.freeze(['router', 'provider', 'internet']);
const IDLE_MS = 10000;
const ROUTE_CHECK_MS = 30000;
const ROUTE_RETRY_MS = 5000;                // no route, or the internet is losing echoes
const TRACE_EVERY_MS = 600000;
const TRACE_RETRY_MS = 60000;               // the last trace found no provider's hop
const MAX_TTL = 5;
const HOME_HOP_MS = 1.5;
const SILENT_AFTER = 10;
const STALE_MS = 10000;
const REVIVE_MS = 5000;                     // a watcher that died comes back at most this often
const IFACE_TTL_MS = 2000;
const TROUBLE_LOSS = 50;

function pickProvider(hops, gateway, skip = new Set()) {
  const first = hops.find((h) => h.ttl === 1 && h.ip && h.ms != null);
  const base = first ? first.ms : 0;
  for (const h of hops) {
    if (h.ttl < 2 || !h.ip || h.ip === gateway || P.isLocalOnly(h.ip) || skip.has(h.ip)) continue;
    if (h.ip === INTERNET) return null;
    if (P.isPrivateV4(h.ip) && h.ms != null && h.ms - base <= HOME_HOP_MS) continue;
    return { ip: h.ip, ttl: h.ttl };
  }
  return null;
}

function trafficBetween(prev, next, iface) {
  if (!prev || !next || prev.iface !== iface || !(next.at > prev.at)) return null;
  if (next.rx == null || next.tx == null || prev.rx == null || prev.tx == null) return null;
  const dt = (next.at - prev.at) / 1000;
  const down = next.rx - prev.rx;
  const up = next.tx - prev.tx;
  return down >= 0 && up >= 0 ? { downBps: Math.round(down / dt), upBps: Math.round(up / dt) } : null;
}

const same = (a, b) => !!a && !!b && a.ip === b.ip && (a.ttl || 0) === (b.ttl || 0);

function createNetPath(backend, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const targets = { router: null, provider: null, internet: null };
  const quiet = new Set();          // provider's hops that stopped answering their echoes
  let routerVia = 'echo';           // 'echo', then 'ttl' (time exceeded at TTL 1), then 'none'
  let internetIdx = 0;
  let active = false;
  let stopped = false;
  let route = null;
  let routeAt = -Infinity;
  let traceAt = -Infinity;
  let routing = null;
  let tracing = null;
  let idleTimer = null;
  let ifc = null;
  let ifcPending = null;
  let counters = null;

  const available = () => {
    try { return !!(backend && backend.available()); } catch { return false; }
  };

  // `prev` is the entry a revived watcher carries on: same numbers, same age.
  function setTarget(role, target, prev = null) {
    const cur = targets[role];
    if (cur && same(cur.target, target) && !cur.watcher.dead()) return;
    if (cur) cur.watcher.stop();
    targets[role] = null;
    if (!target) return;
    const entry = {
      target,
      win: prev ? prev.win : S.createWindow(),
      lastAt: prev ? prev.lastAt : now(),
      heard: prev ? prev.heard : false,
      bornAt: now(),
      watcher: null,
    };
    try {
      entry.watcher = backend.watch(target, (ms) => {
        if (targets[role] !== entry) return;   // a late answer for a watcher already replaced
        entry.win.add(ms);
        entry.lastAt = now();
        if (ms != null) entry.heard = true;
      });
    } catch {
      return;
    }
    targets[role] = entry;
  }

  function routerTarget(gateway) {
    if (routerVia === 'echo') return { ip: gateway };
    return routerVia === 'ttl' ? { ip: gateway, ttl: 1 } : null;
  }

  function findProvider(gateway) {
    if (tracing) return;
    traceAt = now();
    tracing = (async () => {
      let hops = [];
      try { hops = await backend.trace(MAX_TTL); } catch { hops = []; }
      if (!active || !route || route.gateway !== gateway) return;
      const found = pickProvider(hops, gateway, quiet);
      setTarget('provider', found);
      if (!found) traceAt = now() - TRACE_EVERY_MS + TRACE_RETRY_MS;
    })().catch(() => {}).finally(() => { tracing = null; });
  }

  // A new route is a new path: what was learnt about the old one goes.
  function forget() {
    setTarget('router', null);
    setTarget('provider', null);
    quiet.clear();
    routerVia = 'echo';
    traceAt = -Infinity;
    counters = null;
    ifc = null;
  }

  async function refreshRoute() {
    routeAt = now();
    let r = null;
    try { r = await backend.route(); } catch { r = null; }
    if (!active) return;
    if (!route || !r || r.gateway !== route.gateway || r.iface !== route.iface || r.link !== route.link) forget();
    route = r;
    setTarget('internet', { ip: INTERNET_TARGETS[internetIdx] });
    // Behind a tunnel the hops are the tunnel's: only the far end means anything.
    if (!r || !r.gateway || r.link === 'vpn') return;
    if (!targets.router) setTarget('router', routerTarget(r.gateway));
    if (now() - traceAt >= TRACE_EVERY_MS) findProvider(r.gateway);
  }

  const isSilent = (e) => !!e && e.win.count() >= SILENT_AFTER && !e.win.answered();
  const answering = (e) => !!e && e.win.count() > 0 && e.win.summary().lossNow < 100;

  // A hop that never answers while the internet does (an answer among its newest
  // echoes) is not measurable, which is not the same as 100% lost: the router
  // gets a second way in (TTL 1), the provider's hop gives way to the next one.
  // With the internet silent too nothing is decided: that may be an outage.
  function settleSilent() {
    const net = targets.internet;
    if (!net) return;
    if (!net.heard && net.win.count() >= SILENT_AFTER) {
      // 1.1.1.1 does not answer on a few networks that are otherwise fine; a
      // target that ever answered is kept, so a real outage shows as loss.
      internetIdx = (internetIdx + 1) % INTERNET_TARGETS.length;
      setTarget('internet', { ip: INTERNET_TARGETS[internetIdx] });
      return;
    }
    if (!answering(net) || !route || !route.gateway) return;
    if (isSilent(targets.router)) {
      routerVia = routerVia === 'echo' ? 'ttl' : 'none';
      setTarget('router', routerTarget(route.gateway));
    }
    if (isSilent(targets.provider)) {
      quiet.add(targets.provider.target.ip);
      setTarget('provider', null);
      findProvider(route.gateway);
    }
  }

  // A ping child that exited comes back with its numbers, never more often than
  // REVIVE_MS: a ping that fails at once must not become a spawn a second.
  function revive() {
    for (const role of ROLES) {
      const e = targets[role];
      if (e && e.watcher.dead() && now() - e.bornAt >= REVIVE_MS) setTarget(role, e.target, e);
    }
  }

  function stretch(role) {
    const e = targets[role];
    if (!e || e.win.count() === 0 || now() - e.lastAt > STALE_MS) return null;
    return e.win.summary();
  }

  function refreshIface() {
    if (!route) return null;
    if (ifcPending) return ifcPending;
    const r = route;
    ifcPending = (async () => {
      let v = null;
      try { v = await backend.iface(r); } catch { v = null; }
      if (!active || !route || route.iface !== r.iface) return;
      const at = now();
      const next = v ? { iface: r.iface, rx: v.rx, tx: v.tx, at } : null;
      const traffic = trafficBetween(counters, next, r.iface);
      ifc = { at, value: v ? { linkMbps: v.linkMbps ?? null, dbm: v.dbm ?? null, traffic } : null };
      if (next) counters = next;
    })().catch(() => {}).finally(() => { ifcPending = null; });
    return ifcPending;
  }

  // Only the first read waits for the interface; later ones answer from the last
  // reading and refresh it behind, so an echo waiting in the queue never delays a reply.
  async function ifaceInfo() {
    if (!ifc) await refreshIface();
    else if (now() - ifc.at >= IFACE_TTL_MS) refreshIface();
    return ifc ? ifc.value : null;
  }

  function troubled() {
    const e = targets.internet;
    return !!e && e.win.count() >= SILENT_AFTER && e.win.summary().lossNow >= TROUBLE_LOSS;
  }

  function sleep() {
    active = false;
    forget();
    setTarget('internet', null);
    internetIdx = 0;
    route = null;
    routeAt = -Infinity;
  }

  function armIdle() {
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = setTimer(() => { idleTimer = null; sleep(); }, IDLE_MS);
    if (idleTimer && typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  function shape(link) {
    const wifi = !!route && route.link === 'wifi' && !!link && link.dbm != null;
    return {
      ok: true,
      link: route ? route.link : null,
      linkMbps: link ? link.linkMbps : null,
      signal: wifi ? P.dbmToSignal(link.dbm) : null,
      dbm: wifi ? link.dbm : null,
      router: stretch('router'),
      provider: stretch('provider'),
      internet: stretch('internet'),
      traffic: link ? link.traffic : null,
    };
  }

  async function read() {
    if (stopped || !available()) return { ok: false, error: 'unavailable' };
    active = true;
    armIdle();
    const due = !route || troubled() ? ROUTE_RETRY_MS : ROUTE_CHECK_MS;
    if (!routing && now() - routeAt >= due) {
      routing = refreshRoute().catch(() => {}).finally(() => { routing = null; });
    }
    // The first read waits for the route (one quick read), never for the trace.
    if (!route && routing) await routing;
    revive();
    settleSilent();
    return shape(await ifaceInfo());
  }

  function stop() {
    stopped = true;
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = null;
    sleep();
    try { if (backend && backend.close) backend.close(); } catch { /* best effort at shutdown */ }
  }

  return { available, read, stop, running: () => active };
}

module.exports = {
  createNetPath, pickProvider, trafficBetween,
  INTERNET_TARGETS, IDLE_MS, ROUTE_CHECK_MS, ROUTE_RETRY_MS, SILENT_AFTER, STALE_MS, REVIVE_MS, HOME_HOP_MS,
};
