'use strict';

// One-click setup for the secure door (T2).
//
// The feature is worth very little if turning it on is a research project, and
// before this it was one: install Tailscale, sign in, find a switch in a web
// console nobody mentioned, install the app on the phone, remember to turn its
// VPN on. Every one of those is reasonable on its own and the whole is a wall.
//
// So this drives the chain as a background JOB the panel watches, rather than a
// request held open: winget with a UAC prompt takes minutes, `tailscale up`
// waits on a browser sign-in, and the certificate switch is not on this machine
// at all. A long HTTP call would time out through all three.
//
// The honest limit, stated here because the UI has to state it too: **step 3
// cannot be automated.** Turning on HTTPS certificates is a per-TAILNET setting,
// changed in Tailscale's admin console. The API that could flip it needs an
// OAuth client the user would have to create in that same console — more steps,
// not fewer. So the job does everything up to it, then WAITS, polling until the
// user has flipped it, and continues on its own. Waiting is the honest shape:
// the alternative is failing and making them start over.
//
// Everything here is injected, so test/remote-https-setup.test.mjs runs the whole
// state machine without winget, without Tailscale and without a network.

// How long to keep waiting for a step that depends on a human: the browser
// sign-in, and the certificate switch. Generous — the cost of giving up early is
// that the user comes back to a failure they did not cause.
const WAIT_LOGIN_MS = 5 * 60 * 1000;
const WAIT_CERTS_MS = 10 * 60 * 1000;
// Neither of these is a human step: `sc start` returns on START_PENDING, and a
// tray app either attaches to the daemon or does not. Short, because waiting
// longer only delays a message the user can act on. (The measured client attach
// took under three seconds.)
const WAIT_SERVICE_MS = 30 * 1000;
const WAIT_CLIENT_MS = 30 * 1000;
const POLL_MS = 2000;

// tailscaled's word for "no client has ever started this backend" — imported
// rather than spelled again here, so the two modules cannot disagree about it.
const { NO_BACKEND } = require('./remote-control/tailscale');

// The steps, in the order they must happen. `wait_certs` is the one the user
// acts on somewhere else; the panel keys its big link off exactly this value.
// `operator` only occurs off Windows, and only where Tailscale was installed by
// somebody other than us. `service` and `client` are its Windows counterparts,
// and they are two steps rather than one because the remedies differ: starting
// a service needs elevation, starting the tray app must NOT have it.
const STEPS = ['installing', 'service', 'client', 'login', 'operator', 'wait_login', 'wait_certs', 'starting', 'done'];

function createHttpsSetup({
  tailscale, installer, https, onSettings,
  now = () => Date.now(), sleep, log = () => {},
  // Injected so the operator grant can be asserted without depending on whoever
  // happens to run the suite.
  operatorUser = () => { try { return require('node:os').userInfo().username || ''; } catch { return process.env.USER || ''; } },
} = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let job = null;   // { step, error, startedAt, cancelled }

  function status() {
    if (!job) return { running: false, step: '', error: '', authUrl: '' };
    // `authUrl` is not decoration: on Windows the Tailscale GUI opens the
    // sign-in page itself, so the panel never had to say where to go. Off
    // Windows nothing does, and "waiting for you to complete the sign-in" with
    // no link is an instruction with the instruction missing.
    return { running: !job.done, step: job.step, error: job.error || '', authUrl: job.authUrl || '' };
  }

  /** Poll `probe` until it is true or the budget runs out. */
  async function until(probe, budgetMs) {
    const deadline = now() + budgetMs;
    for (;;) {
      if (job && job.cancelled) return false;
      if (await probe().catch(() => false)) return true;
      if (now() >= deadline) return false;
      await wait(POLL_MS);
    }
  }

  async function run() {
    const st = () => tailscale.getStatus().catch(() => ({}));

    // 1. Install. `isInstalled` is winget's answer, which is the one that knows
    //    about a copy installed outside Xenon; the exe check in getStatus() is a
    //    faster proxy that cannot see a pending PATH.
    let s = await st();
    if (!s.installed) {
      // Off Windows Xenon cannot install it: there is no winget, and driving the
      // user's own package manager under sudo from a dashboard toggle is not
      // something to do behind their back. This is the same shape as step 3 —
      // one thing the user does elsewhere — so it stops and names it rather than
      // reporting a failure they did not cause.
      if (!(await Promise.resolve(installer.canInstall ? installer.canInstall('tailscale') : true).catch(() => false))) {
        job.error = 'needs_manual_install';
        log('[https-setup] Tailscale is not installed and cannot be installed from here');
        return;
      }
      job.step = 'installing';
      log('[https-setup] installing Tailscale');
      const r = await installer.install('tailscale').catch((e) => ({ code: 1, stderr: e.message }));
      // 1223 is ERROR_CANCELLED: the user dismissed the UAC prompt. That is a
      // decision, not a failure, and it gets its own word so the panel does not
      // tell them something went wrong.
      if (r && r.code === 1223) { job.error = 'uac_cancelled'; return; }
      if (r && r.code !== 0) { job.error = 'install_failed'; return; }
      s = await st();
      if (!s.installed) { job.error = 'install_failed'; return; }
    }

    // 1b/1c. Installed, and Tailscale is not UP on this machine. Two different
    //     situations wear that face, they need opposite remedies, and BOTH used
    //     to end the same wrong way: `up` was fired, changed nothing, and the
    //     chain polled `wait_login` for five minutes before reporting
    //     `login_timeout` — "you took too long signing in", with no browser ever
    //     opened. That is the message that sends somebody to their router.
    //
    //     Deliberately reads the `s` step 1 already fetched rather than probing
    //     again: a state machine that re-asks between every step is one a test
    //     cannot describe.
    //
    //     `needsOperator` is checked first throughout, because off Windows it
    //     produces the same `running: false` for a third reason with a third
    //     remedy; step 2 owns that one and must keep it.

    // 1b. The service is not running at all, so `status --json` cannot answer
    //     and prints plain text instead. Measured on Windows 11 with the
    //     Tailscale service left Manual/Stopped after an install.
    if (!s.running && !s.needsOperator) {
      job.step = 'service';
      log('[https-setup] Tailscale is installed but its service is not running');
      const started = tailscale.startService
        ? await tailscale.startService().catch(() => null)
        : null;
      // `ok` means the request was accepted, not that the daemon is up — hence
      // the poll. Anything else is final: there is nothing to wait for.
      const up = started && started.ok
        ? await until(async () => (await st()).running === true, WAIT_SERVICE_MS)
        : false;
      if (!up) {
        if (job.cancelled) { job.error = 'cancelled'; return; }
        // `not_applicable` is not a failure — it means this platform has no
        // service to start, which on macOS is literally true: the app IS the
        // daemon, so the remedy is step 1c's `open -a Tailscale`. Ending here
        // with `service_stopped` made that step unreachable on every Mac, which
        // is the whole of the feature there.
        if (!started || started.reason !== 'not_applicable') {
          // A declined prompt is the user saying no, and it gets their word for
          // it rather than being reported as a machine that could not do it.
          job.error = started && started.reason === 'cancelled' ? 'uac_cancelled' : 'service_stopped';
          return;
        }
        log('[https-setup] no service to start on this platform; trying the client');
      } else {
        s = await st();
      }
    }

    // 1c. The daemon answers and has no backend. The one that actually bites,
    //     and the one nothing above can see: every field reads healthy, the
    //     tunnel adapter is up, the profile is on disk, and the daemon logs
    //     nothing. It is not a sign-in waiting to happen — starting the client
    //     took the measured machine to Running in under three seconds, already
    //     signed in. Only reached when the daemon answered, so it cannot be
    //     confused with the service being down.
    //
    //     `!s.running` is accepted here as well, and only ever arrives via 1b's
    //     `not_applicable` fall-through: on macOS "the daemon is not running"
    //     and "the daemon has no client" are the same fact with the same cure.
    if (!s.needsOperator && (s.backendState === NO_BACKEND || !s.running)) {
      job.step = 'client';
      log('[https-setup] the Tailscale daemon has no client attached; starting it');
      const started = tailscale.startClient
        ? await tailscale.startClient().catch(() => null)
        : null;
      // `running` is part of the test, not only the backend state: coming from
      // the 1b fall-through the daemon may be fully down, and a status call that
      // cannot answer reports no backendState at all — which would satisfy a
      // bare `!== NO_BACKEND` and declare success over a daemon that never came
      // up. It changes nothing on the Windows path, where running was already
      // true before this step and startClient does not stop it.
      const up = started && started.ok
        ? await until(async () => {
          const now = await st();
          return now.running === true && now.backendState !== NO_BACKEND;
        }, WAIT_CLIENT_MS)
        : false;
      if (!up) {
        if (job.cancelled) { job.error = 'cancelled'; return; }
        job.error = 'client_not_running';
        return;
      }
    }

    // 2. Sign in. `tailscale up` opens the browser and returns before the user
    //    has finished, so the wait is a poll rather than the command's exit.
    s = await st();
    if (!s.connected) {
      // On Linux the daemon's socket is root-owned, so `up` is refused until the
      // user is made its operator. Caught here rather than left to the poll,
      // which would spend five minutes waiting for a sign-in that was never
      // going to start and then report a timeout — the one message that would
      // send someone looking at their network.
      if (s.needsOperator) { job.error = 'needs_operator'; return; }
      job.step = 'login';
      log('[https-setup] opening the Tailscale sign-in');
      // The refusal usually lands HERE, not on the status probe above. Measured
      // on Fedora 43: tailscaled's socket is world-writable, so reading status
      // succeeds for any user and only `up` — which writes preferences — is
      // denied. Discarding this result (it used to be `.catch(() => {})`) meant
      // the one machine shape that actually needs the operator grant was the one
      // shape that never reported it, and sat out a five-minute timeout instead.
      let login = await tailscale.startLogin().catch(() => null);
      if (login && login.needsOperator) {
        // Ask for the grant instead of printing the command at them. This is the
        // path for a Tailscale the user installed themselves, so our install —
        // which folds the grant into its own elevation — never ran here.
        log('[https-setup] Tailscale refused the sign-in; asking for the operator grant');
        job.step = 'operator';
        const granted = tailscale.grantOperator
          ? await tailscale.grantOperator(operatorUser()).catch(() => null)
          : null;
        if (!granted || !granted.ok) {
          // `cancelled` is the user dismissing the password dialog: a decision,
          // and not the same thing as a machine that cannot do this at all.
          job.error = granted && granted.reason === 'cancelled' ? 'uac_cancelled' : 'needs_operator';
          return;
        }
        login = await tailscale.startLogin().catch(() => null);
        if (login && login.needsOperator) { job.error = 'needs_operator'; return; }
      }
      job.step = 'wait_login';
      if (login && login.authUrl) job.authUrl = login.authUrl;
      const ok = await until(async () => {
        const cur = await st();
        if (cur.needsOperator) { job.error = 'needs_operator'; return true; }
        // tailscaled may publish the URL a moment after `up` returns, and a
        // user staring at a link-less "waiting" box has no way to know that.
        if (!job.authUrl && cur.authUrl) job.authUrl = cur.authUrl;
        return cur.connected === true;
      }, WAIT_LOGIN_MS);
      if (job.error) return;
      if (!ok) { job.error = job.cancelled ? 'cancelled' : 'login_timeout'; return; }
    }

    // 3. The one we cannot do. Wait for the human to flip it, and notice.
    s = await st();
    if (!s.certsEnabled) {
      job.step = 'wait_certs';
      log('[https-setup] waiting for HTTPS certificates to be enabled on the tailnet');
      const ok = await until(async () => (await st()).certsEnabled === true, WAIT_CERTS_MS);
      if (!ok) { job.error = job.cancelled ? 'cancelled' : 'certs_timeout'; return; }
    }

    // 4. Turn the setting on and bring the door up. The setting is written by
    //    the caller's own settings writer — this module never touches disk.
    job.step = 'starting';
    await onSettings(true);
    const r = await https.start();
    if (!r.ok) { job.error = r.reason || 'failed'; return; }
    job.step = 'done';
  }

  /** Start the chain. One at a time; a second call while one runs is a no-op. */
  function start() {
    // Spread FIRST: status() carries its own `error` (empty while a job is
    // healthy) and would overwrite the one that says why this call did nothing.
    if (job && !job.done) return { ...status(), ok: false, error: 'busy' };
    job = { step: STEPS[0], error: '', startedAt: now(), cancelled: false, done: false };
    const mine = job;
    Promise.resolve()
      .then(run)
      .catch((e) => { mine.error = 'failed'; log('[https-setup] ' + e.message); })
      .finally(() => { mine.done = true; });
    return { ok: true, ...status() };
  }

  /** Stop waiting. Never kills an installer mid-flight — only the polling. */
  function cancel() {
    if (job && !job.done) job.cancelled = true;
    return { ok: true };
  }

  return { start, cancel, status, STEPS };
}

module.exports = {
  createHttpsSetup, STEPS,
  WAIT_LOGIN_MS, WAIT_CERTS_MS, WAIT_SERVICE_MS, WAIT_CLIENT_MS, POLL_MS,
};
