'use strict';
// The Content-Security-Policy a widget's frame is served with: the sandbox's kill-switch, and
// the same policy opened to this PC's own address for a paired device.

const { WIDGET_ID_RE } = require('./package-names.js');

// The CSP served with EVERY widget asset. `sandbox allow-scripts` keeps the
// document sandboxed (opaque origin, no allow-same-origin) even when navigated
// to directly; `connect-src 'none'` closes the Origin:null hole described in
// the header comment. Do not weaken either directive — a widget that "needs"
// network access is a protocol design change, not a CSP relaxation.
//
// `'self'` IS NOT ENOUGH ON ITS OWN, and that is not a detail. A sandboxed
// document without allow-same-origin has an OPAQUE origin, and `'self'` means
// "the origin of the protected resource" — when that origin is opaque it
// matches NOTHING. Chromium resolves it against the response URL instead and
// lets a widget load its own stylesheet; WebKit follows the letter of the spec
// and blocks it. So every SDK widget rendered as bare markup on a white
// background on iPhone and iPad, while looking perfect on every Chromium
// surface — which is all the others: the Xeneon Edge, the kiosk app, desktop
// browsers. Nothing about the phone door caused it, which is why it survived
// the network being measured end to end.
//
// The fix is to name the origin as well as `'self'`, so the same header works
// under both readings — see widgetCspFor(). WIDGET_CSP stays as the
// origin-less form: it is what the constant has always meant and what the tests
// pin. It is the template, never served as it is: widgetCspFor() replaces its
// script-src with the widget's own folder on every response.
const WIDGET_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  'sandbox allow-scripts',
].join('; ');

// A host we are willing to write into a header. Deliberately strict: letters,
// digits, dots, dashes, one colon and a port, or an IPv6 literal in brackets.
// The Host has already been validated twice before a request reaches the asset
// route (the loopback allowlist, or the paired-device gate's own-address /
// certificate-name check), so this is the third fence rather than the first —
// but a value that ends up inside a security header gets checked where it is
// used, not only where it came from.
const CSP_HOST_RE = /^(?:\[[0-9a-fA-F:.]{2,45}\]|[A-Za-z0-9.-]{1,253})(?::\d{1,5})?$/;
// A folder we are willing to write into a header: no dots, no separators.
const CSP_ROOT_RE = /^(?:\/[A-Za-z0-9-]+)+\/$/;

/**
 * The folder a widget's file is served from, under either spelling of the
 * route, or '' when the path is not one. The closing slash matters: in a CSP
 * it makes the source a prefix, without it the source is one exact file.
 *
 * @param {string} pathname the request path, not decoded
 */
function widgetAssetRoot(pathname) {
  const m = /^(\/sdk\/(?:widget|wk\/[a-f0-9]{32})\/([^/]+)\/)/.exec(String(pathname || ''));
  return m && WIDGET_ID_RE.test(m[2]) ? m[1] : '';
}

/**
 * WIDGET_CSP for one response: the serving origin named alongside `'self'`, and
 * scripts limited to the widget's own folder.
 *
 * Both spellings are sent on purpose for styles, images, fonts and media.
 * `'self'` is what a Chromium engine already honours; the explicit origin is what a
 * WebKit engine needs, because there `'self'` inside an opaque-origin document
 * matches nothing at all (see the note above WIDGET_CSP). Naming the origin
 * does not widen anything, and `connect-src 'none'` is untouched.
 *
 * Scripts are different: a <script> is the one load whose answer a page can
 * read, and the JSONP routes answer it for the iCUE widgets. So script-src names
 * the folder alone and drops `'self'`, which Chromium would read as the whole
 * origin. A widget gets what it was granted through the bridge, and cannot read
 * the PC's state around it.
 *
 * With no usable host or folder no script runs: a CSP that is too strict costs a
 * widget its code, one built from unvalidated input is a worse failure.
 *
 * @param {string} host   the request's Host header
 * @param {boolean} secure whether it arrived on the TLS listener
 * @param {string} assetRoot the widget's folder, from widgetAssetRoot()
 */
function widgetCspFor(host, secure, assetRoot) {
  const h = String(host || '').trim();
  const hostOk = !!h && CSP_HOST_RE.test(h);
  const origin = (secure === true ? 'https://' : 'http://') + h;
  const scripts = hostOk && CSP_ROOT_RE.test(String(assetRoot || '')) ? origin + assetRoot : "'none'";
  const csp = WIDGET_CSP.replace("script-src 'self'", 'script-src ' + scripts);
  if (!hostOk) return csp;
  return csp
    .replace("style-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' " + origin)
    .replace("img-src 'self' data: blob:", "img-src 'self' " + origin + ' data: blob:')
    .replace("font-src 'self' data:", "font-src 'self' " + origin + ' data:')
    .replace("media-src 'self' data: blob:", "media-src 'self' " + origin + ' data: blob:');
}

// A widget can send its own frame to one of its SVG files, and an SVG document
// runs scripts with no HTML to put the guard in. As an image it never runs any,
// so an SVG simply gets no scripts.
function assetCsp(csp, mime) {
  return String(mime).startsWith('image/svg') ? String(csp).replace(/script-src [^;]*/, "script-src 'none'") : csp;
}

module.exports = { WIDGET_CSP, CSP_HOST_RE, CSP_ROOT_RE, widgetAssetRoot, widgetCspFor, assetCsp };
