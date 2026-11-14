'use strict';
// When Bit may ask for a vote: the time an entry has been on screen counted, the one entry to
// ask about now if the person allows asking at all, and the ask itself.

const {
  WAIT_MS, SEEN_MS, ASK_EVERY_MS, ASKS_PER_ENTRY, STORE_SHOTS, cleanTime, inUse, placedText,
} = require('./rating-vote-rules.js');

function makeAsks({ fileAsk, settings, now, rvState }) {
  // ── Real use, and the one ask ────────────────────────────────
  function countUse(list, elapsed) {
    const s = settings() || {};
    const placed = placedText(s);
    let changed = false;
    for (const [id, tx] of list) {
      const e = rvState.state.entries[id];
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
    if (rvState.state.lastAskAt && t - rvState.state.lastAskAt < ASK_EVERY_MS) return null;
    let best = null;
    for (const id of list.keys()) {
      const e = rvState.state.entries[id];
      if (!e || !e.ticket || e.closed || e.votedAt || e.asked >= ASKS_PER_ENTRY) continue;
      if (t < e.at + WAIT_MS || e.seenMs < SEEN_MS) continue;
      if (!best || e.at < rvState.state.entries[best].at) best = id;
    }
    return best;
  }

  async function ask(list) {
    const id = nextAsk(list);
    if (!id) return false;
    const e = rvState.state.entries[id];
    const tx = list.get(id);
    const t = now();
    e.asked += 1;
    rvState.state.lastAskAt = t;
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

  return { countUse, ask };
}

module.exports = { makeAsks };
