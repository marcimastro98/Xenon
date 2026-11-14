'use strict';
// The address a paired device loads a widget's files from: the key sits in the path because the
// cookie cannot go there, and this reads it back out.

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

module.exports = { WIDGET_ASSET_PREFIX, ASSET_KEY_RE, parseWidgetAssetPath };
