'use strict';
// Pure readers for net-path: addresses, the default route, Wi-Fi level and the
// lines `ping` prints. Every OS backend parses through here, so the tests cover
// all three on any machine. Addresses stay inside the server: nothing here is
// ever sent to a widget.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(s) {
  const m = IPV4.exec(String(s || ''));
  return !!m && m.slice(1).every((p) => Number(p) <= 255);
}

// IPAddr as Windows takes it: the four bytes in network order, read as a
// little-endian 32-bit number.
function ipv4ToInt(ip) {
  if (!isIpv4(ip)) return null;
  const [a, b, c, d] = ip.split('.').map(Number);
  return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
}

function intToIpv4(n) {
  const v = Number(n) >>> 0;
  return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24].join('.');
}

// RFC 1918 space. A hop in it past the gateway may still be at home (a second
// router: double NAT) or already the provider's (many number their first hops
// privately), so index.js decides with the delay as well, never the address alone.
// 100.64/10 (CGNAT) is the provider's by definition and is not here.
function isPrivateV4(ip) {
  if (!isIpv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

// Never a hop on the way out: loopback and link-local.
function isLocalOnly(ip) {
  if (!isIpv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 127 || (a === 169 && b === 254);
}

// /proc/net/route: the default route (destination and mask 0) that is up and
// goes through a gateway, the lowest metric first. Addresses are little-endian hex.
function parseProcRoute(text) {
  let best = null;
  for (const line of String(text || '').split(/\r?\n/).slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || f[1] !== '00000000' || f[7] !== '00000000') continue;
    const flags = parseInt(f[3], 16);
    if (!(flags & 0x1) || !(flags & 0x2)) continue;
    const metric = Number(f[6]) || 0;
    if (best && best.metric <= metric) continue;
    best = { iface: f[0], gateway: intToIpv4(parseInt(f[2], 16)), metric };
  }
  return best ? { iface: best.iface, gateway: best.gateway } : null;
}

// /proc/net/wireless: "wlan0: 0000   54.  -56.  -256 ...". The level is dBm;
// old wireless-extensions drivers print it as an unsigned byte (200 = -56).
function parseProcWireless(text, iface) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0 || line.slice(0, idx).trim() !== iface) continue;
    const f = line.slice(idx + 1).trim().split(/\s+/);
    let level = parseFloat(f[2]);
    if (!Number.isFinite(level)) return null;
    if (level > 0) level -= 256;
    return level >= -110 && level < 0 ? Math.round(level) : null;
  }
  return null;
}

// The same 0-100 Windows shows for a signal: -100 dBm is 0, -50 dBm and up is 100.
function dbmToSignal(dbm) {
  if (!Number.isFinite(dbm)) return null;
  return Math.max(0, Math.min(100, Math.round(2 * (dbm + 100))));
}

// One line of a running `ping` (iputils or BSD, LC_ALL=C):
//   "64 bytes from 1.1.1.1: icmp_seq=3 ttl=57 time=12.3 ms" -> { seq: 3, ms: 12.3 }
//   "no answer yet for icmp_seq=4" (iputils -O)              -> { seq: 4, lost: true }
//   "Request timeout for icmp_seq 4" (BSD)                   -> { seq: 4, lost: true }
// A duplicate or an ICMP error for our echo is not an answer.
function parsePingLine(line) {
  const s = String(line || '');
  const seqMatch = /icmp_seq[= ](\d+)/.exec(s);
  if (!seqMatch) return null;
  const seq = Number(seqMatch[1]);
  if (/no answer yet|Request timeout/i.test(s)) return { seq, lost: true };
  if (/DUP!/.test(s)) return null;
  const t = /time[=<]\s*([\d.]+)\s*ms/.exec(s);
  if (!t) return /exceeded|unreachable/i.test(s) ? { seq, lost: true } : null;
  return { seq, ms: Number(t[1]) };
}

// iputils `tracepath -n`: " 2:  172.16.0.1   3.155ms asymm  3", " 3:  no reply".
// A hop can print twice (the path MTU changed); the faster answer is kept.
function parseTracepath(out) {
  const hops = new Map();
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\??:\s+(\S+)(?:\s+([\d.]+)ms)?/.exec(line);
    if (!m || m[2] === '[LOCALHOST]') continue;
    addHop(hops, Number(m[1]), isIpv4(m[2]) ? m[2] : null, m[3] != null ? Number(m[3]) : null);
  }
  return [...hops.values()].sort((a, b) => a.ttl - b.ttl);
}

// BSD `traceroute -n -q 1`: " 2  172.16.0.1  3.155 ms", " 3  *".
function parseTraceroute(out) {
  const hops = new Map();
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(?:(\d{1,3}(?:\.\d{1,3}){3})\s+([\d.]+)\s*ms|\*)/.exec(line);
    if (m) addHop(hops, Number(m[1]), m[2] && isIpv4(m[2]) ? m[2] : null, m[3] != null ? Number(m[3]) : null);
  }
  return [...hops.values()].sort((a, b) => a.ttl - b.ttl);
}

function addHop(hops, ttl, ip, ms) {
  const prev = hops.get(ttl);
  const hop = { ttl, ip, ms: ip ? ms : null };
  if (!prev || (!prev.ip && ip)) hops.set(ttl, hop);
  else if (ip === prev.ip && ms != null && (prev.ms == null || ms < prev.ms)) prev.ms = ms;
}

// macOS `route -n get default`.
function parseRouteGet(out) {
  const gw = /^\s*gateway:\s*(\S+)/m.exec(String(out || ''));
  const ifc = /^\s*interface:\s*(\S+)/m.exec(String(out || ''));
  if (!ifc) return null;
  return { iface: ifc[1], gateway: gw && isIpv4(gw[1]) ? gw[1] : null };
}

// macOS `networksetup -listallhardwareports`: the device names of the Wi-Fi ports.
function parseWifiPorts(out) {
  const names = new Set();
  const blocks = String(out || '').split(/\r?\n\s*\r?\n/);
  for (const b of blocks) {
    const port = /Hardware Port:\s*(.+)/.exec(b);
    const dev = /Device:\s*(\S+)/.exec(b);
    if (port && dev && /^(Wi-Fi|AirPort)$/i.test(port[1].trim())) names.add(dev[1]);
  }
  return names;
}

// Windows IFTYPE of the interface the default route uses.
function linkFromIfType(type) {
  if (type === 71) return 'wifi';
  if (type === 243 || type === 244) return 'mobile';
  if (type === 53 || type === 131 || type === 23) return 'vpn';
  return 'wired';
}

// BSD/macOS device names that are tunnels.
const POSIX_TUNNEL = /^(utun|tun|tap|wg|ipsec|ppp|gpd|zt|tailscale)/;

module.exports = {
  isIpv4, ipv4ToInt, intToIpv4, isPrivateV4, isLocalOnly,
  parseProcRoute, parseProcWireless, dbmToSignal,
  parsePingLine, parseTracepath, parseTraceroute, parseRouteGet, parseWifiPorts,
  linkFromIfType, POSIX_TUNNEL,
};
