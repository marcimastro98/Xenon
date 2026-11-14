// What the redeem proxy remembers while the engine runs: this install's id, the trial pass and
// the rating votes it was given.

const redeemState = {
  // ── Install id ───────────────────────────────────────────────────────────────
  // One random UUID per install, persisted in DATA_DIR. Not a secret — just a
  // stable anonymous identifier, and the seed for the scoped ids below. It is
  // LOCAL: nothing sends this value itself to the hub.
  installId: null,
  installIdInflight: null,   // shared promise so concurrent cold reads resolve once
  // ── The running pass trial ───────────────────────────────────────────────────
  // server.js plugs trial-pass.js in here (it depends on this module, so it cannot
  // be required back). With it, a redeem the user typed nothing into uses the trial
  // code while the trial runs, and an XT the hub accepted is remembered there.
  trialPass: null,
  // An unlock that works also carries the entry's rating ticket (rating-votes.js):
  // a locked entry has no other way to one. Never allowed to cost the unlock.
  ratingVotes: null,
};

module.exports = { redeemState };
