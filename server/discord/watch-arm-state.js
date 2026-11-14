// Which Discord sign-in the watch is held for, and whether it is being set up or must be set up
// again.

const discordArm = {
  login: '',
  arming: false,   // serialize refreshes (status() is async)
  dirty: false,    // a refresh arrived mid-flight → re-evaluate
};

module.exports = { discordArm };
