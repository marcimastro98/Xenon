'use strict';
// The paired phone's limits: how long each pull is kept, how soon it may be asked again, how
// many rows are kept, and how long the helper is given.

const RETRY_MS = 20 * 1000;          // after a host death, before trying again
const REQ_TIMEOUT_MS = 30 * 1000;    // a Bluetooth pull is slow, but not this slow
const CONTACTS_TTL_MS = 30 * 60 * 1000;
const CALLS_TTL_MS = 2 * 60 * 1000;
// The floor under a FORCED refresh. Two jobs, and the second is the important
// one: it keeps the read endpoints from being a way to pump the Bluetooth
// channel. A cross-site request cannot read the JSON that comes back, but it
// could still ask for `?refresh=1` in a loop and keep the phone's phonebook
// server busy — which is a channel other software on the machine also wants.
// With a floor, that attack degrades to "serves the cache", so these stay
// ordinary reads instead of needing a mutation guard.
const REFRESH_MIN_MS = 10 * 1000;
const STATUS_TTL_MS = 15 * 1000;
const MAX_CONTACTS = 2000;
const MAX_CALLS = 100;
const MESSAGES_TTL_MS = 60 * 1000;
const MAX_MESSAGES = 40;
// Longer than any SMS and short enough to travel in one OBEX packet, which is
// what the helper's single-packet PUT requires. Checked here as well as there.
const MAX_MESSAGE_CHARS = 1000;

module.exports = {
  RETRY_MS, REQ_TIMEOUT_MS, CONTACTS_TTL_MS, CALLS_TTL_MS, REFRESH_MIN_MS, STATUS_TTL_MS,
  MAX_CONTACTS, MAX_CALLS, MESSAGES_TTL_MS, MAX_MESSAGES, MAX_MESSAGE_CHARS,
};
