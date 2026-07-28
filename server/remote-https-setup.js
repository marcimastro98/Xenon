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
const POLL_MS = 2000;

// The steps, in the order they must happen. `wait_certs` is the one the user
// acts on somewhere else; the panel keys its big link off exactly this value.
const STEPS = ['installing', 'login', 'wait_login', 'wait_certs', 'starting', 'done'];

function createHttpsSetup({ tailscale, installer, https, onSettings, now = () => Date.now(), sleep, log = () => {} } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let job = null;   // { step, error, startedAt, cancelled }

  function status() {
    if (!job) return { running: false, step: '', error: '' };
    return { running: !job.done, step: job.step, error: job.error || '' };
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

    // 2. Sign in. `tailscale up` opens the browser and returns before the user
    //    has finished, so the wait is a poll rather than the command's exit.
    s = await st();
    if (!s.connected) {
      job.step = 'login';
      log('[https-setup] opening the Tailscale sign-in');
      await tailscale.startLogin().catch(() => {});
      job.step = 'wait_login';
      const ok = await until(async () => (await st()).connected === true, WAIT_LOGIN_MS);
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

module.exports = { createHttpsSetup, STEPS, WAIT_LOGIN_MS, WAIT_CERTS_MS, POLL_MS };
