'use strict';
// Votes on what came from the Store: this PC's half of the hub's rating tickets
// (xenon-supporter-hub/src/rating-tickets.js). Keeps one small record per entry in
// DATA_DIR and decides when, at most, Bit may ask for a vote.
//
//   - A ticket is asked for when a catalog receipt appears, only with catalogStats
//     on: it tells the hub this PC has that entry. The hub keeps no list of that,
//     but the switch is what the person agreed to.
//   - A locked entry has no public ticket. It rides on the unlock (redeem, buy);
//     owners from before tickets show the hub the unlock it already holds for this
//     PC, then try their saved pass once where a pass can open the entry.
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
const { writeFileAtomic } = require('../files/atomic-write');

const {
  ENTRY_ID_RE, REASONS, REASON_MAX_STARS, MAX_ENTRIES, WAIT_MS, SEEN_MS, ASK_EVERY_MS,
  ASKS_PER_ENTRY, TICK_MS, FIRST_TICK_MS, VOTE_ERRORS, cleanTime, cleanEntry, blankEntry,
  ownedEntries, inUse,
} = require('./rating-vote-rules.js');


const { makeAsks } = require('./rating-vote-asks.js');

const { makeTickets } = require('./rating-vote-tickets.js');

function createRatingVotes({
  file, pcId, scopedId, deviceId = async () => '', hub, redeemSaved = async () => null, fileAsk = async () => {},
  settings = () => ({}), watching = () => true, onVoted = () => {}, now = Date.now, log = console,
}) {
  const rvState = {
    state: null,
    loading: null,
    saving: undefined, // given its first value further down, where it was declared
    timer: 0,
    first: 0,
    ticking: false,
    lastTick: 0,
  };
  rvState.saving = Promise.resolve();
  const voting = new Set();

  async function load() {
    if (rvState.state) return rvState.state;
    if (!rvState.loading) {
      rvState.loading = (async () => {
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
        rvState.state = { lastAskAt: raw ? cleanTime(raw.lastAskAt) : 0, entries };
        return rvState.state;
      })().finally(() => { rvState.loading = null; });
    }
    return rvState.loading;
  }

  function save() {
    rvState.saving = rvState.saving
      .then(() => writeFileAtomic(file, JSON.stringify({ v: 1, ...rvState.state })))
      .catch((e) => log.warn('[rating-votes] could not save:', e.message));
    return rvState.saving;
  }

  function entry(id) {
    if (!rvState.state.entries[id]) rvState.state.entries[id] = blankEntry();
    return rvState.state.entries[id];
  }

  const statsOn = () => (settings() || {}).catalogStats === true;

  // The id for the hub, or '' with the stats switch off.
  async function ratingId() {
    if (!statsOn()) return '';
    try { return await pcId(); } catch { return ''; }
  }

  const {
    addTicket, syncTickets,
  } = makeTickets({ scopedId, deviceId, hub, redeemSaved, now, rvState, load, save, entry, ratingId });

  const { countUse, ask } = makeAsks({ fileAsk, settings, now, rvState });

  async function tick() {
    if (rvState.ticking || !watching()) return;
    rvState.ticking = true;
    try {
      await load();
      const t = now();
      const elapsed = rvState.lastTick ? Math.min(t - rvState.lastTick, TICK_MS * 2) : 0;
      rvState.lastTick = t;
      const list = ownedEntries(settings() || {});
      let changed = elapsed > 0 && countUse(list, elapsed);
      if (statsOn()) changed = (await syncTickets(list)) || changed;
      changed = (await ask(list)) || changed;
      if (changed) await save();
    } catch (e) {
      log.warn('[rating-votes] tick failed:', e.message);
    } finally {
      rvState.ticking = false;
    }
  }

  // ── The Store page, the card, Bit ────────────────────────────
  async function stateOf(entryId) {
    const id = String(entryId || '');
    if (!ENTRY_ID_RE.test(id)) return { ok: false, error: 'bad_request' };
    await load();
    const e = rvState.state.entries[id] || blankEntry();
    if (e.votedAt) return { ok: true, state: 'voted', stars: e.stars };
    if (!ownedEntries(settings() || {}).has(id)) return { ok: true, state: 'none' };
    if (e.used) return { ok: true, state: 'used' };
    if (!statsOn()) return { ok: true, state: 'off' };
    if (e.locked && !e.ticket) return { ok: true, state: e.ownerTried && e.unlockTried ? 'locked' : 'wait', ripeAt: now() + WAIT_MS };
    if (!e.ticket) return { ok: true, state: 'wait', ripeAt: now() + WAIT_MS };
    const ripeAt = e.at + WAIT_MS;
    return now() < ripeAt ? { ok: true, state: 'wait', ripeAt } : { ok: true, state: 'open' };
  }

  async function vote({ entryId, stars, why }) {
    const id = String(entryId || '');
    const n = Number(stars);
    if (!ENTRY_ID_RE.test(id) || !Number.isInteger(n) || n < 1 || n > 5) return { ok: false, error: 'bad_request' };
    await load();
    const e = rvState.state.entries[id];
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
    if (rvState.timer) return;
    rvState.first = setTimeout(tick, FIRST_TICK_MS);
    rvState.timer = setInterval(tick, TICK_MS);
    if (rvState.first.unref) rvState.first.unref();
    if (rvState.timer.unref) rvState.timer.unref();
  }

  function stop() {
    clearTimeout(rvState.first);
    clearInterval(rvState.timer);
    rvState.first = 0;
    rvState.timer = 0;
  }

  const flush = () => rvState.saving;

  return { start, stop, flush, tick, stateOf, vote, close, addTicket, ratingId };
}

module.exports = { createRatingVotes, ownedEntries, inUse, WAIT_MS, SEEN_MS, ASK_EVERY_MS, ASKS_PER_ENTRY };
