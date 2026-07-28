'use strict';

// The T2 transport: a SECOND listener, speaking TLS, on this machine's Tailscale
// address, using the Let's Encrypt certificate tailscaled holds for its MagicDNS
// name. It exists because a browser withholds a whole class of capability from a
// page that is not in a "secure context" — installable PWA, service worker,
// getUserMedia, Web Push — and `http://<lan-ip>:3030` is not one however much we
// would like it to be. That is the actual constraint behind T2; the UI was never
// the problem.
//
// Three decisions worth keeping, because each had a plausible alternative:
//
// 1. WE terminate the TLS, rather than `tailscale serve` doing it for us. Serve
//    is far less code and it collapses the security model: the proxied request
//    reaches us from 127.0.0.1, which is the LOOPBACK door — the one that asks
//    for no pairing at all — so every machine in the tailnet would hold the
//    dashboard. The only way to tell a proxied request apart would be to trust a
//    forwarded header, which anything that can already reach loopback can forge.
//
// 2. This listener is EXCLUSIVELY the paired-device door: it never consults
//    `isAllowedRequest()`. Not an optimisation — the loopback door refuses this
//    listener's Host anyway (a name, not a loopback literal), so mixing them
//    would only produce a 403 nobody can act on when the user opens the HTTPS
//    URL on the PC itself. One listener, one door, one rule.
//
// 3. It binds to the Tailscale address ONLY, not to 0.0.0.0. The LAN already has
//    its own door on its own port; a second listener answering on every
//    interface would be a second way in that nobody asked for.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

// Not 443: binding a privileged port is a fight we do not need, other software
// takes it, and the pairing URL is delivered as a QR code — nobody types it.
const DEFAULT_PORT = 3443;
// Let's Encrypt certificates last 90 days and tailscaled renews on its own
// schedule when asked; asking daily is cheap, rate-limit-free (it reuses a fresh
// cert) and leaves 89 days of slack for a machine that was off for a while.
const RENEW_INTERVAL_MS = 24 * 3600 * 1000;

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
  if (!s.connected) return 'not_logged_in';
  if (!s.dnsName) return 'no_name';
  if (!s.certsEnabled) return 'certs_disabled';
  return 'ready';
}

function createRemoteHttps({ tailscale, dataDir, handler, port = DEFAULT_PORT, log = () => {} } = {}) {
  const certDir = path.join(dataDir, 'tls');
  let server = null;
  let renewTimer = null;
  let state = { running: false, reason: 'idle', host: '', ip: '', url: '', since: 0 };

  const paths = (host) => ({
    certFile: path.join(certDir, host + '.crt'),
    keyFile: path.join(certDir, host + '.key'),
  });

  /** Provision or renew, then read the pair back. Never throws. */
  async function ensureCert(host) {
    await fs.promises.mkdir(certDir, { recursive: true }).catch(() => {});
    const { certFile, keyFile } = paths(host);
    const r = await tailscale.cert(host, { certFile, keyFile });
    if (!r.ok) {
      // A previously-written pair is still valid for up to 90 days, so a failed
      // renewal must not take the door down — it is only fatal when we have
      // nothing on disk to fall back to.
      const have = await fs.promises.access(certFile).then(() => true, () => false);
      if (!have) return { ok: false, reason: r.reason || 'failed', error: r.error };
      log('[https] certificate refresh failed (' + r.reason + '), keeping the one on disk');
    }
    try {
      const [cert, key] = await Promise.all([
        fs.promises.readFile(certFile),
        fs.promises.readFile(keyFile),
      ]);
      return { ok: true, cert, key };
    } catch (e) {
      return { ok: false, reason: 'unreadable', error: e.message };
    }
  }

  async function start() {
    if (server) return { ok: true, ...state };
    const status = await tailscale.getStatus().catch(() => ({}));
    const reason = readiness(status);
    if (reason !== 'ready') {
      state = { ...state, running: false, reason };
      return { ok: false, reason };
    }
    const host = status.dnsName;
    const got = await ensureCert(host);
    if (!got.ok) {
      state = { ...state, running: false, reason: got.reason };
      return { ok: false, reason: got.reason, error: got.error };
    }

    // createServer parses the PEM and THROWS synchronously on anything it cannot
    // read — a truncated write, a half-copied file, a key that does not match
    // its certificate. Caught here because the only alternative is an exception
    // escaping a background sync with a raw OpenSSL string ("PEM routines: no
    // start line") in place of anything the user could act on.
    try {
      server = https.createServer({ cert: got.cert, key: got.key }, handler);
    } catch (e) {
      server = null;
      state = { ...state, running: false, reason: 'bad_cert' };
      return { ok: false, reason: 'bad_cert', error: e.message };
    }
    // A socket that connects and says nothing holds a handle open; the plain
    // server sets its own timeouts and this one must not be the exception.
    server.headersTimeout = 20000;
    server.requestTimeout = 0;         // long-lived SSE streams live here too

    const listened = await new Promise((resolve) => {
      const onErr = (e) => { server.removeListener('listening', onOk); resolve({ ok: false, error: e.message, code: e.code }); };
      const onOk = () => { server.removeListener('error', onErr); resolve({ ok: true }); };
      server.once('error', onErr);
      server.once('listening', onOk);
      // The Tailscale address only — see decision 3 at the top.
      try { server.listen(port, status.ip); } catch (e) { onErr(e); }
    });
    if (!listened.ok) {
      try { server.close(); } catch { /* never listened */ }
      server = null;
      state = { ...state, running: false, reason: listened.code === 'EADDRINUSE' ? 'port_busy' : 'listen_failed' };
      return { ok: false, reason: state.reason, error: listened.error };
    }
    // Errors AFTER listening (a peer resetting mid-handshake is routine) must not
    // reach the process-level handler and take the whole server down.
    server.on('error', (e) => log('[https] ' + e.message));
    server.on('tlsClientError', () => {});

    state = {
      running: true, reason: 'ready', host, ip: status.ip,
      url: 'https://' + host + ':' + port, since: Date.now(),
    };
    log('[https] paired-device door up on ' + state.url);
    renewTimer = setInterval(() => { renew().catch(() => {}); }, RENEW_INTERVAL_MS);
    if (renewTimer.unref) renewTimer.unref();
    return { ok: true, ...state };
  }

  /**
   * Swap the certificate under a LIVE listener. `setSecureContext` exists for
   * exactly this: restarting would drop every open SSE stream, so a renewal that
   * the user notices is a renewal done wrong.
   */
  async function renew() {
    if (!server || !state.host) return { ok: false, reason: 'not_running' };
    const got = await ensureCert(state.host);
    if (!got.ok) return { ok: false, reason: got.reason };
    // Throws on an unreadable PEM exactly as createServer does. A failed swap
    // leaves the PREVIOUS context in place, which is the right outcome: the door
    // stays open on the certificate that was working.
    try { server.setSecureContext({ cert: got.cert, key: got.key }); }
    catch (e) { return { ok: false, reason: 'bad_cert', error: e.message }; }
    log('[https] certificate renewed');
    return { ok: true };
  }

  async function stop() {
    if (renewTimer) { clearInterval(renewTimer); renewTimer = null; }
    const s = server;
    server = null;
    state = { ...state, running: false, reason: 'stopped', url: '' };
    if (!s) return;
    await new Promise((resolve) => {
      const done = setTimeout(resolve, 2000);
      s.close(() => { clearTimeout(done); resolve(); });
      // close() waits for open connections, and SSE streams never end on their
      // own. Shutdown is not the moment to be polite about it.
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
    });
  }

  function status() { return { ...state, port }; }

  return { start, stop, renew, status, readiness: () => state.reason };
}

module.exports = { createRemoteHttps, readiness, DEFAULT_PORT, RENEW_INTERVAL_MS };
