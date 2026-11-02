'use strict';
// What a page on another website may do with the local server.
//
// One rule for every path on the loopback door, rather than a list of routes:
//
//  · A request that changes something (any method but GET, HEAD, OPTIONS) is
//    refused when the browser says it comes from another site, or when it has
//    an opaque origin. Nothing of ours sends either: the dashboard is
//    same-origin, SDK widgets run under `connect-src 'none'`, the iCUE widgets
//    only load <script> and <img>, and command-line tools (the MCP bridge, the
//    Claude Code hooks, curl, webhooks) send no browser headers.
//
//  · A cross-site fetch() that reads the answer (mode `cors`, its preflight
//    included) is refused too. A cross-site <script> or <img> (mode `no-cors`)
//    still loads: that is how the iCUE widgets reach Xenon, and the JSONP
//    allowlist decides what such a load can read. A link the user clicks
//    (mode `navigate`) still opens the dashboard.
//
// Browsers set Sec-Fetch-Site and Sec-Fetch-Mode themselves. The opaque-origin
// check covers browsers old enough to send no Fetch Metadata.
//
// The paired-device door has its own, stricter rules (remote-access.js) and
// never reaches this.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function header(req, name) {
  return String((req.headers && req.headers[name]) || '').toLowerCase();
}

function refusedCrossSite(req) {
  const site = header(req, 'sec-fetch-site');
  const mode = header(req, 'sec-fetch-mode');
  const opaque = header(req, 'origin') === 'null';
  const method = String(req.method || 'GET').toUpperCase();
  if (!SAFE_METHODS.has(method) && (site === 'cross-site' || opaque)) return true;
  if (site === 'cross-site' && mode === 'cors') return true;
  return false;
}

// The local WebSockets (the browser tile's relay, the second screen, AI Live):
// only our own pages open one, always from the same origin.
function refusedSocketOrigin(req) {
  return header(req, 'origin') === 'null' || header(req, 'sec-fetch-site') === 'cross-site';
}

module.exports = { refusedCrossSite, refusedSocketOrigin };
