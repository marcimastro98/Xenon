'use strict';
// Says whether the Host and Origin a paired device sent name this PC: an IP address the PC
// holds now, or its own HTTPS name, and lists the addresses a device can pair at.

const net = require('node:net');
const os = require('node:os');

/**
 * The Host header must be an IP literal this machine currently owns, on our
 * port. A NAME is always refused: DNS rebinding is an attack on names, so
 * accepting only literals removes the whole class — the same reason
 * ALLOWED_HOSTS lists literals for loopback.
 * @param {string} hostHeader raw Host header
 * @param {string[]} addresses this machine's current non-internal addresses
 * @param {number} port the port we listen on
 */
function isOwnAddressHost(hostHeader, addresses, port) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return false;
  let host = raw;
  let gotPort = '';
  if (raw.startsWith('[')) {                       // [::1]:3030 or [fe80::1]
    const close = raw.indexOf(']');
    if (close < 0) return false;
    host = raw.slice(1, close);
    const rest = raw.slice(close + 1);
    if (rest) {
      if (rest[0] !== ':') return false;
      gotPort = rest.slice(1);
    }
  } else {
    const colon = raw.lastIndexOf(':');
    if (colon >= 0) { host = raw.slice(0, colon); gotPort = raw.slice(colon + 1); }
  }
  if (gotPort && gotPort !== String(port)) return false;
  if (!gotPort) return false;   // the phone always carries the non-default port
  if (!isIpLiteral(host)) return false;
  const list = Array.isArray(addresses) ? addresses : [];
  return list.some((a) => String(a || '').toLowerCase() === host);
}

// An IPv4 dotted quad or an IPv6 literal. net.isIP is the authority — a
// hand-rolled regex here would be the one place a name could slip through as a
// literal, and that is exactly the check DNS rebinding has to beat.
function isIpLiteral(host) {
  return net.isIP(host) !== 0;
}

/**
 * The ONE case where a NAME is an acceptable Host: the HTTPS door (T2), whose
 * certificate is issued for this machine's MagicDNS name and nothing else.
 *
 * This does not weaken the rule above, it states where the rule came from. "Only
 * an IP literal" exists because a NAME can be made to resolve to us by an
 * attacker's DNS server while the browser keeps treating the page as theirs —
 * that is DNS rebinding, and refusing names removes it. On the TLS listener that
 * attack cannot start: the browser will not complete a handshake unless the
 * certificate matches the name it asked for, and the only certificate we hold is
 * the one tailscaled provisions for OUR name. So the accepted value is a single
 * exact string, learned from the local tailscaled and validated as a hostname
 * before it ever gets here — never a suffix, never a pattern. A wildcard here
 * would hand every machine in the tailnet the dashboard.
 */
function isTlsNameHost(hostHeader, fqdn, port) {
  const want = String(fqdn || '').trim().toLowerCase();
  if (!want || isIpLiteral(want)) return false;   // an IP goes through the rule above
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw || raw.startsWith('[')) return false;
  let host = raw;
  let gotPort = '';
  const colon = raw.lastIndexOf(':');
  if (colon >= 0) { host = raw.slice(0, colon); gotPort = raw.slice(colon + 1); }
  // A browser omits the port only when it is the scheme default. Anything else
  // must carry it, exactly as the IP rule requires.
  if (gotPort) { if (gotPort !== String(port)) return false; }
  else if (String(port) !== '443') return false;
  return host === want;
}

/**
 * A remote request's Origin, when present, must be exactly our own origin.
 * `null` is REFUSED here — the loopback path accepts it for the iCUE WebView's
 * opaque origin, and that acceptance must not travel to the LAN, where it would
 * hand a sandboxed iframe on any page the same standing as the dashboard.
 */
function originAllowed(origin, hostHeader, secure) {
  if (origin === undefined || origin === null || origin === '') return true;  // absent = not a browser fetch
  const o = String(origin).trim().toLowerCase();
  if (o === 'null') return false;
  const host = String(hostHeader || '').trim().toLowerCase();
  if (!host) return false;
  // The scheme is part of the identity, and it is the LISTENER's scheme rather
  // than whatever the header claims: an `http://` origin arriving on the TLS
  // door is not our page, and an `https://` one on the cleartext door cannot be.
  return o === (secure === true ? 'https://' : 'http://') + host;
}

/** This machine's non-internal addresses, as strings, IPv4 first. */
function ownAddresses(interfaces) {
  const ifaces = interfaces || os.networkInterfaces();
  const v4 = [];
  const v6 = [];
  for (const list of Object.values(ifaces || {})) {
    for (const ni of (list || [])) {
      if (!ni || ni.internal) continue;
      const fam = typeof ni.family === 'number' ? (ni.family === 4 ? 'IPv4' : 'IPv6') : ni.family;
      const addr = String(ni.address || '').replace(/%.*$/, '');   // drop the zone id
      if (!addr) continue;
      if (fam === 'IPv4') v4.push(addr);
      else if (!addr.toLowerCase().startsWith('fe80')) v6.push(addr);  // link-local is not reachable by URL
    }
  }
  return v4.concat(v6);
}

/**
 * The addresses worth showing the user, best first: a normal private LAN
 * address, then Tailscale's CGNAT range, then anything else routable.
 * A phone on the same Wi-Fi wants the first one.
 */
function pairingAddresses(interfaces) {
  const all = ownAddresses(interfaces).filter((a) => net.isIP(a) === 4);
  const rank = (a) => {
    if (/^192\.168\./.test(a)) return 0;
    if (/^10\./.test(a)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return 1;
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) return 2;  // Tailscale CGNAT
    if (/^169\.254\./.test(a)) return 4;                                // APIPA: no DHCP, rarely useful
    return 3;
  };
  return all.slice().sort((a, b) => rank(a) - rank(b));
}

module.exports = {
  isOwnAddressHost, isIpLiteral, isTlsNameHost, originAllowed, ownAddresses, pairingAddresses,
};
