'use strict';
// Linux: the route and the link from /proc and /sys (no process), the router and
// the internet through one long-running `ping` each, the provider's hop with
// iputils `tracepath`, which times a router's "time exceeded" answer (ping
// prints those without a time). Wi-Fi level from /proc/net/wireless; the
// Wi-Fi rate needs netlink and is left null. A policy-routed tunnel (wg-quick)
// leaves the main table alone and is not seen as a VPN.

const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');
const P = require('./parse.js');
const { createPinger } = require('./pinger.js');
const { createSampler } = require('./sampler.js');
const { parseNetDev } = require('../linux-collectors.js');

const INTERNET = '1.1.1.1';
const TRACE_TIMEOUT_MS = 8000;
const HOP_PERIOD_MS = 2000;
const DEAD = Object.freeze({ stop() {}, dead: () => true });

let tracepathMissing = false;
let calls = new AbortController();   // close() ends a trace still running

const read = (file) => fsp.readFile(file, 'utf8').catch(() => null);
const exists = (file) => fsp.access(file).then(() => true, () => false);

async function linkOf(iface) {
  const dir = `/sys/class/net/${iface}`;
  if (P.POSIX_TUNNEL.test(iface) || await exists(`${dir}/tun_flags`)) return 'vpn';
  if (await exists(`${dir}/wireless`)) return 'wifi';
  const devtype = /DEVTYPE=(\S+)/.exec((await read(`${dir}/uevent`)) || '');
  if (devtype && devtype[1] === 'wireguard') return 'vpn';
  if (devtype && devtype[1] === 'wwan') return 'mobile';
  return 'wired';
}

async function route() {
  const r = P.parseProcRoute(await read('/proc/net/route'));
  if (!r || !/^[\w.:@-]{1,32}$/.test(r.iface)) return null;
  return { iface: r.iface, gateway: r.gateway, link: await linkOf(r.iface) };
}

function trace(maxTtl) {
  if (tracepathMissing) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('tracepath', ['-n', '-m', String(maxTtl), INTERNET],
      { timeout: TRACE_TIMEOUT_MS, windowsHide: true, signal: calls.signal, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
      (err, stdout) => {
        if (err && err.code === 'ENOENT') tracepathMissing = true;
        resolve(P.parseTracepath(stdout));
      });
  });
}

async function hopMs(ttl) {
  const hop = (await trace(ttl)).find((h) => h.ttl === ttl);
  return hop && hop.ip ? hop.ms : null;
}

const ping = createPinger({ command: 'ping', args: (ip) => ['-n', '-O', '-i', '1', '-W', '1', ip] });

// Without tracepath a hop is not measurable, which is not the same as lost.
function watch(target, onSample) {
  if (target.ttl) {
    return tracepathMissing ? DEAD : createSampler(() => hopMs(target.ttl), onSample, { periodMs: HOP_PERIOD_MS });
  }
  return ping(target.ip, onSample);
}

async function iface(r) {
  const [dev, wireless, speed] = await Promise.all([
    read('/proc/net/dev'), r.link === 'wifi' ? read('/proc/net/wireless') : null, read(`/sys/class/net/${r.iface}/speed`),
  ]);
  const row = dev ? parseNetDev(dev).interfaces.find((i) => i.id === r.iface) : null;
  const mbps = Number(String(speed || '').trim());
  return {
    linkMbps: r.link === 'wired' && mbps > 0 ? mbps : null,
    dbm: wireless ? P.parseProcWireless(wireless, r.iface) : null,
    rx: row ? row.rxBytes : null,
    tx: row ? row.txBytes : null,
  };
}

const available = () => true;
function close() {
  calls.abort();
  calls = new AbortController();
}

module.exports = { available, route, trace, watch, iface, close };
