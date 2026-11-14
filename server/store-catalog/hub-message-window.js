'use strict';
// Says which of the hub's messages are showing today: each one's first and last day.

// A bare YYYY-MM-DD parses to midnight UTC. That is what "starts on" means, but
// it is the opposite of what "until" means: a date picker set to 1 August is read
// by everyone as "through 1 August", not "ends the moment 1 August begins", and
// taking it literally silently drops the campaign's whole last day. So an
// end-date with no time is stretched to the end of that day; one WITH a time is
// left exactly as written, because then the author said when they meant.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function endOfWindow(value) {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return NaN;
  return DATE_ONLY_RE.test(value) ? t + (24 * 3600 * 1000) - 1 : t;
}

// Date-window filter, applied at SERVE time off the cached list (same as the
// catalog) so a message starts and retires on schedule without a re-fetch.
function filterVisibleMessages(messages, now) {
  if (!Array.isArray(messages)) return [];
  return messages.filter((m) => {
    if (m.activeFrom) {
      const from = Date.parse(m.activeFrom);
      if (Number.isFinite(from) && now < from) return false;
    }
    if (m.activeUntil) {
      const until = endOfWindow(m.activeUntil);
      if (Number.isFinite(until) && now > until) return false;
    }
    return true;
  });
}

module.exports = { DATE_ONLY_RE, endOfWindow, filterVisibleMessages };
