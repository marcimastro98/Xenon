'use strict';
// macOS: the route from `route -n get default`, the router and the internet
// through one long-running /sbin/ping each, the provider's hop with the system
// traceroute (BSD ping prints "time exceeded" without a time). Which device is
// Wi-Fi comes from networksetup once per process. The Wi-Fi level and rate are
// null: since macOS 14.4 no unprivileged tool gives them fast enough to read
// every few seconds. Byte counters from netstat, through the collectors' parser.

const { execFile } = require('node:child_process');
const P = require('./parse.js');
const { createPinger } = require('./pinger.js');
const { createSampler } = require('./sampler.js');
const { parseNetstatIb } = require('../darwin-collectors.js');

const INTERNET = '1.1.1.1';
const TRACEROUTE = '/usr/sbin/traceroute';
const RUN_TIMEOUT_MS = 8000;
const HOP_PERIOD_MS = 2000;
const DEAD = Object.freeze({ stop() {}, dead: () => true });

const missing = new Set();
let calls = new AbortController();   // close() ends a command still running
function run(cmd, args) {
  if (missing.has(cmd)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: RUN_TIMEOUT_MS, windowsHide: true, signal: calls.signal, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
      (err, stdout) => {
        if (err && err.code === 'ENOENT') missing.add(cmd);
        resolve(stdout ? String(stdout) : null);
      });
  });
}

let wifiPorts = null;
async function linkOf(iface) {
  if (P.POSIX_TUNNEL.test(iface)) return 'vpn';
  if (!wifiPorts) wifiPorts = P.parseWifiPorts(await run('/usr/sbin/networksetup', ['-listallhardwareports']));
  return wifiPorts.has(iface) ? 'wifi' : 'wired';
}

async function route() {
  const r = P.parseRouteGet(await run('/sbin/route', ['-n', 'get', 'default']));
  if (!r) return null;
  return { iface: r.iface, gateway: r.gateway, link: await linkOf(r.iface) };
}

async function trace(maxTtl) {
  return P.parseTraceroute(await run(TRACEROUTE, ['-n', '-m', String(maxTtl), '-q', '1', '-w', '1', INTERNET]));
}

async function hopMs(ttl) {
  const out = await run(TRACEROUTE, ['-n', '-f', String(ttl), '-m', String(ttl), '-q', '1', '-w', '1', INTERNET]);
  const hop = P.parseTraceroute(out).find((h) => h.ttl === ttl);
  return hop && hop.ip ? hop.ms : null;
}

const ping = createPinger({ command: '/sbin/ping', args: (ip) => ['-n', '-i', '1', ip] });

function watch(target, onSample) {
  if (target.ttl) {
    return missing.has(TRACEROUTE) ? DEAD : createSampler(() => hopMs(target.ttl), onSample, { periodMs: HOP_PERIOD_MS });
  }
  return ping(target.ip, onSample);
}

async function iface(r) {
  const out = await run('netstat', ['-ibn']);
  const row = out ? parseNetstatIb(out).interfaces.find((i) => i.id === r.iface) : null;
  return { linkMbps: null, dbm: null, rx: row ? row.rxBytes : null, tx: row ? row.txBytes : null };
}

const available = () => true;
function close() {
  calls.abort();
  calls = new AbortController();
}

module.exports = { available, route, trace, watch, iface, close };
