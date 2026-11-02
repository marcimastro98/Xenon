'use strict';
// What a page on another website may do with the local server.
//
// One rule for every path on the loopback door, rather than a list of routes:
//
//  · A request that changes something (any method but GET, HEAD, OPTIONS) is
//    refused when it comes from a page that is not ours: the browser says it
//    is from another site (or another local port), or its Origin is anything
//    but this server, opaque origins included. Nothing of ours sends either: the dashboard is
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

// True when the Origin header names this server itself: a loopback host on
// Xenon's own port. Another program's page on another local port is not us.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function isOwnOrigin(origin, port) {
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname) && u.port === String(port);
  } catch { return false; }
}

// A page that is not ours: another site, an opaque origin, or a page served by
// some other program on another local port (the browser calls that same-site).
function foreign(req, port) {
  const site = header(req, 'sec-fetch-site');
  if (site === 'cross-site' || site === 'same-site') return true;
  const origin = header(req, 'origin');
  return origin !== '' && !isOwnOrigin(origin, port);
}

// The files of an installed SDK widget. The widget's page runs sandboxed, so
// its origin is opaque, and a `<script type="module">` or an @font-face it
// loads from its own folder is a cors-mode GET with `Origin: null`. That code
// is public (it came from the catalog or a share code) and holds no user
// data, so reading it is the one cross-origin read allowed. The paired-device
// door has its own keyed prefix for the same files.
const WIDGET_FILE_PREFIXES = ['/sdk/widget/', '/sdk/wk/'];
function isWidgetFile(pathname) {
  const p = String(pathname || '');
  return WIDGET_FILE_PREFIXES.some((pre) => p.startsWith(pre));
}

function refusedCrossSite(req, port = 3030, pathname = '') {
  const mode = header(req, 'sec-fetch-mode');
  const method = String(req.method || 'GET').toUpperCase();
  if (!SAFE_METHODS.has(method)) return foreign(req, port);
  if ((method === 'GET' || method === 'HEAD') && isWidgetFile(pathname)) return false;
  // A read: refused when a foreign page wants the answer (mode cors, or an
  // Origin header on a GET, which only fetch() sends). A <script> or <img>
  // from elsewhere (no-cors, no Origin) still loads.
  if (mode === 'cors' || header(req, 'origin') !== '') return foreign(req, port);
  return false;
}

// The local WebSockets (the browser tile's relay, the second screen, AI Live):
// only our own pages open one. Browsers always send Origin on a socket.
function refusedSocketOrigin(req, port = 3030) {
  return foreign(req, port);
}

module.exports = { refusedCrossSite, refusedSocketOrigin, isOwnOrigin, isWidgetFile };
