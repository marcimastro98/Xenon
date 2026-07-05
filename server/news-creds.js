'use strict';

// newsDataKey is the OPTIONAL NewsData.io API key. It is a SERVER-ONLY secret:
// the server's news.js uses it to enrich topic feeds and it must never reach the
// browser. Same preserve-on-save + redact-on-wire contract as the other optional
// provider keys (stocks-creds.js / football-creds.js).
//
// Both halves are REQUIRED together. Redact without preserve and the next normal
// client save (which never carries the real key) wipes it; preserve without
// redact and the secret keeps leaking to the browser. Do not add just one.

const NEWS_SECRET_KEYS = ['newsDataKey'];

function preserveNewsCreds(incoming, prev) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  if (!prev || typeof prev !== 'object') return incoming;
  for (const key of NEWS_SECRET_KEYS) {
    if (!incoming[key] && prev[key]) incoming[key] = prev[key];
  }
  return incoming;
}

function redactNewsCreds(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  return {
    ...settings,
    newsDataKey: '',
    newsDataKeySet: !!settings.newsDataKey,
  };
}

module.exports = { preserveNewsCreds, redactNewsCreds };
