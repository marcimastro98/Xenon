'use strict';
// The rules of a vote on a Store entry: what an entry id, a reason and a ticket may be, the
// waits before Bit may ask, how much is done per tick, the errors that may be shown, and the
// record of one entry cleaned, made blank, listed and told in use.

const ENTRY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
const REASONS = new Set(['breaks', 'slow', 'dislike', 'useless']);
const REASON_MAX_STARS = 3;
const TICKET_MAX = 200;
const MAX_ENTRIES = 300;

const DAY = 24 * 3600 * 1000;
const WAIT_MS = 3 * DAY;              // the hub's RATING_WAIT_SEC
const SEEN_MS = 2 * 3600 * 1000;      // on screen before Bit may ask
const ASK_EVERY_MS = 7 * DAY;
const ASKS_PER_ENTRY = 2;
const TICK_MS = 10 * 60 * 1000;
const FIRST_TICK_MS = 2 * 60 * 1000;
const TICKETS_PER_TICK = 10;
const UNLOCKS_PER_TICK = 3;
const STORE_SHOTS = 'https://assets.xenon-app.com/community/shots/';

// Errors the Store and Bit may show; anything else is 'network'.
const VOTE_ERRORS = new Set(['bad_request', 'bad_entry', 'rate_limited', 'catalog_unavailable', 'update_required']);

const cleanTime = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = {
    at: cleanTime(raw.at),
    seenMs: cleanTime(raw.seenMs),
    stars: Number.isInteger(raw.stars) && raw.stars >= 1 && raw.stars <= 5 ? raw.stars : 0,
    votedAt: cleanTime(raw.votedAt),
    asked: Math.min(ASKS_PER_ENTRY, cleanTime(raw.asked)),
  };
  if (typeof raw.ticket === 'string' && raw.ticket && raw.ticket.length <= TICKET_MAX) e.ticket = raw.ticket;
  for (const flag of ['closed', 'locked', 'used', 'gone', 'unlockTried']) {
    if (raw[flag] === true) e[flag] = true;
  }
  return e;
}

function blankEntry() {
  return { at: 0, seenMs: 0, stars: 0, votedAt: 0, asked: 0 };
}

// Catalog entries with a receipt on this PC. A trial is not owning it.
function ownedEntries(settings) {
  const out = new Map();
  const list = settings && Array.isArray(settings.contentInstalls) ? settings.contentInstalls : [];
  for (const tx of list) {
    if (!tx || tx.source !== 'catalog' || tx.trial === true) continue;
    if (typeof tx.sourceId === 'string' && ENTRY_ID_RE.test(tx.sourceId)) out.set(tx.sourceId, tx);
  }
  return out;
}

// A widget counts while it is placed. What the server cannot check from here (a
// theme, a page, a pack) counts while it is installed and a screen is on.
function inUse(tx, placed) {
  const ids = tx.resources && Array.isArray(tx.resources.widgetIds) ? tx.resources.widgetIds : [];
  return !ids.length || ids.some((id) => placed.includes(id));
}

const placedText = (s) => JSON.stringify([s.dashboardLayout, s.layers]);

module.exports = {
  ENTRY_ID_RE, REASONS, REASON_MAX_STARS, TICKET_MAX, MAX_ENTRIES, DAY, WAIT_MS, SEEN_MS,
  ASK_EVERY_MS, ASKS_PER_ENTRY, TICK_MS, FIRST_TICK_MS, TICKETS_PER_TICK, UNLOCKS_PER_TICK,
  STORE_SHOTS, VOTE_ERRORS, cleanTime, cleanEntry, blankEntry, ownedEntries, inUse, placedText,
};
