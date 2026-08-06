'use strict';

// ── Paired-device access (R1.1) ──────────────────────────────────────────────
// The ONLY way a request that did not come from loopback may reach this server.
//
// The existing trust boundary — isAllowedRequest() in server.js — is unchanged
// and still the sole judge of LOCAL trust: socket IP, Host header, Origin, all
// three layers, all still required. This module adds a SECOND, narrower door
// beside it. A request either passes the loopback door (full trust, exactly as
// before) or it passes this one (a paired device, heavily restricted), and a
// failure on one is never retried against the other.
//
// The rule this module enforces, stated once so it can be checked against the
// list below:
//
//     A paired device IS the user's dashboard. It may do what the dashboard on
//     the PC does, except the handful of things that need a person standing at
//     that PC.
//
// This replaced a much narrower rule — read-only plus media/audio/mic — and the
// narrower one was wrong, in a way only real use showed: a tablet arrived, drew
// the whole dashboard, and then refused almost every control on it. "Add device"
// is not a request to view Xenon from a distance; it is the user saying this
// screen is one of mine. Treating a device the user deliberately paired, named
// and can revoke as semi-hostile produced a product that looks alive and does
// nothing, which is the failure mode this codebase avoids everywhere else.
//
// So the list below is a DENY list, and it is short on purpose. What stays out:
// raising a UAC prompt, running the updater, and the installers — each one puts
// a dialog, a restart or a download in front of somebody who is not there. A
// route added to server.js next year is available to a paired device, which is
// the correct default once "paired" means "mine".
//
// The trade this makes, stated plainly because it is the user's to accept: a
// paired device that is lost or handed to someone else is a way into the PC
// until it is revoked. That is what the device list, the per-device revoke and
// the one-tap kill switch are for, and it is what the Settings panel says.
//
// Four properties hold the door shut:
//   1. Off by default. With `remoteAccess.enabled` false this module is never
//      consulted and behaviour is byte-identical to a build without it.
//   2. The Host header must be an IP LITERAL that this machine currently owns.
//      DNS rebinding needs a NAME, so requiring a literal is the whole defence —
//      the same job ALLOWED_HOSTS does for loopback.
//   3. The token is per-device, stored only as a SHA-256 hash, compared in
//      constant time, and individually revocable.
//   4. The pre-auth surface is two paths wide (`/pair` and the redeem POST) and
//      rate-limited per source address.
//
// Transport note: the token rides in a cookie because EventSource and WebSocket
// cannot set headers, and the phone's first hit is a top-level navigation that
// cannot either. What keeps that ambient credential from becoming a CSRF hole
// is SameSite=Strict + HttpOnly, the exact-Origin check in `originAllowed()`,
// and the fact that no GET on this door mutates anything.
//
// It is NOT Fetch Metadata. Browsers append `Sec-Fetch-*` only to potentially
// trustworthy URLs, so on plain HTTP to a LAN address those headers never
// arrive at all — measured, see gateDecision step 4. An earlier version
// required them here and refused every legitimate request; a paired phone
// could not load the dashboard. The check remains for the day the transport is
// HTTPS (T2), but absent must read as "this transport cannot say", never as a
// reason to refuse and never as a reason to trust.
//
// This file is pure + requireable (no server state, no I/O outside the store it
// owns) so every decision above is unit-tested in test/remote-access.test.mjs.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write.js');

const STORE_VERSION = 1;
const STORE_FILENAME = 'remote-devices.json';
const COOKIE_NAME = 'xenon_device';
const MAX_DEVICES = 16;
const TOKEN_BYTES = 32;
const CODE_LENGTH = 8;
const CODE_TTL_MS = 3 * 60 * 1000;      // a pairing code is a live invitation, not a password
const CODE_MAX_ATTEMPTS = 5;            // wrong guesses before the code is burned
const DEVICE_NAME_MAX = 40;

// Unambiguous alphabet: no 0/O, no 1/I/L. The code is scanned from a QR in the
// normal case but has to survive being read aloud or typed in the bad one.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

// ── What a paired device may reach ───────────────────────────────────────────

// The deny list: what a paired device may NOT reach, and why. Every entry is
// the same reason — it needs a person at the PC, because it raises a dialog
// there, restarts the server, or downloads and places an executable.
const REMOTE_DENY = new Set([
  // Raises a UAC prompt on the PC. Tapping this from another room produces a
  // prompt nobody is standing in front of.
  '/system/enable-sensors',
  // The updater swaps files and restarts the server underneath the very
  // connection making the request, then verifies /version to decide whether to
  // roll back. Driving that from a device that is about to lose the server is a
  // way to get a half-applied update.
  '/update/prepare',
  '/update/apply',
  // Installers: each downloads something and puts it on disk where it will
  // later be run. Setup happens at the PC, where the progress and any prompt
  // are visible.
  '/api/native/install',
  '/api/gamemode/install-presentmon',
  '/api/lighting/sdk-install',
  '/api/ai-local/whisper-install',
  '/embedded-browser/adblock/install',
  '/remote/install',
  '/second-screen/install',
  '/second-screen/create-display',
  '/second-screen/remove-display',
  // Claude Code's own ingest. These are posted by the `claude` process against
  // a token minted on the PC; nothing in the dashboard calls them, so a paired
  // device asking for them is not a feature, it is a forged session.
  '/api/claude/event',
  '/api/claude/permission',
  '/api/claude/question',
  '/api/claude/turn-end',
  // The channel's RTMP stream key. Whoever holds it can broadcast to the user's
  // channel, and it is the one credential the dashboard is asked to show on
  // screen. It stays on the PC the user is standing at.
  '/stream/youtube/streamkey',
  // File transfer settings. Everything else about transfers is open to a paired
  // device on purpose — sending a photo from the phone in your hand to the PC
  // in the next room IS the feature — but this one endpoint names the FOLDER on
  // that PC where every future arrival lands. A device that could set it could
  // aim them at the app's own directory or at the user's Documents. The folder
  // is chosen at the PC, with the picker, which is the same shape the Slideshow
  // folder source has: the path lives only in settings and never on the wire.
  '/api/transfer/settings',
  // Dialling a number. The phonebook, the call log and the live call state ARE
  // reachable from a paired device — that is the dashboard being the dashboard
  // — but placing the call is not, and the reason is what happens next rather
  // than a worry about trust: the call's audio comes out of the PC (or the
  // phone itself), never the tablet that started it. A dial button on a screen
  // in another room begins a call the user cannot hear or end, which is the
  // "looks alive, does nothing" failure this codebase refuses everywhere else.
  // It is also the one action in the product that costs money per use.
  '/api/phone/dial',
  // Sending a message. Reading them IS allowed from a paired device — that is
  // the dashboard being the dashboard, and the notification mirror already
  // shows the text of the same messages — but sending one goes out under the
  // user's own number to somebody else, cannot be recalled, and is metered.
  '/api/phone/send',
]);

// Prefix denials, for routes that carry an id tail.
const REMOTE_DENY_PREFIXES = [];

// GET must never mutate on this door. Several endpoints answer both GET and
// POST — that GET shape exists for the iCUE widget, whose Qt WebEngine cannot
// `fetch` and reaches them through a JSONP <script> tag. A GET is also exactly
// what a top-level navigation is, and on this transport a navigation carries
// neither an Origin nor a fetch-metadata marker (see gateDecision), so it is
// the one request a hostile page could aim here. Refusing GET on anything that
// mutates removes the shape instead of trying to detect it; the dashboard's own
// client POSTs every one of them.
//
// server.js owns the authoritative list — it is `CSRF_MUTATION_PATHS`, which
// exists for exactly this property — and hands it over at boot through
// `useGetMutators()`. The copy below is the fallback for a caller that never
// wires it (the unit tests), and `test/remote-access.test.mjs` reads the real
// set out of server.js and fails if this one has drifted behind it.
const DEFAULT_GET_MUTATORS = new Set([
  '/system/enable-sensors', '/toggle', '/mic/volume', '/volume/set', '/speaker/mute',
  // Puts a System Settings window in front of whatever is on the Mac. Harmless
  // in itself, but a navigation is the one request shape this door cannot
  // attribute, and nothing should be able to throw a window on screen with it.
  '/macos/fda-settings',
  // Answering a call IS reachable from a paired device — a phone showing the
  // ringing card is the whole point — but only by POST. Answering focuses
  // another app and presses keys into it, so a top-level GET navigation to this
  // path (the one shape carrying neither an Origin nor a cross-site marker) has
  // to refuse.
  '/api/calls/act',
  '/api/calls/test',
  '/audio/app/volume', '/audio/app/mute', '/notes',
  '/media/source', '/media/playpause', '/media/next', '/media/previous',
  '/api/community/catalog', '/api/community/code', '/api/community/messages',
  '/api/community/installed', '/api/community/installs', '/api/community/poll',
  '/api/community/redeem', '/api/community/limited-status', '/api/community/ratings',
  '/api/community/rate', '/icon-pack', '/sound-pack', '/api/lighting/sdk-install',
  '/api/claude/event', '/api/claude/permission', '/api/claude/question', '/api/claude/turn-end',
  '/api/claude/decide', '/api/claude/answer', '/api/claude/reply', '/api/claude/link',
  '/api/claude/unlink', '/api/claude/run', '/api/claude/run/stop', '/api/claude/attach',
  '/search/open', '/search/reveal', '/search/ai',
  '/disk/scan', '/disk/scan/cancel', '/disk/clean', '/disk/clean/cancel', '/api/disk/advisor',
  '/spotlight/claimed', '/api/screenshot', '/api/screenshot/monitor',
  '/api/remote-access/enable', '/api/remote-access/pair', '/api/remote-access/pair/cancel',
  '/api/remote-access/redeem', '/api/remote-access/rename', '/api/remote-access/revoke',
  '/api/remote-access/revoke-all',
  // Web Push. These four ARE reachable from a paired device — the phone is the
  // thing that subscribes — but only by POST: /key writes a key pair, and
  // /subscribe stores the address the PC will later send to. Listing them here
  // is what makes a top-level GET navigation to one of them refuse, which is
  // the shape the Origin check cannot see. /api/push/status is deliberately
  // absent: it is a read, and it answers with no endpoint in it.
  '/api/push/key', '/api/push/subscribe', '/api/push/unsubscribe', '/api/push/test',
  // A YouTube search costs 100 of the account's 10,000 daily quota units. It is
  // POST-only for that reason; listing it here is what refuses the top-level GET
  // navigation, the one shape the Origin check cannot see.
  '/stream/youtube/search',
  // Creator-side writes on the user's own YouTube channel: they create or throw
  // away a broadcast, change who can watch it, or speak in the chat under the
  // user's name. All POST-only for that reason.
  '/stream/youtube/broadcast/create',
  '/stream/youtube/broadcast/cancel',
  '/stream/youtube/privacy',
  '/stream/youtube/chat/send',
  // The Twitch channel search, and the chat send that speaks under the user's
  // name in someone else's channel. Both POST-only, same shape as the YouTube
  // pair above.
  '/stream/twitch/search',
  '/stream/twitch/chat/send',
  // File transfer. The first four ARE reachable from a paired device — sending
  // and managing files is the feature — but only by POST, because /upload
  // writes a file to the PC and /open launches one with its registered handler.
  // /settings is refused outright above (REMOTE_DENY), and is listed here as
  // well so the loopback door refuses a top-level navigation to it too.
  // /api/transfer/file, /thumb and /list are deliberately absent: they are
  // reads, and /file is fetched BY a top-level navigation when the user taps
  // Download — listing it would refuse the download it exists to serve.
  '/api/transfer/upload', '/api/transfer/open', '/api/transfer/reveal',
  '/api/transfer/delete', '/api/transfer/settings',
  // Dialling. Refused outright above; listed here as well, for the same reason
  // /api/transfer/settings is, so the loopback door also refuses a top-level
  // navigation to it. /api/phone, /contacts, /calls, /messages and /message are
  // deliberately absent: they are reads a paired device is meant to make.
  '/api/phone/dial', '/api/phone/send',
]);
let _getMutators = DEFAULT_GET_MUTATORS;

// …with an exception, because CSRF_MUTATION_PATHS is a slightly different
// question. It lists every GET the server would rather a drive-by could not
// make — which includes reads whose only side effect is OUTBOUND: a cache miss
// that fetches from the catalog host, or a screenshot that photographs the
// screen. Those change nothing on the PC, and refusing them here broke real
// things on a tablet rather than protecting anything: the Store could not load
// its catalog, and the share card could not capture. The rule this door needs
// is narrower than that list — "no GET may change STATE" — so the reads are
// named back in. Each one is a read from the dashboard's point of view; a
// navigation aimed at one costs an outbound request (already throttled to
// 1/min) or one ffmpeg frame the page cannot even read.
const GET_READ_EXCEPTIONS = new Set([
  '/api/community/catalog',
  '/api/community/code',
  '/api/community/messages',
  '/api/community/installs',
  '/api/community/ratings',
  '/api/community/limited-status',
  '/stream/youtube/chat',
  '/api/screenshot',
  '/api/screenshot/monitor',
  '/api/claude/link',
]);

/** server.js calls this once at boot with its own CSRF_MUTATION_PATHS. */
function useGetMutators(set) {
  if (set && typeof set.has === 'function') _getMutators = set;
}

// The management endpoints are loopback-only by being denied here rather than
// by a check inside each handler: a phone must never be able to enrol another
// phone, rename or revoke the device that would kick it off, or switch the
// whole feature off from outside the house.
const REMOTE_ADMIN = new Set([
  '/api/remote-access/status',
  '/api/remote-access/enable',
  '/api/remote-access/https',
  '/api/remote-access/https/setup',
  '/api/remote-access/pair',
  '/api/remote-access/pair/cancel',
  '/api/remote-access/rename',
  '/api/remote-access/revoke',
  '/api/remote-access/revoke-all',
]);

const REMOTE_METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS']);

// ── Widget assets: a capability in the PATH, because the cookie cannot go there
//
// An SDK widget renders in `<iframe sandbox="allow-scripts">` with NO
// allow-same-origin, so its document has an OPAQUE origin — which is the whole
// point, and is not negotiable (see the sandbox invariant). A document with an
// opaque origin has a null site-for-cookies, so every subresource it requests
// is treated as cross-site and a `SameSite=Strict` cookie is withheld.
//
// Measured, not reasoned: an echo server on one origin, serving a page with two
// identical iframes. The iframe DOCUMENT carried the cookie in both. The
// sandboxed one's `widget.css` and `widget.js` arrived with NO cookie, NO
// Origin, NO Referer and `Sec-Fetch-Site: cross-site`; the non-sandboxed
// control's carried the cookie and read `same-origin`. On a paired device that
// means the widget's HTML loads and its stylesheet and script are refused —
// every SDK widget rendering as unstyled markup on the browser's white canvas,
// which is exactly what a real tablet showed.
//
// Neither of the two obvious fixes is available: the sandbox may never gain
// allow-same-origin, and the cookie may never leave SameSite=Strict (it is the
// CSRF defence on a cleartext transport). Serving these assets pre-auth was the
// third option and is worse than it looks — it would turn "exactly two paths
// are reachable without a token" into a whole tree, readable by anyone on the
// Wi-Fi, including files from packages the user authored.
//
// So the credential moves into the path, where RELATIVE URLs inherit it for
// free: `/sdk/wk/<key>/<pkg>/<file>`. The key is per DEVICE, minted at pairing,
// dies with the device on revoke, and buys exactly one thing — reading static
// files of installed widget packages. It is visible to the widget it serves
// (its own document URL), which is acceptable precisely because it unlocks
// nothing else: the route is GET-only, mutates nothing, and the widget has no
// network to leak it over (`connect-src 'none'`).
const WIDGET_ASSET_PREFIX = '/sdk/wk/';
const ASSET_KEY_RE = /^[a-f0-9]{32}$/;

/**
 * Split `/sdk/wk/<key>/<rest>` into its parts. Pure; the caller resolves the
 * key against the device store.
 * @returns {{key: string, rest: string}|null}
 */
function parseWidgetAssetPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(WIDGET_ASSET_PREFIX)) return null;
  if (pathname.includes('..') || pathname.includes('\\')) return null;
  const tail = pathname.slice(WIDGET_ASSET_PREFIX.length);
  const cut = tail.indexOf('/');
  if (cut <= 0) return null;
  const key = tail.slice(0, cut);
  const rest = tail.slice(cut + 1);
  if (!ASSET_KEY_RE.test(key) || !rest) return null;
  return { key, rest };
}

/**
 * The gate on WHAT a paired device may reach. Allow by default; see the module
 * header for why, and REMOTE_DENY for the exceptions.
 * @param {string} pathname URL pathname, already decoded by the URL parser
 * @param {string} method   HTTP method
 */
function remotePathAllowed(pathname, method) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return false;
  const m = String(method || '').toUpperCase();
  if (!REMOTE_METHODS.has(m)) return false;
  // A traversal-looking path never reaches a decision. server.js re-validates
  // every path anyway; refusing here keeps the gate readable.
  if (pathname.includes('..')) return false;
  if (m === 'OPTIONS') return true;                       // CORS preflight only
  if (REMOTE_DENY.has(pathname)) return false;
  if (REMOTE_ADMIN.has(pathname)) return false;
  if (REMOTE_DENY_PREFIXES.some((p) => pathname.startsWith(p))) return false;
  // The keyed widget-asset tree reads files and does nothing else. Saying so
  // here, rather than only in the route, keeps the capability's whole reach
  // visible in the gate: a credential that travels in a URL should be readable
  // as "this buys GET on static files" without leaving this file.
  if (pathname.startsWith(WIDGET_ASSET_PREFIX) && m !== 'GET' && m !== 'HEAD') return false;
  if ((m === 'GET' || m === 'HEAD') && _getMutators.has(pathname) && !GET_READ_EXCEPTIONS.has(pathname)) return false;
  return true;
}

// ── The gate ─────────────────────────────────────────────────────────────────

// The two paths a device may reach BEFORE it holds a token. Everything else
// requires one. Keep this list at two entries: it is the entire attack surface
// available to anyone who can put a packet on the user's LAN.
const PRE_AUTH = [['/pair', 'GET'], ['/api/remote-access/redeem', 'POST']];

/**
 * The whole paired-device decision, as a pure function of its inputs.
 *
 * Extracted from server.js deliberately: this is the hostile-input path of the
 * feature, the ORDER of the checks is part of the security property (a bad Host
 * must lose before a valid token can win), and neither is reviewable inside a
 * request handler that also writes responses. server.js keeps only the adapter
 * — gather headers, call this, write the answer — plus the two stateful pieces
 * that cannot be pure: rate limiting and the token lookup.
 *
 * @param {object} i
 * @param {boolean} i.enabled       hubSettings.remoteAccess.enabled
 * @param {string}  i.host          Host header
 * @param {string}  i.origin        Origin header (may be undefined)
 * @param {string}  i.fetchSite     Sec-Fetch-Site header
 * @param {string}  i.fetchMode     Sec-Fetch-Mode header
 * @param {string}  i.method        HTTP method
 * @param {string}  i.pathname      URL pathname
 * @param {boolean} i.hasDevice     did the presented token resolve to a device
 * @param {string[]} i.addresses    this machine's current addresses
 * @param {number}  i.port          the port THIS listener answers on
 * @param {boolean} i.secure        the request arrived on the TLS listener
 * @param {string}  i.tlsHost       that listener's certificate name ('' = none)
 * @returns {'forbidden'|'bad_origin'|'bad_fetch_site'|'remote_denied'|'redirect_pair'|'unpaired'|'pre_auth'|'ok'}
 */
function gateDecision(i) {
  const o = i || {};
  // 1. Off by default. Answered exactly as a build without the feature would,
  //    so a LAN scanner cannot tell the two apart.
  if (o.enabled !== true) return 'forbidden';

  // 2. Host must be an IP literal this machine owns. A NAME is always refused,
  //    which is what removes DNS rebinding rather than mitigating it — with the
  //    single exception of the HTTPS listener's own certificate name, where the
  //    handshake already proves the browser reached the machine it asked for
  //    (see isTlsNameHost for why that is a statement of the same rule, not a
  //    hole in it). `secure` is the LISTENER, never a header.
  const hostOk = isOwnAddressHost(o.host, o.addresses, o.port)
    || (o.secure === true && isTlsNameHost(o.host, o.tlsHost, o.port));
  if (!hostOk) return 'forbidden';

  // A subresource of a sandboxed widget document. Two of the checks below
  //    cannot be satisfied from there, and neither is a judgement about the
  //    request — both are consequences of the opaque origin the sandbox exists
  //    to create. Computed once, used twice.
  const opaqueSubresource = parseWidgetAssetPath(o.pathname) !== null;

  // 3. Origin, when present, must be exactly ours. `null` is refused here even
  //    though the loopback door accepts it for the iCUE WebView — EXCEPT on the
  //    keyed widget-asset path, where `null` is the only thing it can ever be.
  //
  //    Found the hard way, and only on a real browser: an SDK widget's own
  //    stylesheet came back 403 while the identical URL fetched from the parent
  //    page returned 200. The parent has a real origin and sends no Origin
  //    header on a same-origin GET; the sandboxed document has an OPAQUE one
  //    and sends `Origin: null`. Chromium then named it out loud — the widget
  //    asked for a stylesheet, got our JSON refusal, and the DevTools Issues
  //    panel reported "Response was blocked by CORB (Cross-Origin Read
  //    Blocking)" plus "failed to load a stylesheet". So the browser considers
  //    every subresource of that document cross-origin, which is exactly what
  //    an opaque origin means.
  //
  //    Accepting `null` HERE gives nothing away: this path is GET-only, serves
  //    static files of installed packages, and carries its own per-device
  //    capability in the URL. A page that wanted to read these would still need
  //    the key. Everywhere else `null` stays refused, which is the rule that
  //    matters — a sandboxed iframe on any site inherits `null`, and the
  //    cookie-authenticated surface must never accept it.
  const originOk = originAllowed(o.origin, o.host, o.secure === true)
    || (opaqueSubresource && String(o.origin).trim().toLowerCase() === 'null');
  if (!originOk) return 'bad_origin';

  // 4. Fetch Metadata, WHEN IT EXISTS. It does not exist on this transport, and
  //    that is measured rather than assumed: browsers append Sec-Fetch-* only
  //    for potentially trustworthy URLs, so a plain-HTTP LAN address gets none
  //    of them. Verified against a real echo server — a navigation, a
  //    same-origin fetch() and a favicon request to `http://192.168.1.3:8321`
  //    all arrived with no Sec-Fetch-Site, no Sec-Fetch-Mode and no Origin,
  //    while the identical page on `http://127.0.0.1:8321` carried all of them.
  //    An earlier version REQUIRED the header here, which refused 100% of
  //    legitimate traffic: a paired phone could not load the dashboard at all.
  //
  //    Three things carry the weight instead, and together they cover the
  //    shapes this check was there for:
  //      - the cookie is SameSite=Strict, so a request INITIATED by another
  //        site never carries it — a drive-by page gets `unpaired`, not access;
  //      - `originAllowed` above still refuses any Origin that is not exactly
  //        ours, and refuses `null`; Origin is NOT a Fetch Metadata header and
  //        does arrive on this transport for cross-origin fetch/XHR/form POST;
  //      - no GET on this door mutates anything (see REMOTE_ROUTES), so the one
  //        shape that carries neither an Origin nor a cross-site marker — a
  //        top-level navigation — can only ever read. That is enforced by a
  //        test against server.js's own CSRF_MUTATION_PATHS.
  //
  //    Kept as a check rather than deleted: on the T2 (HTTPS) transport the
  //    header returns, and there it must still be `same-origin`, or `none` on a
  //    navigation. Absent means "this transport cannot say", never "trust me".
  //
  //    ONE exemption, and it is a fact about the transport rather than a
  //    relaxation: a subresource of an opaque-origin (sandboxed) document is
  //    stamped `cross-site` even when it is the very same origin, so the keyed
  //    widget-asset path can never satisfy this check. Measured on the echo
  //    server described above. It costs nothing: that path is GET-only, mutates
  //    nothing, and carries its own per-device credential.
  const site = String(o.fetchSite || '').toLowerCase();
  const isNavigate = String(o.fetchMode || '').toLowerCase() === 'navigate';
  if (site && site !== 'same-origin' && !(isNavigate && site === 'none') && !opaqueSubresource) return 'bad_fetch_site';

  // 5. What it may reach. Allow by default; see REMOTE_DENY for what does not
  //    travel, and why.
  if (!remotePathAllowed(o.pathname, o.method)) return 'remote_denied';

  // 6. The token itself.
  if (!o.hasDevice) {
    const m = String(o.method || '').toUpperCase();
    // A device that was revoked still has the dashboard bookmarked. Send it to
    // the pairing page rather than a 403 it cannot act on.
    if (o.pathname === '/' && m === 'GET') return 'redirect_pair';
    const pre = PRE_AUTH.some(([p, pm]) => p === o.pathname && pm === m);
    return pre ? 'pre_auth' : 'unpaired';
  }
  return 'ok';
}

// ── Host / Origin ────────────────────────────────────────────────────────────

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

// ── Tokens and codes ─────────────────────────────────────────────────────────

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

// Hex, not base64url: this one travels as a PATH SEGMENT, and hex is the only
// alphabet that needs no escaping and cannot collide with a separator.
function newAssetKey() {
  return crypto.randomBytes(16).toString('hex');
}

function newCode() {
  let out = '';
  // rejection-free: 31 symbols read from a 256-value byte would bias, so draw
  // one byte per symbol and redraw the tail above the largest exact multiple.
  const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  while (out.length < CODE_LENGTH) {
    for (const b of crypto.randomBytes(CODE_LENGTH)) {
      if (b >= limit) continue;
      out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

/** Strip formatting and fold case so "abcd-efgh" redeems the code ABCDEFGH. */
function canonicalCode(input) {
  return String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, CODE_LENGTH);
}

/** Display form: XXXX-XXXX, readable aloud. */
function formatCode(code) {
  const c = canonicalCode(code);
  return c.length === CODE_LENGTH ? c.slice(0, 4) + '-' + c.slice(4) : c;
}

/** Constant-time string compare that does not leak length through timing. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) {
    // Still burn a comparison so a wrong LENGTH costs the same as a wrong value.
    try { crypto.timingSafeEqual(ba, ba); } catch { /* ignore */ }
    return false;
  }
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

/** Read our cookie out of a Cookie header without a parser dependency. */
function readCookie(header, name) {
  const raw = String(header || '');
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return '';
}

/**
 * Set-Cookie for a device token.
 *
 * `Secure` follows the LISTENER the pairing happened on, and it has to: on T1
 * (plain HTTP on the LAN) a Secure cookie is never stored by the browser at all,
 * which reads to the user as "pairing silently did nothing". On T2 (the HTTPS
 * door) it is correct and free. Note the two doors have different hosts — an IP
 * literal vs the MagicDNS name — and cookies are scoped per host, so a device
 * paired on one is not paired on the other. That is why the pairing QR points at
 * the HTTPS address whenever it exists: that one address works both at home and
 * away, so nobody has to pair the same phone twice.
 */
function cookieHeader(token, { maxAgeSec = 365 * 24 * 3600, secure = false } = {}) {
  const value = token ? String(token) : '';
  const age = token ? maxAgeSec : 0;
  return COOKIE_NAME + '=' + value + '; Path=/; Max-Age=' + age
    + '; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '');
}

// ── Rate limiting ────────────────────────────────────────────────────────────

/**
 * Fixed-window counter, bounded in memory. Used for the pre-auth pairing
 * surface (per source address) and for authenticated devices (per device).
 */
function createRateLimiter({ limit, windowMs, maxKeys = 512 }) {
  const hits = new Map();
  return {
    /** @returns {boolean} true when the caller is within its budget */
    take(key, now) {
      const k = String(key || '');
      const t = Number.isFinite(now) ? now : Date.now();
      let rec = hits.get(k);
      if (!rec || t - rec.start >= windowMs) { rec = { start: t, n: 0 }; hits.set(k, rec); }
      rec.n++;
      if (hits.size > maxKeys) {
        // Drop the oldest windows rather than growing without bound. Map keeps
        // insertion order, and an evicted key just gets a fresh budget.
        for (const [ek, er] of hits) {
          if (hits.size <= maxKeys) break;
          if (er !== rec && t - er.start >= windowMs) hits.delete(ek);
        }
        if (hits.size > maxKeys) {
          for (const ek of hits.keys()) { if (ek !== k) { hits.delete(ek); break; } }
        }
      }
      return rec.n <= limit;
    },
    reset(key) { hits.delete(String(key || '')); },
    size() { return hits.size; },
  };
}

// What ONE dashboard load costs a paired device, measured on a real paired
// browser against this build: 250 requests (116 files under js/, 67 component
// stylesheets, 11 global ones, the shared core, then the API reads and the SDK
// frames). It is here as a number the budget below is derived FROM, so the two
// cannot drift apart silently — if the shell ever gets much heavier, the
// derived budget is the thing to re-check.
const DASHBOARD_LOAD_REQUESTS = 250;

// The per-device budget. This is a ceiling on a runaway client, NOT a security
// control: the security-relevant limiter is the pre-auth one (10/min, per
// source address, guarding the pairing code), and the loopback door has no
// limit at all — so a paired device is still held to something the PC itself
// is not.
//
// It was 900/min, which is 3.6 loads, and that is inside what a person does by
// hand while setting a phone up. The requests it refused were the LAST ones of
// a load — SDK widget stylesheets and scripts mount after the shell — so the
// dashboard came up looking healthy with its widgets rendered as unstyled
// markup on a white canvas. That is the exact failure the keyed asset path
// exists to prevent, reintroduced by a counter, and invisible from the phone:
// a 429 on a stylesheet looks identical to a broken widget, and the obvious
// next move (reload) spends more of the same budget and makes it worse.
// Measured rather than reasoned: request 900 answered 200, request 901
// answered 429, with everything else in the system healthy.
//
// 24 loads a minute is far past anything a person does by hand, and still caps
// a looping client at 100 requests a second.
const DEVICE_RATE_LIMIT = DASHBOARD_LOAD_REQUESTS * 24;

// ── The device store ─────────────────────────────────────────────────────────

function cleanName(value, fallback) {
  const s = String(value == null ? '' : value)
    // The name is rendered in the device list and echoed back to the phone.
    // Control characters are REPLACED, not stripped, so a name carrying one
    // cannot silently collapse into a different, legitimate-looking name.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DEVICE_NAME_MAX)
    .trim();
  return s || fallback;
}

/**
 * Explicit key-by-key rebuild of the persisted store — never a spread of what
 * was on disk. A device whose token hash is unusable is dropped rather than
 * kept as an entry that can never authenticate.
 */
function normalizeDeviceStore(value) {
  const src = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
  const list = Array.isArray(src.devices) ? src.devices : [];
  const devices = [];
  const seenIds = new Set();
  for (const d of list) {
    if (devices.length >= MAX_DEVICES) break;
    if (!d || typeof d !== 'object') continue;
    const id = typeof d.id === 'string' && /^[a-f0-9]{16}$/.test(d.id) ? d.id : '';
    const tokenHash = typeof d.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(d.tokenHash) ? d.tokenHash : '';
    if (!id || !tokenHash || seenIds.has(id)) continue;
    seenIds.add(id);
    devices.push({
      id,
      tokenHash,
      name: cleanName(d.name, 'Device'),
      createdAt: Number.isFinite(d.createdAt) && d.createdAt > 0 ? Math.floor(d.createdAt) : 0,
      lastSeenAt: Number.isFinite(d.lastSeenAt) && d.lastSeenAt > 0 ? Math.floor(d.lastSeenAt) : 0,
      lastIp: typeof d.lastIp === 'string' ? d.lastIp.slice(0, 45) : '',
      // Empty for a device paired before widget assets needed one; load() mints
      // it. Minting here would make this function impure, and it is the one
      // piece of the store that is unit-tested as a pure normalizer.
      assetKey: typeof d.assetKey === 'string' && ASSET_KEY_RE.test(d.assetKey) ? d.assetKey : '',
    });
  }
  return { version: STORE_VERSION, devices };
}

/** The shape sent to the dashboard: never the hash, never the token. */
function publicDevice(d) {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, lastIp: d.lastIp };
}

/**
 * Owns DATA_DIR/remote-devices.json and the in-memory pairing code.
 *
 * The store is loaded once and kept in memory: authenticate() runs on every
 * remote request and must not touch the disk. Writes go through
 * writeFileAtomic, like every other durable store.
 */
function createRemoteAccess({ dir, now = () => Date.now() } = {}) {
  const file = path.join(String(dir || '.'), STORE_FILENAME);
  let store = { version: STORE_VERSION, devices: [] };
  let loaded = false;

  // The live pairing invitation. At most one at a time: two open codes on
  // screen is a UI nobody asked for, and it doubles the guessing surface.
  let pending = null;   // { code, expiresAt, attempts }

  const redeemLimiter = createRateLimiter({ limit: 10, windowMs: 60 * 1000 });
  const deviceLimiter = createRateLimiter({ limit: DEVICE_RATE_LIMIT, windowMs: 60 * 1000 });

  async function load() {
    if (loaded) return store;
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      store = normalizeDeviceStore(JSON.parse(raw));
    } catch (e) {
      // ENOENT is the normal first-run case. A parse failure means the file is
      // damaged; starting from empty is right here (unlike notes, no user
      // content is lost — the user re-pairs), but say so rather than swallow it.
      if (e && e.code !== 'ENOENT') console.warn('[remote-access] device store unreadable, starting empty:', e.message);
      store = { version: STORE_VERSION, devices: [] };
    }
    // Devices paired before the widget-asset capability existed have no key.
    // Mint one rather than let their SDK widgets render unstyled — the user
    // would have to un-pair and re-pair to fix a thing they cannot see.
    let minted = 0;
    for (const d of store.devices) {
      if (!d.assetKey) { d.assetKey = newAssetKey(); minted++; }
    }
    loaded = true;
    if (minted) persist().catch((e) => console.warn('[remote-access] could not persist asset keys:', e.message));
    return store;
  }

  async function persist() {
    await writeFileAtomic(file, JSON.stringify(store, null, 2));
  }

  /** Open a pairing window. Replaces any previous code — see `pending`. */
  function startPairing() {
    const t = now();
    pending = { code: newCode(), expiresAt: t + CODE_TTL_MS, attempts: 0 };
    return { code: pending.code, display: formatCode(pending.code), expiresAt: pending.expiresAt };
  }

  function cancelPairing() { pending = null; }

  function pairingState() {
    if (!pending) return null;
    if (now() >= pending.expiresAt) { pending = null; return null; }
    return { code: pending.code, display: formatCode(pending.code), expiresAt: pending.expiresAt };
  }

  /**
   * Redeem a pairing code for a device token.
   * Returns `{ ok:true, token, device }` or `{ ok:false, error }` — never
   * throws, and never says WHICH part was wrong.
   */
  async function redeem(code, { name, ip } = {}) {
    await load();
    const t = now();
    if (!redeemLimiter.take('ip:' + (ip || '?'), t)) return { ok: false, error: 'rate_limited' };
    if (!pending || t >= pending.expiresAt) { pending = null; return { ok: false, error: 'no_pairing' }; }
    const got = canonicalCode(code);
    if (got.length !== CODE_LENGTH || !safeEqual(got, pending.code)) {
      pending.attempts++;
      // Burn the invitation rather than let it be ground down. The user taps
      // "Aggiungi dispositivo" again, which costs one tap and voids the guesses.
      if (pending.attempts >= CODE_MAX_ATTEMPTS) pending = null;
      return { ok: false, error: 'bad_code' };
    }
    if (store.devices.length >= MAX_DEVICES) return { ok: false, error: 'too_many_devices' };
    pending = null;                       // single use, always
    const token = newToken();
    const device = {
      id: crypto.randomBytes(8).toString('hex'),
      tokenHash: hashToken(token),
      name: cleanName(name, 'Device'),
      createdAt: t,
      lastSeenAt: t,
      lastIp: String(ip || '').slice(0, 45),
      assetKey: newAssetKey(),
    };
    store.devices.push(device);
    await persist();
    return { ok: true, token, device: publicDevice(device) };
  }

  /**
   * Resolve a token to a device. Hot path: called on every remote request, so
   * it hashes once and compares in constant time against each stored hash.
   * Returns null for anything that does not resolve.
   */
  function authenticate(token) {
    if (!loaded || !token) return null;
    const s = String(token);
    if (s.length < 16 || s.length > 128) return null;
    const h = hashToken(s);
    for (const d of store.devices) {
      if (safeEqual(h, d.tokenHash)) return d;
    }
    return null;
  }

  /**
   * Resolve a widget-asset capability to its device. Deliberately NOT part of
   * `authenticate`: this key unlocks static package files and nothing else, so
   * it must never become an alternative way to present a device token. Compared
   * in constant time like the token, for the same reason.
   */
  function authenticateAssetKey(key) {
    if (!loaded || typeof key !== 'string' || !ASSET_KEY_RE.test(key)) return null;
    for (const d of store.devices) {
      if (d.assetKey && safeEqual(key, d.assetKey)) return d;
    }
    return null;
  }

  /** Budget check for an authenticated device. */
  function withinRate(deviceId, at) {
    return deviceLimiter.take('dev:' + deviceId, Number.isFinite(at) ? at : now());
  }

  /**
   * Budget check for the token-less surface, by source address. Shares the
   * limiter with redeem() on purpose: loading the pairing page and guessing a
   * code are the same door, and someone probing it should not get a fresh
   * allowance by alternating between the two.
   */
  function withinPreAuthRate(ip, at) {
    return redeemLimiter.take('ip:' + (ip || '?'), Number.isFinite(at) ? at : now());
  }

  // lastSeen/lastIp are UI comfort, not security — flush them lazily so a phone
  // holding an SSE stream open does not rewrite the store on every request.
  let dirtySince = 0;
  const TOUCH_FLUSH_MS = 60 * 1000;
  function touch(device, ip) {
    if (!device) return;
    const t = now();
    device.lastSeenAt = t;
    if (ip) device.lastIp = String(ip).slice(0, 45);
    if (!dirtySince) dirtySince = t;
    if (t - dirtySince < TOUCH_FLUSH_MS) return;
    dirtySince = 0;
    persist().catch(() => { /* a stale "last seen" is not worth an error path */ });
  }

  async function rename(id, name) {
    await load();
    const d = store.devices.find((x) => x.id === id);
    if (!d) return { ok: false, error: 'not_found' };
    d.name = cleanName(name, d.name);
    await persist();
    return { ok: true, device: publicDevice(d) };
  }

  async function revoke(id) {
    await load();
    const before = store.devices.length;
    store.devices = store.devices.filter((x) => x.id !== id);
    if (store.devices.length === before) return { ok: false, error: 'not_found' };
    await persist();
    return { ok: true };
  }

  async function revokeAll() {
    await load();
    const n = store.devices.length;
    store.devices = [];
    pending = null;
    await persist();
    return { ok: true, revoked: n };
  }

  function list() { return store.devices.map(publicDevice); }
  function count() { return store.devices.length; }
  /**
   * Has the store been read yet? Until it has, authenticate() cannot succeed —
   * so the gate must treat the feature as OFF rather than as "this device is
   * not paired". The distinction matters for the few milliseconds after boot:
   * refusing looks like a server still starting (and a refresh fixes it),
   * whereas sending a paired phone to the pairing page looks like it was
   * silently unpaired, which it was not.
   */
  function isLoaded() { return loaded; }

  /** Flush any pending lastSeen bookkeeping (called from graceful shutdown). */
  async function flush() {
    if (!dirtySince) return;
    dirtySince = 0;
    await persist().catch(() => {});
  }

  return {
    load, list, count, flush, isLoaded,
    startPairing, cancelPairing, pairingState, redeem,
    authenticate, authenticateAssetKey, withinRate, withinPreAuthRate, touch, rename, revoke, revokeAll,
    get file() { return file; },
  };
}

module.exports = {
  STORE_VERSION, STORE_FILENAME, COOKIE_NAME, MAX_DEVICES,
  CODE_LENGTH, CODE_TTL_MS, CODE_MAX_ATTEMPTS, DEVICE_NAME_MAX,
  REMOTE_DENY, REMOTE_ADMIN, DEFAULT_GET_MUTATORS, GET_READ_EXCEPTIONS, PRE_AUTH, useGetMutators,
  gateDecision, remotePathAllowed, isOwnAddressHost, isTlsNameHost, originAllowed,
  WIDGET_ASSET_PREFIX, parseWidgetAssetPath,
  ownAddresses, pairingAddresses,
  hashToken, newToken, newAssetKey, newCode, canonicalCode, formatCode, safeEqual,
  readCookie, cookieHeader, createRateLimiter, DASHBOARD_LOAD_REQUESTS, DEVICE_RATE_LIMIT,
  normalizeDeviceStore, createRemoteAccess,
};
