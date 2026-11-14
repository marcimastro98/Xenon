'use strict';
// Checks a request a widget sends through Xenon's fetch proxy: the host it may reach, never
// this PC or a private network unless the user said so, and the methods and headers allowed.

const { FETCH_BODY_MAX_BYTES: PROXY_BODY_MAX_BYTES } = require('../sdk-limits/limits.js');

const PROXY_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
// Request headers a widget may set through the proxy: the usual API-auth and
// content-negotiation names plus custom x-* — never cookie/host/origin.
const PROXY_HEADER_NAMES = Object.freeze(['accept', 'accept-language', 'content-type', 'authorization']);
const PROXY_CUSTOM_HEADER_RE = /^x-[a-z0-9-]{1,40}$/;
const PROXY_MAX_HEADERS = 12;

// RFC 1123 hostname (also matches IPv4 literals). IPv6 literals are rejected —
// the private/loopback classification below is IPv4+names only, on purpose.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/;

// Hosts a manifest may never declare and the proxy may never contact: the local
// API itself and everything loopback/link-local lives here. This is the wire-
// level half of the sandbox kill-switch — the widget CSP blocks direct network,
// and this keeps the proxy from being a detour back to 127.0.0.1:3030.
function isForbiddenProxyHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

// Private-network targets (LAN gear rarely has TLS) — the only hosts plain
// http:// is allowed to. RFC1918 IPv4 literals, .local mDNS names, and
// single-label hostnames (NAS, printers); everything public must use https.
function isPrivateNetworkHost(host) {
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host.endsWith('.local')) return true;
  return !host.includes('.');
}

// Lowercased, validated hostname for the manifest allowlist — or '' if it isn't
// an acceptable proxy target (bad charset, IPv6, loopback/link-local).
function normalizeProxyHost(value) {
  const host = String(value == null ? '' : value).trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || !HOSTNAME_RE.test(host)) return '';
  if (isForbiddenProxyHost(host)) return '';
  return host;
}

// Validate a widget's proxied fetch against its manifest. Returns the exact
// request the proxy will make ({ ok:true, url, method, headers, body }) or
// { ok:false, error }. Rules: http(s) only; hostname must be on the package's
// declared allowlist (which can never contain loopback/link-local); plain http
// only to private-network targets; headers rebuilt from an allowlist with
// control characters rejected (no header injection); body bounded.
//
// `extraHosts` is the resolved value of the manifest's userHosts slots (see
// resolveUserHosts) — addresses the USER supplied for blanks this manifest
// declared. Callers must pass the output of resolveUserHosts and nothing else:
// it is the function that re-validates those values, so an arbitrary list here
// would widen the allowlist past what the manifest permits.
function validateProxyRequest(manifest, raw, extraHosts) {
  if (!manifest || !raw || typeof raw !== 'object') return { ok: false, error: 'bad_request' };
  const urlStr = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!urlStr || urlStr.length > 4096) return { ok: false, error: 'bad_url' };
  let url;
  try { url = new URL(urlStr); } catch { return { ok: false, error: 'bad_url' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'bad_scheme' };
  if (url.username || url.password) return { ok: false, error: 'bad_url' };
  const host = normalizeProxyHost(url.hostname);
  const declared = Array.isArray(manifest.hosts) ? manifest.hosts : [];
  const filled = Array.isArray(extraHosts) ? extraHosts : [];
  if (!host || !(declared.includes(host) || filled.includes(host))) return { ok: false, error: 'host_not_allowed' };
  if (url.protocol === 'http:' && !isPrivateNetworkHost(host)) return { ok: false, error: 'https_required' };
  const method = typeof raw.method === 'string' ? raw.method.toUpperCase() : 'GET';
  if (!PROXY_METHODS.includes(method)) return { ok: false, error: 'bad_method' };
  const headers = {};
  if (raw.headers != null) {
    if (typeof raw.headers !== 'object' || Array.isArray(raw.headers)) return { ok: false, error: 'bad_headers' };
    let count = 0;
    for (const key of Object.keys(raw.headers)) {
      const name = key.toLowerCase().trim();
      if (!PROXY_HEADER_NAMES.includes(name) && !PROXY_CUSTOM_HEADER_RE.test(name)) return { ok: false, error: 'bad_headers' };
      const value = String(raw.headers[key] == null ? '' : raw.headers[key]).slice(0, 1024);
      if (/[\r\n\0]/.test(value)) return { ok: false, error: 'bad_headers' };
      headers[name] = value;
      if (++count > PROXY_MAX_HEADERS) return { ok: false, error: 'bad_headers' };
    }
  }
  let body = '';
  if (raw.body != null) {
    if (typeof raw.body !== 'string') return { ok: false, error: 'bad_body' };
    if (Buffer.byteLength(raw.body) > PROXY_BODY_MAX_BYTES) return { ok: false, error: 'body_too_large' };
    if (!['POST', 'PUT', 'PATCH'].includes(method)) return { ok: false, error: 'bad_body' };
    body = raw.body;
  }
  return { ok: true, url: url.toString(), method, headers, body };
}

module.exports = {
  PROXY_METHODS, PROXY_HEADER_NAMES, PROXY_CUSTOM_HEADER_RE, PROXY_MAX_HEADERS, HOSTNAME_RE,
  isForbiddenProxyHost, isPrivateNetworkHost, normalizeProxyHost, validateProxyRequest,
};
