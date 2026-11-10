'use strict';
// Outbound-request address guard (SSRF). Shared by every module that fetches a
// URL someone other than the code author chose: a custom news feed, an iCal
// link, a browser's Web Push endpoint.
//
// Two halves, because neither is enough on its own:
//   - assertPublicUrl() checks the URL before connecting. Node never calls a
//     custom `lookup` for an IP-literal host (https://127.0.0.1/ connects
//     straight away), so the literal has to be judged here.
//   - publicLookup() is the dns.lookup hook handed to http(s).request. It sees
//     what a public-looking NAME actually resolves to, which defeats DNS
//     rebinding (evil.example → 192.168.1.1) at connect time.
// Both answer the same question through isPublicAddress().

const dns = require('dns');
const net = require('net');

// ── address classification ───────────────────────────────────────────────────

// Dotted IPv4 → 32-bit unsigned int, or null.
function v4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = +p;
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function intToV4(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

// [base, prefixLength] ranges that are not the public internet. Covers the
// "this host", private, CGNAT, loopback, link-local, protocol-assignment,
// documentation, benchmark, multicast, reserved and broadcast blocks.
const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, len]) => [v4ToInt(base), len]);

function isPublicV4(ip) {
  const n = v4ToInt(ip);
  if (n == null) return false;
  for (const [base, len] of V4_BLOCKED) {
    const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
    if (((n & mask) >>> 0) === base) return false;
  }
  return true;
}

// Expand any valid IPv6 spelling (compressed, with a dotted IPv4 tail) into
// eight 16-bit numbers. Returns null when it is not IPv6.
function v6ToHextets(ip) {
  let s = String(ip);
  if (!net.isIPv6(s)) return null;
  // A dotted IPv4 tail ("::ffff:1.2.3.4") becomes two hextets.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const n = v4ToInt(tail[1]);
    if (n == null) return null;
    s = s.slice(0, tail.index) + ((n >>> 16).toString(16)) + ':' + ((n & 0xffff).toString(16));
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const all = [...head, ...new Array(fill).fill('0'), ...rest];
  if (all.length !== 8) return null;
  return all.map(h => parseInt(h, 16));
}

// The IPv4 address an IPv6 address carries inside it, for the forms that
// route to that IPv4 host: IPv4-mapped (::ffff:a.b.c.d, any spelling), SIIT
// (::ffff:0:a.b.c.d), deprecated IPv4-compatible (::a.b.c.d), NAT64
// (64:ff9b::/96) and 6to4 (2002:AABB:CCDD::/48). Returns dotted v4 or null.
function embeddedIPv4(ip) {
  const h = v6ToHextets(ip);
  if (!h) return null;
  const low = intToV4(((h[6] << 16) | h[7]) >>> 0);
  const zeros = (from, to) => h.slice(from, to).every(x => x === 0);
  if (zeros(0, 5) && h[5] === 0xffff) return low;                    // ::ffff:v4
  if (zeros(0, 4) && h[4] === 0xffff && h[5] === 0) return low;      // ::ffff:0:v4
  if (zeros(0, 6) && (h[6] !== 0 || h[7] > 1)) return low;           // ::v4 (not :: or ::1)
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return low;   // NAT64 well-known prefix
  if (h[0] === 0x2002) return intToV4(((h[1] << 16) | h[2]) >>> 0);  // 6to4
  return null;
}

function isPublicV6(ip) {
  const h = v6ToHextets(ip);
  if (!h) return false;
  if (h.every(x => x === 0)) return false;                           // ::
  if (h.slice(0, 7).every(x => x === 0) && h[7] === 1) return false; // ::1
  const v4 = embeddedIPv4(ip);
  if (v4 != null) return isPublicV4(v4);
  const first = h[0];
  if ((first & 0xffc0) === 0xfe80) return false;   // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return false;   // fec0::/10 site-local (deprecated)
  if ((first & 0xfe00) === 0xfc00) return false;   // fc00::/7 unique local
  if ((first & 0xff00) === 0xff00) return false;   // ff00::/8 multicast
  if (h[0] === 0x64 && h[1] === 0xff9b) return false; // 64:ff9b:1::/48 local-use NAT64
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return false; // 100::/64 discard
  if (h[0] === 0x2001 && h[1] === 0) return false; // 2001::/32 Teredo (hides the real v4 target)
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false; // documentation
  if (h.slice(0, 5).every(x => x === 0)) return false; // any other ::/80 oddity (::ffff:… handled above)
  return true;
}

// True only for a unicast address on the public internet. Anything that is
// not a parseable IP, or that lands on this machine, the LAN, a carrier NAT,
// a multicast group or a reserved block, is refused.
function isPublicAddress(ip) {
  let s = String(ip == null ? '' : ip).trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');                     // fe80::1%eth0 → scoped, never public
  if (zone !== -1) return false;
  const kind = net.isIP(s);
  if (kind === 4) return isPublicV4(s);
  if (kind === 6) return isPublicV6(s);
  return false;
}

// ── URL check ────────────────────────────────────────────────────────────────

function blocked(message) {
  const e = new Error(message);
  e.code = 'EBLOCKED';
  return e;
}

// Names that resolve to this machine or the local network by convention,
// whatever DNS says. Trailing dots ("localhost.") are stripped first because
// they name the same host.
function isLocalName(host) {
  return host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa');
}

// Throws (code EBLOCKED) unless `urlString` is an https URL whose host is a
// public name or a public IP literal; returns the parsed URL. `allowHttp`
// widens the scheme check for callers that genuinely need plain http.
function assertPublicUrl(urlString, opts) {
  const allowHttp = !!(opts && opts.allowHttp);
  let u;
  try { u = new URL(String(urlString || '')); } catch { throw blocked('invalid url'); }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw blocked('scheme not allowed');
  let host = u.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.+$/, '');
  if (!host) throw blocked('missing host');
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw blocked('blocked address');
    return u;
  }
  if (isLocalName(host)) throw blocked('blocked host');
  return u;
}

function isPublicUrl(urlString, opts) {
  try { assertPublicUrl(urlString, opts); return true; } catch { return false; }
}

// ── connect-time DNS hook ────────────────────────────────────────────────────

// dns.lookup replacement for http(s).request({ lookup }). Resolves every
// address, keeps only public ones, and fails the request (EBLOCKED) when none
// survive. Honours `all: true` (Node's happy-eyeballs path asks for it).
function publicLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const opts = typeof options === 'number' ? { family: options } : (options || {});
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const safe = (addresses || []).filter(a => isPublicAddress(a.address));
    if (!safe.length) return callback(blocked('blocked address'));
    if (opts.all) return callback(null, safe);
    callback(null, safe[0].address, safe[0].family);
  });
}

// ── whole-request deadline ───────────────────────────────────────────────────

// The `timeout` option of http(s).get is an IDLE timeout: it only fires after
// the socket goes quiet. A server that trickles a byte every few seconds keeps
// the request alive indefinitely. This destroys `req` once `ms` have passed in
// total, and disarms itself when the request closes normally.
function armDeadline(req, ms) {
  const timer = setTimeout(() => req.destroy(new Error('timeout')), ms);
  if (timer.unref) timer.unref();
  const clear = () => clearTimeout(timer);
  req.once('close', clear);
  return clear;
}

// ── the home network ─────────────────────────────────────────────────────────

// Feeds the USER configured (a calendar or a news feed) may live on the home
// network: a Nextcloud or FreshRSS at 192.168.x.x, a NAS reached over
// Tailscale (100.64/10), an IPv6 ULA. Those are allowed for them. What is never
// allowed is this machine itself (loopback, where Xenon and other local
// services listen), link-local (cloud metadata, router admin by MAC-derived
// addresses), unspecified, multicast and reserved space.
function isLanAddress(ip) {
  let s = String(ip == null ? '' : ip).trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.indexOf('%') !== -1) return false;
  const kind = net.isIP(s);
  let v4 = kind === 4 ? s : (kind === 6 ? embeddedIPv4(s) : null);
  if (v4) {
    const n = v4ToInt(v4);
    if (n == null) return false;
    const inNet = (base, bits) => ((n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
    return inNet('10.0.0.0', 8) || inNet('172.16.0.0', 12) || inNet('192.168.0.0', 16) || inNet('100.64.0.0', 10);
  }
  if (kind === 6) return /^f[cd][0-9a-f]{0,2}:/.test(s);   // fc00::/7 unique local
  return false;
}
function isPublicOrLanAddress(ip) { return isPublicAddress(ip) || isLanAddress(ip); }

// assertPublicUrl, widened to the home network (see isLanAddress). Names that
// mean "this machine" (localhost) stay refused; .local/.home.arpa/.internal
// are home-network names and pass, the connect-time lookup still checks them.
function assertPublicOrLanUrl(urlString, opts) {
  const allowHttp = !!(opts && opts.allowHttp);
  let u;
  try { u = new URL(String(urlString || '')); } catch { throw blocked('invalid url'); }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw blocked('scheme not allowed');
  let host = u.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.+$/, '');
  if (!host) throw blocked('missing host');
  if (net.isIP(host)) {
    if (!isPublicOrLanAddress(host)) throw blocked('blocked address');
    return u;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) throw blocked('blocked host');
  return u;
}

function publicOrLanLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const opts = typeof options === 'number' ? { family: options } : (options || {});
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const safe = (addresses || []).filter(a => isPublicOrLanAddress(a.address));
    if (!safe.length) return callback(blocked('blocked address'));
    if (opts.all) return callback(null, safe);
    callback(null, safe[0].address, safe[0].family);
  });
}

module.exports = {
  isPublicAddress, assertPublicUrl, isPublicUrl, publicLookup, embeddedIPv4, armDeadline,
  isLanAddress, isPublicOrLanAddress, assertPublicOrLanUrl, publicOrLanLookup,
};
