'use strict';
// What the Sparks client remembers while the engine runs: its session with the hub and the last
// balance the hub told it.

const creditsState = {
  session: null, // { code, token, exp } in memory only
  lastBalance: null,
};

module.exports = { creditsState };
