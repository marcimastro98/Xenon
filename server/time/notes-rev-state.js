// The number of the last saved notes and the queue their saves wait in.

const notesRev = {
  // Monotonic notes revision — every write bumps it and every read/broadcast
  // carries it. A save posts the rev it was based on (baseRev), so a stale
  // surface (one that missed newer broadcasts — dead SSE, or the beforeunload
  // beacon of a long-idle page) can't clobber fresher content (GitHub #72).
  // Lazily seeded from the persisted store so it survives restarts. Tasks and
  // calendar events keep last-writer-wins on purpose: only notes had the
  // reported cross-surface clobber, and their edits are append-mostly.
  rev: -1, // -1 = not yet loaded from disk
  // Guarded save, serialized: the baseRev check and the rev bump inside
  // writeNotes must not interleave across awaits, or two concurrent saves with
  // the same baseRev would BOTH pass the guard and one silently clobber the
  // other — the exact lost update the guard exists to refuse.
  // Its first value is given here, so the store works whoever loads it.
  saveChain: /** @type {Promise<unknown>} */ (Promise.resolve()),
};

module.exports = { notesRev };
