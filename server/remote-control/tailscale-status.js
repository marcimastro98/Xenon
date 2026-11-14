'use strict';
// Reads what the Tailscale program says: the status of this PC on its network, its name there,
// a sign-in link, whether certificates are on, and whether an error means a missing right.

// On Linux tailscaled's local API socket is root-owned, so `up` and `cert` fail
// for a normal user until `sudo tailscale set --operator=$USER` is run once. That
// is a real, fixable situation with an exact remedy, and it must not be reported
// as "Tailscale is broken" — nor may Xenon paper over it by reaching for sudo,
// which would put a password prompt behind a toggle in a dashboard. So it gets
// its own reason and the UI prints the command.
const PERMISSION_RE = /access denied|permission denied|must be run as root|operator|Operation not permitted/i;
function isPermissionError(msg) {
  return PERMISSION_RE.test(String(msg || ''));
}

// A MagicDNS name of this machine, e.g. `mypc.tail1234.ts.net`. This value ends
// up as an ACCEPTED Host header on the HTTPS door (see remote-access.js), so it
// is shape-validated here even though it comes from the local tailscaled rather
// than from the wire — the codebase validates where data ENTERS, and a name that
// will gate requests is exactly that kind of boundary.
const DNS_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

// tailscaled's word for "no client has ever started this backend". It is the
// state a Windows service sits in with no GUI attached, and the reason it needs
// its own name is that it is indistinguishable from a healthy daemon through
// every other field: `status --json` answers, the tunnel adapter is up, the
// preferences are on disk with WantRunning true, and nothing is logged.
const NO_BACKEND = 'NoState';

/** Trailing-dot-stripped, lowercased, validated — or '' when it is not a name. */
function normalizeDnsName(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
  return s.length <= 253 && DNS_NAME_RE.test(s) ? s : '';
}

/**
 * Pure parser for `tailscale status --json`, exported for the tests.
 *
 * `running` vs `installed` is the distinction the old version collapsed: it
 * reported `installed: false` whenever the command failed, so a machine with
 * Tailscale installed and its service merely STOPPED was indistinguishable from
 * one that never had it — and those two states need opposite instructions from
 * the UI ("install it" vs "start it"). Installation is a file check now; this
 * function only answers what the daemon said. With the daemon down the CLI
 * prints a plain-text error instead of JSON, which is why the JSON parse rather
 * than the exit code is the test.
 */
function parseStatus(stdout) {
  let data = null;
  try { data = JSON.parse(String(stdout || '')); } catch { data = null; }
  if (!data || typeof data !== 'object' || typeof data.BackendState !== 'string') {
    return { running: false, connected: false, backendState: '', ip: '', dnsName: '', certDomains: [], authUrl: '' };
  }
  const self = (data.Self && typeof data.Self === 'object') ? data.Self : {};
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  return {
    running: true,
    connected: data.BackendState === 'Running',
    // Kept raw, because `connected` collapses every not-Running value into one
    // and they do not mean the same thing. `NeedsLogin` is a browser sign-in
    // waiting to happen; NO_BACKEND is a daemon that has not been started by any
    // client and never will be on its own. Treating the second as the first is
    // what made this feature sit for five minutes and then blame the sign-in.
    backendState: data.BackendState,
    // The v4 address. The v6 one is equally real, but every URL we hand a person
    // has to be typeable and QR-scannable, and a bracketed v6 literal is neither.
    ip: ips.find((v) => typeof v === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(v)) || '',
    dnsName: normalizeDnsName(self.DNSName),
    // null until HTTPS certificates are enabled for the whole tailnet in the
    // admin console — a per-TAILNET switch nothing on this machine can flip, so
    // the UI has to say so precisely instead of reporting a generic failure.
    certDomains: Array.isArray(data.CertDomains) ? data.CertDomains.filter((d) => typeof d === 'string') : [],
    // Where the user has to go to finish signing in. tailscaled publishes it
    // here while it waits, and on Windows the GUI client opens it for them —
    // which is why nothing off Windows did: `tailscale up` only PRINTS the URL,
    // and the panel sat on "waiting for you to complete sign-in" without ever
    // saying where. Only trusted over https://login.tailscale.com so a
    // malformed status can never turn into a link we hand somebody.
    authUrl: safeAuthUrl(data.AuthURL),
  };
}

const AUTH_URL_RE = /^https:\/\/login\.tailscale\.com\/[\w./-]*$/;
function safeAuthUrl(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return AUTH_URL_RE.test(s) ? s : '';
}

/** Whether this tailnet will actually issue a certificate for `fqdn`. */
function certsEnabledFor(certDomains, fqdn) {
  const want = normalizeDnsName(fqdn);
  if (!want) return false;
  return (certDomains || []).some((d) => normalizeDnsName(d) === want);
}

module.exports = {
  PERMISSION_RE, isPermissionError, DNS_NAME_RE, NO_BACKEND, normalizeDnsName, parseStatus,
  AUTH_URL_RE, safeAuthUrl, certsEnabledFor,
};
