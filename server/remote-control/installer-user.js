'use strict';
// The account the server runs as, in the shell-safe shape a user name has, or nothing.

const os = require('node:os');

// The account the server runs as, which is the one that needs to be able to
// drive tailscaled. Sanitised to the shell-safe shape a username has anyway,
// because this value is interpolated into an elevated command line; anything
// unexpected yields '' and the operator step is simply skipped.
function currentUser() {
  let name = '';
  try { name = os.userInfo().username || ''; } catch { name = process.env.USER || ''; }
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : '';
}

module.exports = { currentUser };
