'use strict';
// The macOS network reading in the shape network.ps1 gives: ping and the bytes of each real
// interface from netstat.

const { parsePingCounts, countsFromFailure } = require('../packet-loss.js');
const { run, runSoft, splitLines } = require('./darwin-read.js');

// --- Network: ping + netstat -ib, matching network.ps1's shape --------------
// server.js turns the rx/tx byte counters into down/up bandwidth via its own
// inter-poll delta, so all that is owed here is a pair of monotonic counters.
//
// BSD ping prints the same "min/avg/max/stddev = a/b/c/d ms" summary iputils
// does, so this parser is deliberately the twin of the Linux one.
const PING_ECHOES = 3;
function parsePing(out) {
  const m = String(out || '').match(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\s*ms/);
  if (!m) return { ping: null, latency: null };
  return { ping: Math.round(Number(m[2])), latency: Math.round(Number(m[3]) - Number(m[1])) };
}

async function pingStats() {
  try {
    // macOS ping takes -t (total timeout in seconds); -W is per-packet on Linux.
    const out = await run('/sbin/ping', ['-c', String(PING_ECHOES), '-t', '5', '-n', '1.1.1.1'], 8000);
    return { ...parsePing(out), counts: parsePingCounts(out) };
  } catch (err) {
    return { ping: null, latency: null, counts: countsFromFailure(err, PING_ECHOES) };
  }
}

// Physical interfaces only. Skipping the virtual ones is not just hygiene: the
// <Link#n> row of an interface without a hardware address (lo0, utun) has one
// fewer column, so counting them would read the wrong field entirely.
const VIRTUAL_IFACE = /^(lo|gif|stf|utun|bridge|awdl|llw|ap\d|anpi|vmenet|vnic|p2p|XHC)/;

// `netstat -ib` columns for a link row:
// Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
// Every interface is RETURNED, not dropped: the totals still sum the physical
// ones only (the Network tile shows those, and adding a VPN would count the same
// traffic twice), but the list carries them all with `kind` so a widget can
// graph one link on its own. Asked for on Discord. `lo0` is the one genuine
// exception — loopback is the machine talking to itself.
function parseNetstatIb(out) {
  let rx = 0;
  let tx = 0;
  const seen = new Set();
  const interfaces = [];
  for (const line of splitLines(out)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const iface = f[0];
    // One row per address family; the <Link#n> row alone carries the totals.
    if (!/^<Link#\d+>$/.test(f[2])) continue;
    if (/^lo\d*$/.test(iface)) continue;
    if (seen.has(iface)) continue;
    seen.add(iface);
    // A link row without a hardware address (utun, llw) has no Address column,
    // so its byte counters sit one field to the left.
    const at = f.length >= 11 ? 0 : -1;
    const irx = Number(f[6 + at]) || 0;
    const itx = Number(f[9 + at]) || 0;
    const real = !VIRTUAL_IFACE.test(iface);
    if (real) { rx += irx; tx += itx; }
    // macOS has a friendly name per service ("Wi-Fi", "Thunderbolt Ethernet"),
    // but it lives in networksetup, a separate process spawn per poll. The BSD
    // device name is what netstat gives and it is stable, so that is `name` too
    // rather than paying for a nicer one every three seconds.
    interfaces.push({ id: iface, name: iface, description: '', kind: real ? 'physical' : 'virtual', rxBytes: irx, txBytes: itx });
  }
  return { rx, tx, interfaces };
}

async function readNetBytes() {
  // -n: without it netstat reverse-resolves every address row, which can take
  // longer than the timeout on a busy LAN and leave the tile at 0 B/s (GitHub
  // #138). The <Link#n> rows parsed below are the same either way.
  const out = await runSoft('netstat', ['-ibn'], 5000);
  return out === null ? { rx: 0, tx: 0, interfaces: [] } : parseNetstatIb(out);
}

async function network() {
  const [{ ping, latency, counts }, { rx, tx, interfaces }] = await Promise.all([pingStats(), readNetBytes()]);
  return { ping, latency, pingSent: counts ? counts.sent : 0, pingLost: counts ? counts.lost : 0, rxBytes: rx, txBytes: tx, interfaces, fps: null, gpuLatency: null };
}

module.exports = {
  PING_ECHOES, parsePing, pingStats, VIRTUAL_IFACE, parseNetstatIb, readNetBytes, network,
};
