'use strict';
// Why the HTTPS door for paired devices is not up, as one of a few reasons the settings page
// turns into a sentence.

const { NO_BACKEND } = require('../remote-control/tailscale.js');

/**
 * Why the HTTPS door is not up, as one of a small set of reasons the UI can turn
 * into a sentence. Kept as a pure function so the wording lives in the client and
 * the DECISION lives here, testable without a network.
 *
 * The distinction that matters: `certs_disabled` is the only one the user fixes
 * somewhere other than this machine (the tailnet admin console), and it is
 * invisible from the CLI unless you ask for it — `tailscale cert` answers with a
 * bare "500 Internal Server Error: your Tailscale account does not support
 * getting TLS certs", which reads like a broken account rather than a switch
 * nobody turned on.
 */
function readiness(status) {
  const s = status || {};
  if (!s.installed) return 'not_installed';
  // Checked before `not_running`, which is what this looks like from the outside
  // and is the wrong thing to tell someone: the daemon is running fine, it is
  // this user that may not talk to its socket. Off Windows only, and one command
  // fixes it.
  if (s.needsOperator) return 'needs_operator';
  if (!s.running) return 'not_running';
  // Checked before `not_logged_in`, for the same reason `needs_operator` is
  // checked before `not_running`: it is what this looks like from the outside
  // and it is the wrong thing to say. A daemon with no client attached reports
  // itself as neither signed out nor connected — measured on Windows with the
  // service up and no tray app, on an account that WAS signed in. Telling that
  // user to sign in sends them looking for a login screen that will not appear,
  // and hides the one thing they can do about it.
  if (s.backendState === NO_BACKEND) return 'no_backend';
  if (!s.connected) return 'not_logged_in';
  if (!s.dnsName) return 'no_name';
  if (!s.certsEnabled) return 'certs_disabled';
  return 'ready';
}

module.exports = { readiness };
