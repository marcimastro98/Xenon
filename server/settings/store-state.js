// What the engine remembers about the settings file between saves: the id the file was stamped
// with, and the queue that lets one save finish before the next begins.

const settingsStore = {
  // The store id this process has seen on disk. Held so that a write which
  // somehow starts from a blob without one (a writer basing itself on
  // DEFAULT_HUB_SETTINGS before the boot read landed) RE-STAMPS the same id
  // instead of minting a fresh one: rotating it would tell every surface that the
  // store changed, which is precisely when their mirrors are the only remaining
  // copy of the settings. A new id is minted only when this process has never
  // seen one, i.e. a genuinely new store.
  id: '',
  // ── settings store: serialized read-modify-write ────────────────────────────
  // writeFileAtomic serializes the file WRITE, but every settings mutator runs
  // `read prev → merge → write` as separate awaits. Two saves arriving close
  // together from different surfaces (the Xeneon Edge screen, a desktop browser,
  // the native app, an embedded iframe) could both read the SAME prev and the
  // last writer would clobber the other's change — even the merge that keeps the
  // newest per-vital timestamp only defends against a stale INCOMING, not against
  // a stale PREV read during the interleave. That was the "Bit / Vitals out of
  // sync across surfaces" bug (measured: 4 of 5 concurrent refills were lost, and
  // two concurrent saves could even assign the same rev, breaking the monotonic
  // rev the SSE cross-surface sync relies on). Run every settings mutation through
  // this promise-chain mutex so each one observes the previous one's committed
  // result. fn runs after the previous settles (fulfilled OR rejected), and a
  // rejected run never poisons the chain.
  // Its first value is given here, so the lock works whoever loads it.
  writeChain: /** @type {Promise<any>} */ (Promise.resolve()),
};

module.exports = { settingsStore };
