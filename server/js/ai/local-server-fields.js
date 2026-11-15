'use strict';
// The two settings fields of Bit's local server, checked by the same code on both
// sides: the server (ai-local-server.js) and the dashboard (settings.js) persist
// them, and a mirror would drift. No DOM use, so it loads in node and in the page.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LocalServerFields = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const DEFAULT_URL = 'http://127.0.0.1:8080';
  const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
  const MAX_MODEL_LENGTH = 200;

  // This machine only, as an origin: a pasted ".../v1" keeps working, and Xenon
  // adds the path itself.
  function sanitizeUrl(value) {
    try {
      const u = new URL(String(value || '').trim());
      const web = u.protocol === 'http:' || u.protocol === 'https:';
      if (web && LOOPBACK_HOSTS.includes(u.hostname) && !u.username && !u.password) return u.origin;
    } catch (e) { /* not an address: the default below */ }
    return DEFAULT_URL;
  }

  // Any printable name: servers report repo paths, tags and even file paths.
  function sanitizeModel(value) {
    const v = String(value || '').trim();
    // eslint-disable-next-line no-control-regex
    return v && v.length <= MAX_MODEL_LENGTH && !/[\u0000-\u001f\u007f]/.test(v) ? v : 'auto';
  }

  return { DEFAULT_URL, sanitizeUrl, sanitizeModel };
});
