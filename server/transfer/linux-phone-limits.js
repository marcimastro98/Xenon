'use strict';
// How long a pull of the phone book from a paired phone may take on Linux, and how often it is
// asked whether it is done.

const PULL_TIMEOUT_MS = 45000;
const PULL_POLL_MS = 400;

module.exports = { PULL_TIMEOUT_MS, PULL_POLL_MS };
