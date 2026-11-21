'use strict';
// The tickets a vote is spent with: one that came back with an unlock, one asked of the hub for
// an installed entry, and the tickets of everything installed brought up to date a few per
// tick.

const {
  ENTRY_ID_RE, TICKET_MAX, TICKETS_PER_TICK, UNLOCKS_PER_TICK, cleanTime, blankEntry,
} = require('./rating-vote-rules.js');

function makeTickets({ scopedId, deviceId, hub, redeemSaved, now, rvState, load, save, entry, ratingId }) {
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
  // `device` only for a locked entry: the hub then checks this PC already owns it.
  async function askTicket(id, e, wire, voter, device = '') {
    const body = { entryId: id, ratingId: wire, scopedId: voter };
    if (device) body.deviceId = device;
    const out = await hub('/ratings/ticket', body);
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
    if (error === 'needs_unlock') {
      e.locked = true;
      if (out.passOpens === false) e.noPass = true;
      return 'changed';
    }
    if (error === 'already_issued') { e.used = true; return 'changed'; }
    if (error === 'bad_entry') { e.gone = true; return 'changed'; }
    return 'stop';   // offline, or the hub's limits: the next tick tries again
  }

  // A locked entry with no ticket: an owner from before tickets shows the hub the
  // unlock it already holds; failing that, the saved pass is tried once, and only
  // where the hub says a pass can open it (never on a paid or limited entry).
  async function lockedTicket(id, e, wire, voter) {
    if (!e.ownerTried) {
      let device = '';
      try { device = await deviceId(); } catch { /* no id: straight to the pass */ }
      const outcome = device ? await askTicket(id, e, wire, voter, device) : 'changed';
      if (outcome === 'stop') return;   // offline or the hub's limits: next tick
      e.ownerTried = true;
      if (e.ticket || e.votedAt || e.used || e.gone) return;
    }
    if (e.unlockTried) return;
    e.unlockTried = true;
    if (e.noPass) return;
    try { await redeemSaved(id); } catch { /* no pass, or offline: it stays unvotable */ }
  }

  async function syncTickets(list) {
    const wire = await ratingId();
    if (!wire) return false;
    const voter = await scopedId();
    let changed = false;
    let tickets = 0;
    let unlocks = 0;
    for (const id of list.keys()) {
      const e = rvState.state.entries[id] || blankEntry();
      if (e.ticket || e.votedAt || e.used || e.gone) continue;
      if (e.locked) {
        if ((e.ownerTried && e.unlockTried) || unlocks >= UNLOCKS_PER_TICK) continue;
        unlocks += 1;
        changed = true;
        await lockedTicket(id, entry(id), wire, voter);
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

  return { addTicket, syncTickets };
}

module.exports = { makeTickets };
