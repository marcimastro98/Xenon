'use strict';
// The Linux network reading in the shape network.ps1 gives: ping to 1.1.1.1 and the bytes of
// each real interface from /proc/net/dev.

const fsp = require('node:fs').promises;
const { parsePingCounts, countsFromFailure } = require('../packet-loss.js');
const { run, splitLines, readText } = require('./linux-read.js');

// --- Network: ping (1.1.1.1) + /proc/net/dev, matching network.ps1 shape -----
// Returns { ping, latency, rxBytes, txBytes, fps, gpuLatency }. server.js turns
// the rx/tx byte counters into down/up bandwidth via its own inter-poll delta.
// Physical NICs only: skip loopback, containers, bridges, tunnels, VPNs.
const VIRTUAL_IFACE = /^(lo|veth|docker|br-|virbr|tun|tap|wg|vmnet|vboxnet|zt|ppp|bond|dummy)/;
// Every interface is RETURNED, not dropped: the totals still sum the physical
// ones only (the Network tile shows those, and adding a VPN would count the same
// traffic twice), but the list carries them all with `kind` so a widget can
// graph a VMnet or a 10GbE NAS link on its own. Asked for on Discord.
// `lo` is the one genuine exception — loopback traffic is the machine talking to
// itself and has no meaning on a bandwidth graph.
function parseNetDev(text) {
  let rx = 0;
  let tx = 0;
  const interfaces = [];
  const lines = splitLines(text).slice(2);
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const iface = line.slice(0, idx).trim();
    if (iface === 'lo') continue;
    const f = line.slice(idx + 1).trim().split(/\s+/);
    if (f.length < 9) continue;
    const irx = Number(f[0]) || 0;   // Receive bytes
    const itx = Number(f[8]) || 0;   // Transmit bytes
    const real = !VIRTUAL_IFACE.test(iface);
    if (real) { rx += irx; tx += itx; }
    // No separate display name on Linux: the kernel's interface name IS what
    // the user sees, so `name` and `id` are the same string rather than a
    // prettier one invented here.
    interfaces.push({ id: iface, name: iface, description: '', kind: real ? 'physical' : 'virtual', rxBytes: irx, txBytes: itx });
  }
  return { rx, tx, interfaces };
}
// operstate and speed live beside the counters in sysfs; both are best-effort
// (a virtual device has no speed, and a down link reports -1).
async function decorateIfaces(interfaces) {
  await Promise.all(interfaces.map(async (n) => {
    try { n.up = (await readText(`/sys/class/net/${n.id}/operstate`)).trim() === 'up'; } catch { n.up = null; }
    try {
      const mbit = Number((await readText(`/sys/class/net/${n.id}/speed`)).trim());
      n.speedBps = Number.isFinite(mbit) && mbit > 0 ? mbit * 1000000 : null;
    } catch { n.speedBps = null; }
  }));
  return interfaces;
}
async function readNetBytes() {
  try {
    const out = parseNetDev(await fsp.readFile('/proc/net/dev', 'utf8'));
    await decorateIfaces(out.interfaces);
    return out;
  } catch {
    return { rx: 0, tx: 0, interfaces: [] };
  }
}
// ping's summary line gives min/avg/max/mdev; ping=avg, latency=jitter (max-min),
// the same two numbers network.ps1 derives from its three echoes.
const PING_ECHOES = 3;
function parsePing(out) {
  const m = String(out || '').match(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\s*ms/);
  if (!m) return { ping: null, latency: null };
  return { ping: Math.round(Number(m[2])), latency: Math.round(Number(m[3]) - Number(m[1])) };
}
async function pingStats() {
  try {
    const out = await run('ping', ['-c', String(PING_ECHOES), '-W', '1', '-n', '1.1.1.1'], 5000);
    return { ...parsePing(out), counts: parsePingCounts(out) };
  } catch (err) {
    return { ping: null, latency: null, counts: countsFromFailure(err, PING_ECHOES) };
  }
}
async function network() {
  const [{ ping, latency, counts }, { rx, tx, interfaces }] = await Promise.all([pingStats(), readNetBytes()]);
  return { ping, latency, pingSent: counts ? counts.sent : 0, pingLost: counts ? counts.lost : 0, rxBytes: rx, txBytes: tx, interfaces, fps: null, gpuLatency: null };
}

module.exports = {
  VIRTUAL_IFACE, parseNetDev, decorateIfaces, readNetBytes, PING_ECHOES, parsePing, pingStats,
  network,
};
