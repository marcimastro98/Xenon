'use strict';
// The language and country a news search is asked in, and the Google News address for a topic.

// Google News locale per UI language. It used to name five of the app's ELEVEN
// languages, and the other six fell through to en-US — so a German, French,
// Spanish, Portuguese, Russian or Dutch user asking for a topic got American
// news in English, silently, with the topic they typed in their own language.
// Google News serves all of these; there was no reason for the short list.
const NEWS_LOCALES = Object.freeze({
  it: 'IT', en: 'US', de: 'DE', fr: 'FR', es: 'ES', pt: 'PT',
  ru: 'RU', nl: 'NL', ko: 'KR', ja: 'JP', zh: 'CN',
});

/** The UI language reduced to one this module can actually serve. */
function newsLang(lang) {
  const l = String(lang || '').toLowerCase().slice(0, 2);
  return Object.prototype.hasOwnProperty.call(NEWS_LOCALES, l) ? l : 'en';
}

// Google News RSS search for a free-text topic, in the requested UI language.
function googleNewsUrl(query, lang) {
  const l = newsLang(lang);
  const region = NEWS_LOCALES[l];
  const hl = l === 'en' ? 'en-US' : l;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${region}&ceid=${region}:${l}`;
}

module.exports = { NEWS_LOCALES, newsLang, googleNewsUrl };
