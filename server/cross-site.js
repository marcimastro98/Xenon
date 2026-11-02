'use strict';
// What a page that is not ours may do with the local server.
//
// "Not ours" means another website, a page served by some other program on
// another local port (a browser calls that same-site, because the port is not
// part of the site), or a sandboxed frame with an opaque origin. Nothing on
// such a page should be able to make Xenon do anything, and the rule below is
// written over every path instead of a list of routes, so a route added later
// is covered without anyone remembering to list it.
//
// From a page that is not ours:
//
//  · A request that changes something (any method but GET, HEAD, OPTIONS) is
//    refused.
//  · A fetch() that wants to read the answer (mode `cors`, its preflight
//    included) is refused.
//  · A link the user follows (mode `navigate`) opens only a page: the
//    dashboard and the other HTML pages, and the Spotify sign-in callback.
//    A navigation to an API route is refused, so a link cannot do what an
//    <img> cannot.
//  · A <script>, <img>, stylesheet or font (mode `no-cors`) loads only public
//    files: the dashboard's static files, an installed widget's files, icon
//    and sound packs, uploaded wallpapers and fonts, the /ping probe, and the
//    JSONP routes the iCUE widgets poll. Any other route is refused, so a page
//    elsewhere can never trigger a route with side effects with an <img>.
//
// What stays allowed, and why:
//  · The dashboard and every page of ours: same-origin.
//  · The iCUE widgets (file:// or qrc:// in Qt WebEngine): <script> JSONP on
//    the JSONP routes, an <img> probe of /ping, and the dashboard in an iframe
//    (a navigation to /).
//  · SDK widgets (sandboxed, opaque origin): their own files, including module
//    scripts and fonts, which are cors-mode loads.
//  · The native app's splash: a no-cors fetch of /ping, then a navigation to /.
//  · Programs on this PC (the MCP bridge, Claude Code hooks, curl, webhooks):
//    they send no browser headers, so none of this applies to them.
//
// Browsers set Sec-Fetch-Site and Sec-Fetch-Mode themselves; a page cannot set
// or remove them. For browsers too old to send them, the Origin header still
// identifies a foreign fetch() or POST, opaque origins included.
//
// The paired-device door has its own, stricter rules (remote-access.js) and
// never reaches this.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function header(req, name) {
  return String((req.headers && req.headers[name]) || '').toLowerCase();
}

// True when the Origin header names this server itself: a loopback host on
// Xenon's own port.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function isOwnOrigin(origin, port) {
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname) && u.port === String(port);
  } catch { return false; }
}

function foreign(req, port) {
  const origin = header(req, 'origin');
  // Our own page under another of its names (the dashboard opened at
  // localhost:3030 calling 127.0.0.1:3030) is still ours: the browser calls
  // that cross-site, but it sets Origin itself and a page cannot forge it.
  if (origin !== '' && isOwnOrigin(origin, port)) return false;
  const site = header(req, 'sec-fetch-site');
  if (site === 'cross-site' || site === 'same-site') return true;
  return origin !== '';
}

// The files of an installed SDK widget. The widget's page runs sandboxed, so
// its origin is opaque, and a `<script type="module">` or an @font-face it
// loads from its own folder is a cors-mode GET with `Origin: null`. That code
// is public (it came from the catalog or a share code) and holds no user data.
// /sdk/wk/ is the paired-device door's keyed copy of the same files.
const WIDGET_FILE_PREFIXES = ['/sdk/widget/', '/sdk/wk/'];
function isWidgetFile(pathname) {
  const p = String(pathname || '');
  return WIDGET_FILE_PREFIXES.some((pre) => p.startsWith(pre));
}

// Pages a link from elsewhere may open.
const PAGES = new Set([
  '/', '/pair', '/deck-popup', '/draw', '/menu', '/scene', '/screen-alerts',
  '/sdk-service', '/shell-driver', '/spotlight',
  // Spotify sends the browser back here after sign-in; the OAuth `state`
  // check in stream-spotify.js decides whether it counts.
  '/stream/spotify/callback',
]);
function isPage(pathname) {
  const p = String(pathname || '');
  return PAGES.has(p) || (/\.html$/i.test(p) && !p.startsWith('/api/'));
}

// Files a page elsewhere may load as a subresource. Static files are matched
// by extension and never under /api/ (an API route's tail can look like one,
// e.g. a camera entity "camera.front").
const PUBLIC_PREFIXES = [
  '/sdk/widget/', '/sdk/wk/', '/sdk/tile/', '/sdk/asset/',
  '/icon-pack/', '/sound-pack/', '/uploads/', '/font/',
];
const STATIC_EXT = /\.(?:m?js|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp3|wav|ogg|m4a|mp4|webm)$/i;
function isPublicFile(pathname) {
  const p = String(pathname || '');
  if (p === '/ping') return true;
  if (PUBLIC_PREFIXES.some((pre) => p.startsWith(pre))) return true;
  return STATIC_EXT.test(p) && !p.startsWith('/api/') && !p.startsWith('/stream/');
}

/**
 * @param req       the incoming request
 * @param port      this server's port (XENON_PORT)
 * @param pathname  the request path
 * @param opts.jsonp  (pathname) => true for the routes the iCUE widgets poll
 */
function refusedCrossSite(req, port = 3030, pathname = '', opts = {}) {
  if (!foreign(req, port)) return false;
  const method = String(req.method || 'GET').toUpperCase();
  if (!SAFE_METHODS.has(method)) return true;
  if (method === 'OPTIONS') return true;              // a foreign preflight
  const mode = header(req, 'sec-fetch-mode');
  if (isWidgetFile(pathname)) return false;           // module scripts, fonts
  if (mode === 'cors' || header(req, 'origin') !== '') return true;
  if (mode === 'navigate' || mode === 'nested-navigate') return !isPage(pathname);
  if (mode === 'websocket') return true;
  // A subresource (no-cors), or a browser that sent no mode at all.
  if (isPublicFile(pathname)) return false;
  if (opts && typeof opts.jsonp === 'function' && opts.jsonp(pathname)) return false;
  return true;
}

// The local WebSockets (the browser tile's relay, the second screen, AI Live):
// only our own pages open one. Browsers always send Origin on a socket.
function refusedSocketOrigin(req, port = 3030) {
  return foreign(req, port);
}

module.exports = { refusedCrossSite, refusedSocketOrigin, isOwnOrigin, isWidgetFile, isPage, isPublicFile };
