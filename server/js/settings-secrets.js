'use strict';
// The one list of server-only secrets that live inside the settings object.
// Shared by the server's redact/preserve helpers (stream-creds.js,
// stocks-creds.js, football-creds.js, news-creds.js, ai-provider-creds.js
// require their group from here) and by the dashboard, which must keep the same
// values out of its localStorage mirror (settings.js saveLocalHubSettings).
// Before this list existed the browser kept its own hand-written copy, and keys
// added later on the server (the stock, football and news keys, the OBS and
// Streamer.bot passwords) were written to localStorage in plain text.
//
// Adding a secret: put it here, give it the redact + preserve pair on the server
// (see stream-creds.js for why both halves are needed), and the browser side
// follows automatically. No DOM use, so it loads in node and in the page.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SettingsSecrets = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Top-level string keys, grouped by the server module that owns them.
  const SECRET_KEY_GROUPS = Object.freeze({
    stream: Object.freeze(['obsPassword', 'streamerbotPassword']),
    stocks: Object.freeze(['twelveDataKey', 'finnhubKey']),
    football: Object.freeze(['sportsDbKey']),
    news: Object.freeze(['newsDataKey']),
    ai: Object.freeze(['openaiApiKey', 'anthropicApiKey', 'geminiApiKey', 'localApiKey']),
  });

  const TOP_LEVEL_SECRET_KEYS = Object.freeze(
    Object.keys(SECRET_KEY_GROUPS).reduce((all, g) => all.concat(SECRET_KEY_GROUPS[g]), [])
  );

  // Secrets inside a settings sub-object: { block: [fields] }. Each is blanked by
  // its own server helper (redactHaToken, redactUnifiCreds, redactRemoteCreds).
  const NESTED_SECRET_KEYS = Object.freeze({
    homeAssistant: Object.freeze(['token']),
    unifi: Object.freeze(['password']),
    remoteControl: Object.freeze(['sunshineUser', 'sunshinePass']),
  });

  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
  }

  // A copy of `settings` with every secret above blanked, plus the private link
  // of each calendar feed (that link is the calendar's password; the server
  // keeps it, see ics-feeds.js redactCalendarFeedUrls). The `*Set` flags are
  // left alone so "saved" placeholders still show. Returns the same object when
  // there is nothing to blank, so the common case allocates nothing.
  function stripSettingsSecrets(settings) {
    if (!settings || typeof settings !== 'object') return settings;
    let out = settings;
    const own = () => { if (out === settings) out = { ...settings }; return out; };
    for (const key of TOP_LEVEL_SECRET_KEYS) {
      if (settings[key]) own()[key] = '';
    }
    for (const block of Object.keys(NESTED_SECRET_KEYS)) {
      const src = settings[block];
      if (!src || typeof src !== 'object') continue;
      const fields = NESTED_SECRET_KEYS[block].filter((f) => src[f]);
      if (!fields.length) continue;
      const copy = { ...src };
      for (const f of fields) copy[f] = '';
      own()[block] = copy;
    }
    if (Array.isArray(settings.calendarFeeds) && settings.calendarFeeds.some((f) => f && f.url)) {
      own().calendarFeeds = settings.calendarFeeds.map((f) => (
        f && f.url ? { ...f, url: '', urlSet: true, host: hostOf(f.url) } : f
      ));
    }
    return out;
  }

  return { SECRET_KEY_GROUPS, TOP_LEVEL_SECRET_KEYS, NESTED_SECRET_KEYS, stripSettingsSecrets };
});
