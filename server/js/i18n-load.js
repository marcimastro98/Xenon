// The languages a page was not served with, fetched when it needs them.
//
// Every page loads /layer-i18n.js: the saved language, the browser's and
// English, a tenth of all the words (layer-strings.js). Two things want more: a
// language picked after the page loaded (setLang in js/i18n.js waits here),
// and the Settings and widget searches, which match words in every language
// (fuzzy-find.js i18nFields) and so ask for the rest the first time someone
// types. layer-strings.js appends this file to /layer-i18n.js, so every page
// that has the strings has it too.
(() => {
  'use strict';

  const pending = new Map(); // code -> the fetch bringing it

  const table = () => (typeof i18n === 'object' && i18n ? i18n : null);
  const supported = () => (typeof SUPPORTED_LANGS !== 'undefined' && Array.isArray(SUPPORTED_LANGS) ? SUPPORTED_LANGS : []);
  const origin = () => (typeof SERVER === 'string' ? SERVER : '');

  // A language's strings as sent: text, or a list of text (weekday names).
  function cleanStrings(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      const ok = typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
      if (ok) out[key] = value;
    }
    return out;
  }

  function fetchInto(tab, codes) {
    return fetch(origin() + '/i18n-langs.json?l=' + codes.join(','), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((data) => {
        for (const code of codes) {
          const strings = cleanStrings(data && data[code]);
          if (strings) tab[code] = strings;
        }
      })
      .catch((e) => { console.warn('[i18n] other languages unavailable, English stands in:', e && e.message); })
      .finally(() => codes.forEach((code) => pending.delete(code)));
  }

  // Fetch the asked languages the table lacks. Resolves true when at least one
  // of them is there afterwards; a failure leaves the table as it was (t()
  // falls back to English) and the next call tries again.
  function ensure(codes) {
    const tab = table();
    if (!tab) return Promise.resolve(false);
    const known = supported();
    const want = [...new Set((codes || []).map((c) => String(c || '').toLowerCase()))]
      .filter((c) => known.includes(c) && !Object.prototype.hasOwnProperty.call(tab, c));
    if (!want.length) return Promise.resolve(false);
    const fresh = want.filter((c) => !pending.has(c));
    if (fresh.length) {
      const job = fetchInto(tab, fresh);
      fresh.forEach((c) => pending.set(c, job));
    }
    return Promise.all(want.map((c) => pending.get(c))).then(() => want.some((c) => !!tab[c]));
  }

  const ensureAll = () => ensure(supported());

  const api = { ensure, ensureAll };
  if (typeof window !== 'undefined') window.I18nLoad = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
