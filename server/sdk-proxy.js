'use strict';
// SDK fetch proxy executor — the hardened outbound HTTP client behind
// POST /sdk/fetch. The request has already been validated against the package
// manifest by sdk-widgets.validateProxyRequest(); this module's job is the
// wire-level half: even a hostname that PASSED the allowlist must not be
// allowed to RESOLVE to loopback/link-local (DNS rebinding would otherwise
// tunnel a widget back to the local API the CSP kill-switch exists to block).
// Mirrors the hardened-fetch shape of news.js/stocks.js: timeout, streaming
// size cap, no redirect following (the status + location header are returned
// so the widget can decide).

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const PROXY_TIMEOUT_MS = 10000;
const PROXY_MAX_RESPONSE_BYTES = 1024 * 1024;

// Addresses a proxied request may never CONNECT to, whatever name resolved to
// them: loopback, unspecified, link-local — including their IPv4-mapped-IPv6
// spellings. Private LAN ranges stay reachable (the user approved the host).
function isBlockedAddress(ip) {
  const addr = String(ip == null ? '' : ip).toLowerCase();
  if (addr.startsWith('::ffff:')) {
    // IPv4-mapped IPv6. Node's resolver emits these in dotted form
    // (::ffff:127.0.0.1); classify that as IPv4. The hex form (::ffff:7f00:1)
    // is abnormal from a resolver — block it rather than risk misclassifying a
    // mapped loopback/link-local we can't cheaply decode.
    const mapped = addr.slice(7);
    if (net.isIPv4(mapped)) return isBlockedV4(mapped);
    return true;
  }
  if (net.isIPv4(addr)) return isBlockedV4(addr);
  if (net.isIPv6(addr)) return addr === '::1' || addr === '::' || /^fe[89ab]/.test(addr);
  return true;   // unparseable → block
}

function isBlockedV4(v4) {
  return /^127\./.test(v4) || /^169\.254\./.test(v4) || v4 === '0.0.0.0';
}

// dns.lookup replacement handed to http(s).request: resolves, then drops every
// blocked address. A name that only resolves to blocked space fails the request.
function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const safe = (addresses || []).filter(a => !isBlockedAddress(a.address));
    if (!safe.length) {
      const blocked = new Error('blocked_address');
      blocked.code = 'EBLOCKED';
      return callback(blocked);
    }
    if (options && options.all) return callback(null, safe);
    callback(null, safe[0].address, safe[0].family);
  });
}

// Execute a validated proxy request. Resolves
// { status, contentType, location, buffer } and rejects with Error whose
// .code/.message maps to a client-safe error string in the route handler.
function proxyFetch({ url, method, headers, body }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.request(url, {
      method,
      headers: { 'User-Agent': 'Mozilla/5.0 (Xenon Widget SDK)', ...headers },
      timeout: PROXY_TIMEOUT_MS,
      lookup: guardedLookup,
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > PROXY_MAX_RESPONSE_BYTES) { req.destroy(new Error('response_too_large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => finish(resolve, {
        status: res.statusCode || 0,
        contentType: String(res.headers['content-type'] || ''),
        location: String(res.headers.location || ''),
        buffer: Buffer.concat(chunks),
      }));
      res.on('error', e => finish(reject, e));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => finish(reject, e));
    if (body) req.write(body);
    req.end();
  });
}

// Response bodies with a textual content-type come back as a UTF-8 string;
// everything else is base64 (the widget can build a data: URI from it).
function isTextualContentType(ct) {
  const v = String(ct || '').toLowerCase();
  return v.startsWith('text/')
    || /^application\/(json|xml|javascript|x-www-form-urlencoded)\b/.test(v)
    || v.includes('+json') || v.includes('+xml')
    || v.startsWith('image/svg');
}

module.exports = { proxyFetch, isBlockedAddress, isTextualContentType, guardedLookup, PROXY_MAX_RESPONSE_BYTES };
