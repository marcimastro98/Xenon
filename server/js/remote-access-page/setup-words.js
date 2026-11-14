// The words the access-from-other-devices page has for each step and each failure of its setup, the
// command that fixes a failure by hand, and the small sums of the page: seconds left on a code, how
// long ago a device was seen.

(() => {
  'use strict';

  function api(path, method, body) {
    return fetch(path, {
      method: method || 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then((r) => r.json()).catch(() => ({}));
  }

  const SETUP_STEP = {
    installing: 'ra_https_step_installing',
    // Installed, daemon down. Named as its own step because it takes an
    // elevation prompt, and a password dialog appearing under "signing in"
    // reads as the wrong prompt for the wrong thing.
    service: 'ra_https_step_service',
    // The daemon is up and has no client. Its own step because it is a
    // different program being started, without elevation.
    client: 'ra_https_step_client',
    login: 'ra_https_step_login',
    // Off Windows, and only where Tailscale was installed by somebody other than
    // us — our own install folds the grant into its elevation. Named as a step
    // because a password dialog appearing with the panel saying "signing in"
    // would look like the wrong prompt.
    operator: 'ra_https_step_operator',
    wait_login: 'ra_https_step_wait_login',
    wait_certs: 'ra_https_step_wait_certs',
    starting: 'ra_https_step_starting',
    done: 'ra_https_step_done',
  };
  const SETUP_ERR = {
    uac_cancelled: 'ra_https_setup_err_uac',
    install_failed: 'ra_https_setup_err_install',
    login_timeout: 'ra_https_setup_err_login',
    certs_timeout: 'ra_https_setup_err_certs',
    cancelled: 'ra_https_setup_err_cancelled',
    // Off Windows only. Neither is a failure: each is one thing the user does
    // once, somewhere Xenon should not reach on its own — installing a VPN
    // client, and granting a user the daemon's socket. Both print the exact
    // command, because "install Tailscale" is not instructions.
    needs_manual_install: 'ra_https_setup_err_manual_install',
    needs_operator: 'ra_https_setup_err_operator',
    // The daemon is installed and would not start. Its own word because the
    // remedy is a service, not a sign-in — this used to surface as
    // `login_timeout`, which is the message that sends someone to their router.
    service_stopped: 'ra_https_setup_err_service',
    // Kept apart from `service_stopped` because the advice is the opposite one:
    // there the service is down and starting it needs elevation, here it is
    // running fine and what is missing is the ordinary Tailscale app.
    client_not_running: 'ra_https_setup_err_client',
  };

  // The command that fixes each of those, shown verbatim under the message.
  // Platform comes from /version (see applyPlatformGating); on an unknown one we
  // show nothing rather than a command for the wrong system.
  //
  // These are the FALLBACK now, not the normal path: Xenon installs Tailscale
  // and asks for the operator grant itself, each behind one password prompt. A
  // command only surfaces on a machine that cannot be driven that way — no
  // polkit agent, no Homebrew, no package manager we know — where the
  // alternative is a button that does nothing.
  function setupErrCommand(error) {
    const p = window.XenonPlatform;
    if (error === 'needs_operator') {
      return p === 'linux' || p === 'darwin' ? 'sudo tailscale set --operator=$USER' : '';
    }
    if (error === 'service_stopped') {
      // Windows and Linux got here having ALREADY tried this behind an
      // elevation prompt, so the command is the fallback for a prompt that was
      // declined or could not be drawn. On macOS it is the only path: the
      // daemon belongs to the app there, so the answer is to open the app.
      if (p === 'linux') return 'sudo systemctl start tailscaled';
      if (p === 'darwin') return 'open -a Tailscale';
      return 'net start Tailscale';
    }
    // No command for this one on purpose: the remedy is opening an ordinary
    // app from the Start menu, and printing a path at somebody would make a
    // double-click look like a terminal job. The message says it in words.
    if (error === 'client_not_running') return '';
    if (error !== 'needs_manual_install') return '';
    if (p === 'darwin') return 'brew install tailscale';
    if (p === 'linux') return 'curl -fsSL https://tailscale.com/install.sh | sh';
    return '';
  }

  // Why the secure door is not up. Every one of these is fixed somewhere
  // different, and exactly one of them is not fixed on this machine at all —
  // which is the whole reason this is a list of sentences rather than a spinner.
  const HTTPS_WHY = {
    not_installed: 'ra_https_why_not_installed',
    not_running: 'ra_https_why_not_running',
    not_logged_in: 'ra_https_why_not_logged_in',
    // Reported instead of `not_logged_in` when the daemon is up with no client
    // attached — otherwise the panel sends a signed-in user looking for a login
    // screen that will never appear.
    no_backend: 'ra_https_why_no_backend',
    no_name: 'ra_https_why_no_name',
    certs_disabled: 'ra_https_why_certs_disabled',
    bad_cert: 'ra_https_why_bad_cert',
    port_busy: 'ra_https_why_port_busy',
    // Reported instead of `not_running` when the daemon is up but will not talk
    // to this user — otherwise the panel sends someone to restart a service that
    // was never stopped.
    needs_operator: 'ra_https_why_operator',
  };

  function secsLeft(expiresAt) {
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  }

  function fmtSeen(ts) {
    if (!ts) return t('ra_never');
    const diff = Date.now() - ts;
    if (diff < 60000) return t('ra_now');
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + ' min';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' h';
    return Math.floor(hours / 24) + ' g';
  }

  const NOTIF_ERR = {
    denied: 'ra_notif_denied',
    dismissed: 'ra_notif_err_dismissed',
    unsupported: 'ra_notif_unsupported',
    no_key: 'ra_notif_err_failed',
    too_many: 'ra_notif_err_too_many',
  };

  window.RemoteAccessPageSetupWords = {
    api, SETUP_STEP, SETUP_ERR, setupErrCommand, HTTPS_WHY, secsLeft, fmtSeen, NOTIF_ERR,
  };
})();
