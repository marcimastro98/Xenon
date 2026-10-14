;(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.constants = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Loopback origin the dashboard/native app talk to. The local server binds
  // 127.0.0.1:3030; keep this in sync with server.js. (The iCUE widget uses a
  // user-configurable serverUrl property and is not bound to this constant.)
  const LOOPBACK_ORIGIN = 'http://127.0.0.1:3030';

  // UI languages Xenon ships translations for. Order is not significant.
  // Codes added here must also gain a translation block in server/js/i18n.js and
  // a native-name entry in LANG_META there; missing keys fall back to English.
  const SUPPORTED_LANGS = Object.freeze(['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']);

  const DEFAULT_LANG = 'en';

  // Normalise a BCP-47 / locale-ish value to a supported code, or '' if none.
  // e.g. 'en-US' → 'en', 'it' → 'it', 'fr' → ''. Matches the original inline
  // implementations in server/js/state.js and is the single source now.
  function normalizeLangCode(value) {
    const code = String(value || '').toLowerCase().split('-')[0];
    return SUPPORTED_LANGS.includes(code) ? code : '';
  }

  // Every "support Xenon" button goes through the supporter hub, which counts
  // which surface it came from (no identifier, only a daily total per label)
  // and then redirects to Buy Me a Coffee: the membership page by default, the
  // one-time page for plan 'once'. Without it nobody could tell which ask works.
  const SUPPORT_REDIRECT = 'https://xenon-supporter-hub.xenonedge.workers.dev/go/support';
  const SUPPORT_SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;

  function supportUrl(source, plan) {
    const s = String(source || '').toLowerCase();
    let url = SUPPORT_REDIRECT + '?s=' + (SUPPORT_SOURCE_RE.test(s) ? s : 'other');
    if (plan === 'once') url += '&p=once';
    return url;
  }

  return { LOOPBACK_ORIGIN, SUPPORTED_LANGS, DEFAULT_LANG, normalizeLangCode, supportUrl };
});
