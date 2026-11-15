'use strict';
// On-demand LAN discovery for external lighting devices. There is NO background
// scanning: a sweep runs only when the user presses "Search". It is a bounded,
// short-timeout probe of the local /24 subnet(s) — no dependencies, no raw mDNS.

const os = require('os');

// Local IPv4 /24 prefixes from non-internal interfaces (e.g. "192.168.1").
function localSubnets() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal && ni.address) {
        const parts = ni.address.split('.');
        if (parts.length === 4) {
          const prefix = parts.slice(0, 3).join('.');
          if (!out.includes(prefix)) out.push(prefix);
        }
      }
    }
  }
  return out;
}

// This machine's own non-internal IPv4 addresses — skipped during the sweep since
// 127.0.0.1 already covers local services (avoids a 0.0.0.0-bound server, e.g.
// OpenRGB, being found twice: once on localhost and once on its LAN IP).
function localIPv4s() {
  const out = new Set();
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal && ni.address) out.add(ni.address);
    }
  }
  return out;
}

// Run `fn` over `items` with at most `limit` in flight at once.
async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

// Sweep every local /24 subnet, probing each host against each provider. A host
// is claimed by the first provider whose probe matches. Returns a map
// providerId → [device descriptors] (deduped by id).
// `providers`: [{ id, probe(host) }].
async function sweep(providers, opts) {
  const concurrency = (opts && opts.concurrency) || 64;
  const subnets = localSubnets();
  const self = localIPv4s();   // skip our own IPs — 127.0.0.1 already covers local
  const hosts = ['127.0.0.1']; // local services (e.g. OpenRGB usually binds to localhost)
  for (const prefix of subnets) for (let n = 1; n <= 254; n++) {
    const ip = `${prefix}.${n}`;
    if (!self.has(ip)) hosts.push(ip);
  }

  const byProvider = {};
  for (const p of providers) byProvider[p.id] = [];
  if (!hosts.length) return byProvider;

  await mapLimit(hosts, concurrency, async (host) => {
    for (const p of providers) {
      let dev = null;
      try { dev = await p.probe(host); } catch { dev = null; }
      if (dev) { byProvider[p.id].push(dev); break; } // host claimed
    }
  });

  for (const id of Object.keys(byProvider)) {
    const seen = new Set();
    byProvider[id] = byProvider[id].filter(d => !seen.has(d.id) && seen.add(d.id));
  }
  return byProvider;
}

module.exports = { sweep, localSubnets };
