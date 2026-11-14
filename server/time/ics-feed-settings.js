'use strict';
// The calendar feeds a user saved: the list cleaned, and each address kept on the PC while only
// its host name goes to the page.

const MAX_FEEDS = 10;

function _safeHostname(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// Validate and normalize an array of feed config objects coming from settings.
// Enforces https-only URLs, caps at MAX_FEEDS entries, assigns palette colours,
// and provides sensible defaults for optional fields.
function normalizeCalendarFeeds(value, palette) {
  if (!Array.isArray(value)) return [];
  const pal = Array.isArray(palette) && palette.length ? palette : ['#1ed760'];
  const out = [];
  for (const item of value) {
    if (out.length >= MAX_FEEDS) break;
    const src = item && typeof item === 'object' ? item : {};
    const url = String(src.url || '').trim().slice(0, 2048);
    if (!/^https:\/\//i.test(url)) continue; // https only — blocks plain http feeds
    const id = String(src.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 80);
    const name = (String(src.name || '').trim().slice(0, 60)) || _safeHostname(url) || 'Calendar';
    const color = pal.includes(src.color) ? src.color : pal[0];
    out.push({
      id, name, url, color,
      reminders: src.reminders !== false,
      enabled: src.enabled !== false,
    });
  }
  return out;
}

// A private iCal link ("secret address" in Google Calendar, a published Outlook
// .ics) IS the credential: anyone holding it reads the whole calendar. So it is
// handled like the API keys — kept on the server, never sent to the browser.
// The wire carries the feed's name, the link's host (so the user can still tell
// feeds apart) and a `urlSet` flag for the "saved" placeholder.
function redactCalendarFeedUrls(settings) {
  if (!settings || typeof settings !== 'object' || !Array.isArray(settings.calendarFeeds)) return settings;
  return {
    ...settings,
    calendarFeeds: settings.calendarFeeds.map((f) => {
      if (!f || typeof f !== 'object') return f;
      const url = String(f.url || '');
      return { ...f, url: '', urlSet: !!url, host: url ? _safeHostname(url) : (f.host || '') };
    }),
  };
}

// The other half: a client that only received the redacted list posts each feed
// back with a blank url. Refill it from the stored feed with the same id, so a
// routine save (renaming a feed, toggling reminders) never drops the link. A
// feed whose url the client did fill in keeps the new one. Mutates and returns
// `incoming`, like the other preserve helpers.
function preserveCalendarFeedUrls(incoming, prev) {
  if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.calendarFeeds)) return incoming;
  const prevFeeds = (prev && typeof prev === 'object' && Array.isArray(prev.calendarFeeds)) ? prev.calendarFeeds : [];
  const byId = new Map();
  for (const f of prevFeeds) if (f && f.id && f.url) byId.set(String(f.id), f.url);
  incoming.calendarFeeds = incoming.calendarFeeds.map((f) => {
    if (!f || typeof f !== 'object' || String(f.url || '').trim()) return f;
    const saved = byId.get(String(f.id || ''));
    return saved ? { ...f, url: saved } : f;
  });
  return incoming;
}

module.exports = {
  MAX_FEEDS, _safeHostname, normalizeCalendarFeeds, redactCalendarFeedUrls,
  preserveCalendarFeedUrls,
};
