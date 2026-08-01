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
// Imported rather than spelled again, so this module and the setup cannot
// disagree about what tailscaled's "no client has started me" state is called.
const { NO_BACKEND } = require('./remote-control/tailscale');

// The door comes up in a RACE, and one attempt is not enough to win it. On
// Windows the Tailscale SERVICE starts with the machine while its tray app
// starts with the SESSION, and until that app attaches, the daemon answers
// NO_BACKEND — so the single attempt a few seconds after boot asks the one
// question whose answer is still "not yet". Reported from a user's Windows 11
// machine and reproducible by construction: after every reboot the door stayed
// down, the panel went on printing `no_backend` long after Tailscale had come
// up (the reason was the boot attempt's, frozen), and the only way out was the
// setup button — which does nothing the door could not have done by itself.
//
// So: keep asking. A retry costs one `tailscale status --json`, backs off to
// five minutes, and stops the moment the door is up or the user turns it off.
// It also covers everything else that is merely EARLY at boot rather than
// wrong — a daemon still signing in, a `tailscale cert` that met no network yet.
const RETRY_DELAYS_MS = [5000, 10000, 20000, 45000, 90000, 180000, 300000];
// A panel refresh may probe for a live reason; two in the same breath (the
// status route is polled every few seconds while a setup job runs) would spawn
// the CLI for an answer we just had.
const PROBE_TTL_MS = 2000;

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

// `retryDelays` is injected only by the tests: waiting out the real backoff to
// assert that the door retries is a five-second unit test.
function createRemoteHttps({
  tailscale, dataDir, handler, port = DEFAULT_PORT, log = () => {},
  retryDelays = RETRY_DELAYS_MS,
} = {}) {
  const certDir = path.join(dataDir, 'tls');
  let server = null;
  let renewTimer = null;
  let state = { running: false, reason: 'idle', host: '', ip: '', url: '', since: 0 };
  // Whether the user asked for the door. Only that grants the module the right
  // to keep retrying in the background; `stop()` withdraws it.
  let wanted = false;
  let retryTimer = null;
  let retryStep = 0;
  let starting = null;      // the in-flight attempt, so two callers make one
  let probedAt = 0;

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

  /** One try. Never schedules anything; `start()` owns the retrying. */
  async function attempt() {
    if (starting) return starting;
    starting = _attempt().finally(() => { starting = null; });
    return starting;
  }

  async function _attempt() {
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
    clearRetry();
    renewTimer = setInterval(() => { renew().catch(() => {}); }, RENEW_INTERVAL_MS);
    if (renewTimer.unref) renewTimer.unref();
    return { ok: true, ...state };
  }

  function clearRetry() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retryStep = 0;
  }

  /** Ask again later, further away each time, until the door is up. */
  function scheduleRetry() {
    if (!wanted || server || retryTimer) return;
    const ms = retryDelays[Math.min(retryStep, retryDelays.length - 1)];
    retryStep++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      attempt()
        .then((r) => { if (!r || !r.ok) scheduleRetry(); })
        .catch(() => scheduleRetry());
    }, ms);
    if (retryTimer.unref) retryTimer.unref();
  }

  /**
   * Bring the door up, and keep trying if it cannot come up yet.
   *
   * The retry is the whole point (see RETRY_DELAYS_MS): every reason short of
   * `not_installed` is one that fixes itself within a minute of a reboot, and
   * before this the door simply stayed down until somebody pressed a button.
   */
  async function start() {
    wanted = true;
    // An explicit call is the user in front of the panel, so the backoff starts
    // over: what they change is exactly what the next attempt should see.
    clearRetry();
    const r = await attempt();
    if (!r.ok) scheduleRetry();
    return r;
  }

  /**
   * The reason as it is RIGHT NOW, for a panel somebody is looking at.
   *
   * `status()` returns the last attempt's verdict, which is correct for a door
   * that is up and stale for one that is down — and a stale reason is not a
   * small thing here: it told a user whose Tailscale was running and connected
   * that its app was not, minutes after it had attached. One `status --json`,
   * cached briefly so a polling panel does not spawn the CLI per tick.
   */
  async function refreshReason() {
    if (server) return { ...state, port };
    const now = Date.now();
    if (now - probedAt < PROBE_TTL_MS) return { ...state, port };
    probedAt = now;
    const reason = readiness(await tailscale.getStatus().catch(() => ({})));
    state = { ...state, reason };
    // Ready and down means the retry timer simply has not fired yet, and the
    // person waiting for it is on the other side of this call. Fire-and-forget:
    // a first certificate can take a minute, which is not something to hold a
    // status request open for.
    if (reason === 'ready' && wanted) {
      attempt().then((r) => { if (!r || !r.ok) scheduleRetry(); }).catch(() => {});
    }
    return { ...state, port };
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
    // Withdrawn first: a retry that fires after this would bring back a door the
    // user just closed, and at shutdown it would resurrect one mid-teardown.
    wanted = false;
    clearRetry();
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

  return { start, stop, renew, status, refreshReason, readiness: () => state.reason };
}

module.exports = {
  createRemoteHttps, readiness, DEFAULT_PORT, RENEW_INTERVAL_MS,
  RETRY_DELAYS_MS, PROBE_TTL_MS,
};
