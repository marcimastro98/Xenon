'use strict';
// Turns what a person typed in the browser tile's bar into an address: a site when it looks
// like one, a search otherwise.

// Decide whether a scheme-less omnibox entry is a hostname to visit or a search
// query. Mirrors a real browser's address bar: something with whitespace, or a
// single token with no dot/port/IP, is a search — everything else is a host.
function looksLikeHost(input) {
  const s = String(input || '').trim();
  if (!s || /\s/.test(s)) return false;              // has spaces → search
  const host = s.split(/[/?#]/)[0].replace(/:\d+$/, '');
  if (!host) return false;
  if (/^localhost$/i.test(host)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;   // IPv4
  if (/:\d+$/.test(s.split(/[/?#]/)[0])) return true;      // explicit host:port
  return /\.[a-z]{2,}$/i.test(host);                       // dotted name, letter TLD
}

// Build a search URL for a free-text query (browser omnibox default engine).
// Google may show its anti-bot CAPTCHA to the headless browser, but the tile is
// interactive so it can simply be solved in place.
function searchUrl(query) {
  return 'https://www.google.com/search?q=' + encodeURIComponent(String(query || '').trim());
}

// Validate/normalize a user-entered address. Only http/https are allowed into
// the tile (no file:, chrome:, javascript:, data:, …). An entry with an explicit
// scheme is honored; a bare hostname gets https://; free text (e.g. "google") is
// turned into a search instead of a doomed https://google navigation.
// Returns { ok:true, url } or { ok:false, error }.
function normalizeUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, error: 'empty_url' };
  // Explicit scheme: honor it, but block anything that isn't http/https. What
  // follows the colon must NOT be a bare port, or "localhost:3030" / "host:8080"
  // would be mis-read as a scheme instead of host:port.
  const scheme = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/s);
  if (scheme && !/^\d+([/?#].*)?$/.test(scheme[2])) {
    let u;
    try { u = new URL(raw); } catch (e) { return { ok: false, error: 'bad_url' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'blocked_scheme' };
    return { ok: true, url: u.href };
  }
  // No scheme: hostname → visit; anything else → search.
  if (looksLikeHost(raw)) {
    try { return { ok: true, url: new URL('https://' + raw).href }; }
    catch (e) { /* fall through to search */ }
  }
  return { ok: true, url: searchUrl(raw) };
}

module.exports = { looksLikeHost, searchUrl, normalizeUrl };
