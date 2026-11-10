'use strict';
// Votes on what came from the Store: this PC's half of the hub's rating tickets
// (xenon-supporter-hub/src/rating-tickets.js). Keeps one small record per entry in
// DATA_DIR and decides when, at most, Bit may ask for a vote.
//
//   - A ticket is asked for when a catalog receipt appears, only with catalogStats
//     on: it tells the hub this PC has that entry. The hub keeps no list of that,
//     but the switch is what the person agreed to.
//   - A locked entry has no public ticket. It rides on the unlock (redeem, buy);
//     owners from before tickets get it through their saved pass, once.
//   - A vote spends the ticket. The stars stay here so the Store can say what was
//     given; the hub refuses a second vote whatever this file says.
//   - Bit asks about something in real use: the ticket open (three days), hours on
//     screen, one ask a week over everything, and closing a card ends it for that
//     entry. A card nobody touched may come back once.
//
// The wire id is a hash of the machine's own id (pc-id.js), so reinstalling Xenon
// is not a new voter. Losing this file loses the ticket, not the limit: the hub
// answers already_issued and the entry shows as used.

const fs = require('fs');
const { writeFileAtomic } = require('./atomic-write');

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

function createRatingVotes({
  file, pcId, scopedId, hub, redeemSaved = async () => null, fileAsk = async () => {},
  settings = () => ({}), watching = () => true, onVoted = () => {}, now = Date.now, log = console,
}) {
  let state = null;
  let loading = null;
  let saving = Promise.resolve();
  let timer = 0;
  let first = 0;
  let ticking = false;
  let lastTick = 0;
  const voting = new Set();

  async function load() {
    if (state) return state;
    if (!loading) {
      loading = (async () => {
        let raw = null;
        try {
          raw = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        } catch (e) {
          if (e.code !== 'ENOENT') log.warn('[rating-votes] unreadable store, starting empty:', e.message);
        }
        const entries = {};
        const stored = raw && raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
        for (const [id, value] of Object.entries(stored).slice(0, MAX_ENTRIES)) {
          const e = ENTRY_ID_RE.test(id) ? cleanEntry(value) : null;
          if (e) entries[id] = e;
        }
        state = { lastAskAt: raw ? cleanTime(raw.lastAskAt) : 0, entries };
        return state;
      })().finally(() => { loading = null; });
    }
    return loading;
  }

  function save() {
    saving = saving
      .then(() => writeFileAtomic(file, JSON.stringify({ v: 1, ...state })))
      .catch((e) => log.warn('[rating-votes] could not save:', e.message));
    return saving;
  }

  function entry(id) {
    if (!state.entries[id]) state.entries[id] = blankEntry();
    return state.entries[id];
  }

  const statsOn = () => (settings() || {}).catalogStats === true;

  // The id for the hub, or '' with the stats switch off.
  async function ratingId() {
    if (!statsOn()) return '';
    try { return await pcId(); } catch { return ''; }
  }

  // A ticket that came back with an unlock.
  async function addTicket(entryId, ticket, atSec) {
    if (!ENTRY_ID_RE.test(String(entryId)) || typeof ticket !== 'string' || !ticket || ticket.length > TICKET_MAX) return false;
    await load();
    const e = entry(entryId);
    if (e.votedAt || e.ticket) return false;
    e.ticket = ticket;
    e.at = (cleanTime(atSec) * 1000) || now();
    delete e.used;
    await save();
    return true;
  }

  // ── Tickets for what is installed ────────────────────────────
  async function askTicket(id, e, wire, voter) {
    const out = await hub('/ratings/ticket', { entryId: id, ratingId: wire, scopedId: voter });
    if (out && out.ok === true && typeof out.ticket === 'string') {
      e.ticket = out.ticket.slice(0, TICKET_MAX);
      e.at = (cleanTime(out.at) * 1000) || now();
      return 'changed';
    }
    if (out && out.ok === true && Number.isInteger(out.voted)) {
      e.stars = out.voted >= 1 && out.voted <= 5 ? out.voted : 0;
      e.votedAt = now();
      return 'changed';
    }
    const error = out && out.error;
    if (error === 'needs_unlock') { e.locked = true; return 'changed'; }
    if (error === 'already_issued') { e.used = true; return 'changed'; }
    if (error === 'bad_entry') { e.gone = true; return 'changed'; }
    return 'stop';   // offline, or the hub's limits: the next tick tries again
  }

  async function syncTickets(list) {
    const wire = await ratingId();
    if (!wire) return false;
    const voter = await scopedId();
    let changed = false;
    let tickets = 0;
    let unlocks = 0;
    for (const id of list.keys()) {
      const e = state.entries[id] || blankEntry();
      if (e.ticket || e.votedAt || e.used || e.gone) continue;
      if (e.locked) {
        if (e.unlockTried || unlocks >= UNLOCKS_PER_TICK) continue;
        unlocks += 1;
        entry(id).unlockTried = true;
        changed = true;
        try { await redeemSaved(id); } catch { /* no pass, or offline: it stays unvotable */ }
        continue;
      }
      if (tickets >= TICKETS_PER_TICK) break;
      tickets += 1;
      const outcome = await askTicket(id, entry(id), wire, voter);
      if (outcome === 'stop') break;
      changed = true;
    }
    return changed;
  }

  // ── Real use, and the one ask ────────────────────────────────
  function countUse(list, elapsed) {
    const s = settings() || {};
    const placed = placedText(s);
    let changed = false;
    for (const [id, tx] of list) {
      const e = state.entries[id];
      if (!e || !e.ticket || e.seenMs >= SEEN_MS || !inUse(tx, placed)) continue;
      e.seenMs += elapsed;
      changed = true;
    }
    return changed;
  }

  function nextAsk(list) {
    const s = settings() || {};
    if (s.ratingAsks === false || s.catalogStats !== true) return null;
    const t = now();
    if (state.lastAskAt && t - state.lastAskAt < ASK_EVERY_MS) return null;
    let best = null;
    for (const id of list.keys()) {
      const e = state.entries[id];
      if (!e || !e.ticket || e.closed || e.votedAt || e.asked >= ASKS_PER_ENTRY) continue;
      if (t < e.at + WAIT_MS || e.seenMs < SEEN_MS) continue;
      if (!best || e.at < state.entries[best].at) best = id;
    }
    return best;
  }

  async function ask(list) {
    const id = nextAsk(list);
    if (!id) return false;
    const e = state.entries[id];
    const tx = list.get(id);
    const t = now();
    e.asked += 1;
    state.lastAskAt = t;
    await fileAsk({
      id: `rate:${id}:${e.asked}`,
      kind: 'rate',
      at: t,
      title: tx.name || id,
      entryId: id,
      since: cleanTime(tx.installedAt) || e.at,
      expires: t + ASK_EVERY_MS,
      media: { type: 'image', url: `${STORE_SHOTS}${id}.webp` },
    });
    return true;
  }

  async function tick() {
    if (ticking || !watching()) return;
    ticking = true;
    try {
      await load();
      const t = now();
      const elapsed = lastTick ? Math.min(t - lastTick, TICK_MS * 2) : 0;
      lastTick = t;
      const list = ownedEntries(settings() || {});
      let changed = elapsed > 0 && countUse(list, elapsed);
      if (statsOn()) changed = (await syncTickets(list)) || changed;
      changed = (await ask(list)) || changed;
      if (changed) await save();
    } catch (e) {
      log.warn('[rating-votes] tick failed:', e.message);
    } finally {
      ticking = false;
    }
  }

  // ── The Store page, the card, Bit ────────────────────────────
  async function stateOf(entryId) {
    const id = String(entryId || '');
    if (!ENTRY_ID_RE.test(id)) return { ok: false, error: 'bad_request' };
    await load();
    const e = state.entries[id] || blankEntry();
    if (e.votedAt) return { ok: true, state: 'voted', stars: e.stars };
    if (!ownedEntries(settings() || {}).has(id)) return { ok: true, state: 'none' };
    if (e.used) return { ok: true, state: 'used' };
    if (!statsOn()) return { ok: true, state: 'off' };
    if (e.locked && !e.ticket) return { ok: true, state: e.unlockTried ? 'locked' : 'wait', ripeAt: now() + WAIT_MS };
    if (!e.ticket) return { ok: true, state: 'wait', ripeAt: now() + WAIT_MS };
    const ripeAt = e.at + WAIT_MS;
    return now() < ripeAt ? { ok: true, state: 'wait', ripeAt } : { ok: true, state: 'open' };
  }

  async function vote({ entryId, stars, why }) {
    const id = String(entryId || '');
    const n = Number(stars);
    if (!ENTRY_ID_RE.test(id) || !Number.isInteger(n) || n < 1 || n > 5) return { ok: false, error: 'bad_request' };
    await load();
    const e = state.entries[id];
    if (e && e.votedAt) return { ok: false, error: 'already_voted' };
    if (!e || !e.ticket) return { ok: false, error: 'no_ticket' };
    if (voting.has(id)) return { ok: false, error: 'rate_limited' };
    voting.add(id);
    try {
      const body = { entryId: id, ticket: e.ticket, stars: n };
      if (n <= REASON_MAX_STARS && REASONS.has(why)) body.why = why;
      const out = await hub('/ratings', body);
      if (out && out.ok === true) {
        e.stars = n;
        e.votedAt = now();
        delete e.ticket;
        await save();
        onVoted(id);
        return { ok: true };
      }
      const error = out && out.error;
      if (error === 'too_soon') return { ok: false, error, ripeAt: cleanTime(out.ripeAt) * 1000 };
      if (error === 'already_voted') {
        e.votedAt = now();
        delete e.ticket;
        await save();
        onVoted(id);
        return { ok: false, error };
      }
      if (error === 'bad_ticket') {
        delete e.ticket;
        e.used = true;
        await save();
        return { ok: false, error };
      }
      return { ok: false, error: VOTE_ERRORS.has(error) ? error : 'network' };
    } finally {
      voting.delete(id);
    }
  }

  // The X on the card: Bit never asks about this one again. The Store still can.
  async function close(entryId) {
    const id = String(entryId || '');
    if (!ENTRY_ID_RE.test(id)) return { ok: false, error: 'bad_request' };
    await load();
    entry(id).closed = true;
    await save();
    return { ok: true };
  }

  function start() {
    if (timer) return;
    first = setTimeout(tick, FIRST_TICK_MS);
    timer = setInterval(tick, TICK_MS);
    if (first.unref) first.unref();
    if (timer.unref) timer.unref();
  }

  function stop() {
    clearTimeout(first);
    clearInterval(timer);
    first = 0;
    timer = 0;
  }

  const flush = () => saving;

  return { start, stop, flush, tick, stateOf, vote, close, addTicket, ratingId };
}

module.exports = { createRatingVotes, ownedEntries, inUse, WAIT_MS, SEEN_MS, ASK_EVERY_MS, ASKS_PER_ENTRY };
