// Paired-device access (R1.1) — Settings → Telefono (its own category since
// v4.11.0: this is not the Sunshine wizard and never was).
// Renders into #settings-remote-access. The whole feature's UI is here: the
// opt-in, the QR pairing sheet, the device list and the kill switch.
//
// Everything this page talks to is loopback-only by construction — none of
// /api/remote-access/{status,enable,pair,rename,revoke,revoke-all} is on the
// paired-device allowlist in server/remote-access.js — so a phone can never
// enrol another phone or revoke the device that would kick it off.
//
// Mirrors remote-control.js / lighting-page.js: IIFE, one global, no framework.
(function () {
  'use strict';

  const MOUNT_ID = 'settings-remote-access';
  // While a pairing code is live we re-render once a second for the countdown.
  // Nothing else on this page polls: the device list changes only when the user
  // acts on it, and a phone that pairs is picked up by the pairing tick.
  const TICK_MS = 1000;

  let _state = null;
  let _tick = null;
  let _busy = false;
  let _qrLibPromise = null;
  // Push is per BROWSER, so it is not part of the server state above: it is
  // read from this device (permission + the live subscription) and refreshed
  // asynchronously, because reading it touches the service worker registration.
  let _push = null;

  function api(path, method, body) {
    return fetch(path, {
      method: method || 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then((r) => r.json()).catch(() => ({}));
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // The pieces every Settings page is built from (SettingsPage.css).
  function section(title) {
    const box = el('section', 'settings-section');
    if (title) box.appendChild(typeof title === 'string' ? el('div', 'settings-section-title', title) : title);
    return box;
  }

  function switchRow(label, hint, checked, onChange) {
    const row = el('label', 'settings-toggle-row');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'settings-check';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input));
    const words = el('span', 'settings-label-line');
    words.appendChild(el('span', null, label));
    if (hint) words.appendChild(el('span', 'settings-hint', hint));
    row.append(input, words);
    return row;
  }

  function keyRow(...keys) {
    const row = el('div', 'settings-row settings-row-keys');
    row.append(...keys);
    return row;
  }

  // A name and the address under it, with a key on the right when there is one.
  function addressRow(label, address, key) {
    const row = el('div', 'settings-row ra-address');
    const words = el('span', 'settings-label-line');
    words.append(el('span', null, label), el('code', 'settings-hint', address));
    row.appendChild(words);
    if (key) row.appendChild(key);
    return row;
  }

  // Same loader the share card uses — the vendored qrcode-generator is already
  // shipped, so pairing costs no new asset.
  function loadQrLib() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    if (!_qrLibPromise) {
      _qrLibPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'js/vendor/qrcode.js';
        s.onload = () => resolve(window.qrcode || null);
        s.onerror = () => { _qrLibPromise = null; reject(new Error('qr lib failed to load')); };
        document.head.appendChild(s);
      });
    }
    return _qrLibPromise;
  }

  // The base URL to hand a device. When the HTTPS door is up it is the ONLY one
  // offered: it reaches this PC at home and away, it is a secure context (so the
  // phone can install it as an app and use its microphone), and its name does
  // not change with the DHCP lease. Cookies are scoped per host, so offering
  // both would mean pairing the same phone twice for no gain.
  function baseUrl(st) {
    const tls = st && st.https;
    if (tls && tls.running && tls.url) return tls.url;
    return 'http://' + st.addresses[0] + ':' + st.port;
  }

  function pairUrl(st, code) {
    // The code rides in the FRAGMENT: a fragment is never sent to the server,
    // so the live invitation stays out of logs and out of any proxy in between.
    return baseUrl(st) + '/pair#' + code;
  }

  // Tailscale's admin console. A fixed, first-party URL — the one step of the
  // setup that happens somewhere other than this machine, and the one nobody
  // would think to look for.
  const TAILNET_ADMIN = 'https://login.tailscale.com/admin/dns';

  // The whole procedure, shown under the reason. Knowing WHICH step is missing
  // does not tell anyone what the steps are, and not one of these is guessable:
  // that it needs an account at all, that the certificate switch lives in a web
  // console rather than in the Tailscale app, that the PHONE needs the same app
  // signed into the same account, and that its VPN toggle has to be on.
  function howToSetUp() {
    const box = el('div', 'ra-how');
    box.appendChild(el('h4', 'ra-limits-title', t('ra_https_how_title')));
    const list = el('ol', 'ra-how-list');
    for (const key of ['ra_https_how_1', 'ra_https_how_2', 'ra_https_how_3', 'ra_https_how_4']) {
      const li = el('li', null, t(key));
      if (key === 'ra_https_how_2') {
        // The console is a page on the web, so it opens in the real browser.
        // `noopener` because this is a link out of a dashboard that holds a
        // local API — the opened tab must never get a handle back to us.
        li.appendChild(document.createTextNode(' '));
        const a = el('a', 'ra-how-link', 'login.tailscale.com');
        a.href = TAILNET_ADMIN;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        li.appendChild(a);
      }
      list.appendChild(li);
    }
    box.appendChild(list);
    return box;
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

  // The live step. `wait_certs` is the one that needs the user somewhere else,
  // so it is the only step that carries a button — everything else is Xenon
  // working and the honest thing to show is what it is doing.
  function setupProgress(setup) {
    const box = el('div', 'ra-setup');
    box.appendChild(el('p', 'ra-setup-step', t(SETUP_STEP[setup.step] || 'ra_https_step_installing')));
    if (setup.step === 'wait_certs') {
      const a = el('a', 'settings-btn primary', t('ra_https_open_admin'));
      a.href = TAILNET_ADMIN;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      box.appendChild(a);
      box.appendChild(el('p', 'settings-note', t('ra_https_wait_certs_note')));
    }
    // The sign-in link, while we are waiting for it to be used. Xenon already
    // tried to open it in a browser; this is what makes the step actionable when
    // that did not work — on a machine with no default browser, or a dashboard
    // being driven from a phone, where the page opened on the wrong screen.
    // Only ever a https://login.tailscale.com URL (validated server-side).
    if (setup.step === 'wait_login' && setup.authUrl) {
      const a = el('a', 'settings-btn primary', t('ra_https_open_login'));
      a.href = setup.authUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      box.appendChild(a);
      box.appendChild(el('p', 'settings-note', t('ra_https_wait_login_note')));
    }
    const stop = el('button', 'settings-btn', t('ra_cancel'));
    stop.type = 'button';
    stop.addEventListener('click', () => act('/api/remote-access/https/setup', { cancel: true }));
    box.appendChild(stop);
    return box;
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

  // Draw the QR as a grid of <div>s rather than a canvas: the code is short
  // (~40 chars → a low version with big modules), the panel is a fixed size,
  // and CSS grid stays crisp at any device pixel ratio without us doing the
  // scaling arithmetic.
  function renderQr(box, text) {
    box.textContent = '';
    loadQrLib().then((lib) => {
      if (!lib) throw new Error('no qr lib');
      const qr = lib(0, 'M');            // version 0 = pick the smallest that fits
      qr.addData(text);
      qr.make();
      const n = qr.getModuleCount();
      const grid = el('div', 'ra-qr-grid');
      grid.style.gridTemplateColumns = 'repeat(' + n + ', 1fr)';
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          const cell = el('i');
          if (qr.isDark(r, c)) cell.className = 'on';
          grid.appendChild(cell);
        }
      }
      box.appendChild(grid);
    }).catch(() => {
      // No QR is not a dead end — the code below it is typed in by hand and the
      // page says so. Never leave an empty square with no explanation.
      box.appendChild(el('div', 'ra-qr-fail', t('ra_qr_failed')));
    });
  }

  function secsLeft(expiresAt) {
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  }

  // ── Pieces shared with the step-by-step guide ─────────────────────────────
  // Built here and handed to js/remote-access-guide.js rather than reimplemented
  // there: the guide walks the user across the same switches this panel owns, so
  // a second copy of the QR sheet or of the Tailscale error ladder would be two
  // things to keep in step and one of them would eventually be wrong.

  /** The live invitation, or the button that asks for one, plus the address. */
  function pairingSheet(st) {
    if (st.pairing) {
      const left = secsLeft(st.pairing.expiresAt);
      const sheet = el('div', 'ra-pair');
      const qrBox = el('div', 'ra-qr');
      renderQr(qrBox, pairUrl(st, st.pairing.code));
      sheet.appendChild(qrBox);

      sheet.appendChild(el('p', 'ra-pair-hint', t('ra_scan_hint')));
      sheet.appendChild(el('div', 'ra-code', st.pairing.display));
      sheet.appendChild(el('p', 'ra-pair-url', baseUrl(st) + '/pair'));
      sheet.appendChild(el('p', 'ra-pair-left', t('ra_expires_in') + ' ' + left + 's'));

      const cancel = el('button', 'settings-btn', t('ra_cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', () => act('/api/remote-access/pair/cancel'));
      sheet.appendChild(cancel);
      return sheet;
    }
    // The page's main action until a first device is in; after that, one key among others.
    const add = el('button', 'settings-btn' + ((st.devices || []).length ? '' : ' primary'), t('ra_add_device'));
    add.type = 'button';
    add.disabled = (st.devices || []).length >= (st.maxDevices || 16);
    add.addEventListener('click', () => act('/api/remote-access/pair'));
    // The address is worth showing even without a live code: it is what the
    // user types when a camera cannot read the QR.
    const box = addressRow(t('ra_address'), baseUrl(st), add);
    // The other LAN addresses are only worth listing while the secure door is
    // down — with it up, that one name is the answer everywhere.
    if (!(st.https && st.https.running) && st.addresses.length > 1) {
      box.appendChild(el('p', 'settings-hint', t('ra_address_alt') + ' ' + st.addresses.slice(1).join(', ')));
    }
    return box;
  }

  /** Asked for and not up: the reason, the button, the command, the procedure. */
  function httpsFailure(st) {
    const tls = st.https || {};
    const setup = st.httpsSetup || {};
    const box = el('div', 'ra-https-down');
    // Name the one thing in the way — never a bare "failed", because each of
    // these is a different action by the user and one of them is not on this
    // machine at all.
    const why = el('p', 'settings-note settings-note-warn');
    why.textContent = t(HTTPS_WHY[tls.reason] || 'ra_https_why_failed');
    box.appendChild(why);
    // The button that does everything it can: installs Tailscale, opens the
    // sign-in, then waits for the one switch that is not on this machine.
    const go = el('button', 'settings-btn primary', t('ra_https_setup'));
    go.type = 'button';
    go.addEventListener('click', () => act('/api/remote-access/https/setup'));
    box.appendChild(go);
    if (setup.error) {
      const err = el('p', 'settings-note settings-note-warn');
      err.textContent = t(SETUP_ERR[setup.error] || 'ra_https_setup_err_failed');
      box.appendChild(err);
    }
    // "Install Tailscale" is not instructions. Where we know the exact line,
    // it goes on screen to be copied — the whole point of naming the reason is
    // that the user can act on it without leaving the panel to search.
    //
    // Shown from the READINESS too, not only after a failed attempt: where
    // Xenon cannot install Tailscale itself, pressing the button can only ever
    // come back asking for it, so making them press it first would be theatre.
    const cmd = setupErrCommand(setup.error)
      || (st.httpsAutoInstall === false && tls.reason === 'not_installed' ? setupErrCommand('needs_manual_install') : '')
      || (tls.reason === 'needs_operator' ? setupErrCommand('needs_operator') : '');
    if (cmd) {
      const pre = el('pre', 'ra-cmd');
      pre.textContent = cmd;
      box.appendChild(pre);
    }
    // …and the manual procedure underneath, for anyone who would rather do it
    // themselves or whose machine has no winget.
    box.appendChild(howToSetUp());
    return box;
  }

  /** The paired devices, with rename and revoke, under `lead` when there is one. */
  function appendDevices(page, st, lead) {
    const devices = Array.isArray(st.devices) ? st.devices : [];
    const listBox = section(t('ra_devices') + ' (' + devices.length + '/' + (st.maxDevices || 16) + ')');
    if (lead) listBox.appendChild(lead);

    if (!devices.length) {
      listBox.appendChild(el('p', 'settings-note', t('ra_no_devices')));
    } else {
      for (const d of devices) {
        const item = el('div', 'settings-row ra-device');

        const name = document.createElement('input');
        name.className = 'ra-device-name';
        name.value = d.name;
        name.maxLength = 40;
        name.addEventListener('change', () => {
          const next = name.value.trim();
          if (!next || next === d.name) { name.value = d.name; return; }
          act('/api/remote-access/rename', { id: d.id, name: next });
        });
        item.appendChild(name);

        const meta = el('div', 'ra-device-meta');
        meta.appendChild(el('span', null, t('ra_last_seen') + ' ' + fmtSeen(d.lastSeenAt)));
        if (d.lastIp) meta.appendChild(el('span', 'ra-device-ip', d.lastIp));
        item.appendChild(meta);

        const kill = el('button', 'settings-btn danger', t('ra_revoke'));
        kill.type = 'button';
        kill.addEventListener('click', () => act('/api/remote-access/revoke', { id: d.id }));
        item.appendChild(kill);

        listBox.appendChild(item);
      }
      const killAll = el('button', 'settings-btn danger', t('ra_revoke_all'));
      killAll.type = 'button';
      killAll.addEventListener('click', () => act('/api/remote-access/revoke-all'));
      listBox.appendChild(keyRow(killAll));
    }
    page.appendChild(listBox);
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

  async function refresh() {
    // A paired device is refused this endpoint by design (it is absent from the
    // remote allowlist, not blocked by a handler check). Asking anyway would
    // spend a request to be told no and surface it as an error — so answer it
    // locally and let render() draw the rule instead.
    // Push state is read from the browser, not the server, so it is fetched
    // alongside rather than inside the status call. render() draws a "checking"
    // line until it lands — see appendNotifications for why it must not guess.
    const push = refreshPush();
    if (typeof window !== 'undefined' && window.__xenonRemote) {
      _state = { remote: true };
      render();
      await push; render();
      return;
    }
    _state = await api('/api/remote-access/status');
    render();
    await push; render();
  }

  async function act(path, body) {
    if (_busy) return;
    _busy = true;
    try { await api(path, 'POST', body || {}); await refresh(); }
    finally { _busy = false; }
  }

  function syncTick() {
    // Three reasons to tick: a live pairing code (a countdown that has to move),
    // a running setup job (steps that change on the server, not here) — and a
    // secure door that is asked for and down, because the server keeps retrying
    // it on its own. Without that last one the panel prints the reason it was
    // given when it opened, and goes on printing it after the door came up.
    const running = () => !!(_state && _state.httpsSetup && _state.httpsSetup.running);
    const httpsDown = () => !!(_state && _state.httpsEnabled && !(_state.https && _state.https.running));
    const wantTick = !!(_state && (_state.pairing || running() || httpsDown()));
    if (wantTick && !_tick) {
      let n = 0;
      _tick = setInterval(() => {
        if (!document.getElementById(MOUNT_ID)) { stopTick(); return; }
        n++;
        // A setup advances on the SERVER, so only a re-read can see it — but
        // every third second, because a job parked on the certificate switch
        // waits up to ten minutes and that must not be 600 requests.
        if (running()) { if (n % 3 === 0) refresh(); return; }
        if (!_state.pairing) {
          // Every five seconds, not every one: each read probes Tailscale on the
          // server, and nothing here is a countdown.
          if (httpsDown()) { if (n % 5 === 0) refresh(); return; }
          stopTick(); return;
        }
        // The code expired on the server too — re-read rather than guess, so a
        // phone that paired in the last second shows up in the list.
        if (secsLeft(_state.pairing.expiresAt) <= 0) { refresh(); return; }
        render();
      }, TICK_MS);
    } else if (!wantTick) {
      stopTick();
    }
  }

  function stopTick() {
    if (!_tick) return;
    clearInterval(_tick);
    _tick = null;
  }

  // ── Notifications (T2c) ────────────────────────────────────────────────────

  /**
   * The push row, in whatever state this browser is actually in.
   *
   * Everything here is per DEVICE, which is why it is not a server setting: the
   * permission belongs to the browser, and the subscription belongs to the
   * browser's own push service registration. The PC only stores the address.
   *
   * The states are drawn separately rather than folded into a disabled toggle,
   * because each one has a different thing the user has to do, and three of
   * them cannot be fixed from inside this page at all.
   */
  function appendNotifications(page) {
    const box = section(t('ra_notif_title'));
    const p = _push;

    // Still reading this device's state. Draw the heading and nothing that
    // could be wrong — a row that says "off" and then flips to "on" a moment
    // later reads as the switch having done something.
    if (!p) {
      box.appendChild(el('p', 'settings-note', t('ra_notif_checking')));
      page.appendChild(box);
      return;
    }
    if (!p.secure) { box.appendChild(el('p', 'settings-note', t('ra_notif_insecure'))); page.appendChild(box); return; }
    if (!p.supported) { box.appendChild(el('p', 'settings-note', t('ra_notif_unsupported'))); page.appendChild(box); return; }
    if (p.permission === 'denied') {
      // Nothing on this page can undo a denial: the browser will not ask again
      // and there is no API to reopen the prompt. Say where it lives instead of
      // showing a switch that silently does nothing.
      box.appendChild(el('p', 'settings-note settings-note-warn', t('ra_notif_denied')));
      page.appendChild(box);
      return;
    }

    box.appendChild(switchRow(t('ra_notif'), t('ra_notif_hint'), p.subscribed === true, async (toggle) => {
      const want = toggle.checked;
      toggle.disabled = true;
      // The permission prompt must be raised inside this handler, so enable()
      // is called directly and not behind an await of anything else.
      const r = want ? await window.Pwa.enable() : await window.Pwa.disable();
      if (want && !(r && r.ok)) toast(t(NOTIF_ERR[r && r.reason] || 'ra_notif_err_failed'));
      await refreshPush();
      render();
    }));

    if (p.subscribed) {
      // The only way to find out it works without waiting for something to
      // happen at three in the morning.
      const test = el('button', 'settings-btn', t('ra_notif_test'));
      test.type = 'button';
      test.addEventListener('click', async () => {
        test.disabled = true;
        const r = await window.Pwa.test(t('ra_notif_test_title'), t('ra_notif_test_body'));
        toast(r && r.sent ? t('ra_notif_test_sent') : t('ra_notif_test_failed'));
        test.disabled = false;
      });
      box.appendChild(keyRow(test));
    }

    // Said once, plainly, and not buried: this is the only part of Xenon that
    // hands anything to a company that is not the user.
    box.appendChild(el('p', 'settings-note', t('ra_notif_third_party')));
    page.appendChild(box);
  }

  const NOTIF_ERR = {
    denied: 'ra_notif_denied',
    dismissed: 'ra_notif_err_dismissed',
    unsupported: 'ra_notif_unsupported',
    no_key: 'ra_notif_err_failed',
    too_many: 'ra_notif_err_too_many',
  };

  async function refreshPush() {
    try {
      _push = (window.Pwa && window.Pwa.pushState) ? await window.Pwa.pushState() : { supported: false, secure: true };
    } catch { _push = { supported: false, secure: true }; }
  }

  /** Every failure above has something the user must do about it — say it. */
  function toast(message) {
    if (window.XenonToast) window.XenonToast.show({ type: 'info', title: t('ra_notif_title'), message, duration: 6000 });
  }

  function render() {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) { stopTick(); return; }
    const st = _state || {};
    mount.textContent = '';

    const page = el('div', 'ra-page');

    // ── What this is, and the switch ──
    const title = el('div', 'settings-section-title');
    title.append(el('span', null, t('ra_title')), el('span', 'ra-beta', t('ra_beta')));
    const access = section(title);
    access.appendChild(el('p', 'settings-note', t('ra_sub')));
    page.appendChild(access);
    // The panel is the switches; the guide is the reason and the walkthrough —
    // in particular the away-from-home setup, whose one manual step lives on
    // someone else's website and needs more room than a settings panel has.
    // Added to the HEAD deliberately, so it is also there in the two states
    // that return early below: switched off (where the panel says least) and on
    // a paired phone (where the panel is closed by design and this is the only
    // thing left to read).
    const guide = el('a', 'settings-btn', t('ra_guide_link'));
    guide.href = 'https://xenon-app.com/phone.html';
    guide.target = '_blank';
    guide.rel = 'noopener noreferrer';
    const keys = keyRow(guide);

    // The step-by-step guide, reachable at any time and not only from the
    // first-run picker. Placed in the head so it is the first thing offered to
    // somebody who opened this panel and does not know where to start.
    if (!st.remote && window.RemoteAccessGuide && !window.RemoteAccessGuide.isOpen()) {
      const openGuide = el('button', 'settings-btn', t('ra_guide_open'));
      openGuide.type = 'button';
      openGuide.addEventListener('click', () => window.RemoteAccessGuide.open());
      keys.prepend(openGuide);
    }

    // On a paired device this whole panel is out of reach, and deliberately so:
    // a phone must not be able to enrol another phone or revoke the device that
    // would kick it off. Say that, here, as a designed state. Calling the
    // endpoint anyway (see init) produced a refusal toast, which reads as a
    // fault rather than as a rule — the panel looked broken instead of closed.
    if (st.remote) {
      access.append(keys, el('p', 'settings-note', t('ra_pc_only')));
      // The ONE thing this panel can still offer a phone, and the right place
      // for it: notifications are a property of THIS browser, not of the PC, so
      // they can only be switched on from the device that will receive them.
      // Without this the phone would have a settings page that says "not here"
      // and nothing else.
      appendNotifications(page);
      mount.appendChild(page);
      stopTick();
      return;
    }

    // ── The step-by-step guide ──
    // While it is open it replaces the panel's loose switches and its pairing
    // sheet, because it contains both: two QR codes on one page, or two copies
    // of the same toggle, is a page arguing with itself. The device list stays —
    // it is the answer to "did it work", which the guide asks the user to check.
    if (window.RemoteAccessGuide && window.RemoteAccessGuide.isOpen()) {
      access.appendChild(keys);
      page.appendChild(window.RemoteAccessGuide.render({
        st,
        act,
        switchRow,
        pairingSheet,
        httpsFailure,
        setupProgress,
        tailnetAdmin: TAILNET_ADMIN,
      }));
      appendDevices(page, st);
      appendNotifications(page);
      mount.appendChild(page);
      syncTick();
      return;
    }

    // ── The opt-in ──
    access.appendChild(switchRow(t('ra_enable'), t('ra_enable_hint'), st.enabled === true, (toggle) => {
      const value = toggle.checked;
      toggle.disabled = true;
      act('/api/remote-access/enable', { value });
    }));
    access.appendChild(keys);

    if (st.enabled !== true) {
      // Off is the resting state, and the page says what turning it on means
      // rather than hiding the consequence behind the switch.
      access.appendChild(el('p', 'settings-note', t('ra_off_note')));
      mount.appendChild(page);
      stopTick();
      return;
    }

    // ── No usable address ──
    if (!Array.isArray(st.addresses) || !st.addresses.length) {
      access.appendChild(el('p', 'settings-note settings-note-warn', t('ra_no_network')));
      mount.appendChild(page);
      stopTick();
      return;
    }

    // ── The live pairing invitation and the paired devices ──
    appendDevices(page, st, pairingSheet(st));

    appendAwayFromHome(page, st);

    // Notifications sit under the HTTPS block because that is what unlocks
    // them: on the plain-HTTP door the browser will not deliver one whatever
    // this panel says. On the PC itself the door is loopback, which browsers
    // treat as secure, so it works here too.
    appendNotifications(page);

    appendLimits(page, st);

    mount.appendChild(page);
    syncTick();
  }

  // The secure door (T2). A second switch rather than a replacement: it can fail
  // for reasons that have nothing to do with pairing, and turning it off must
  // never take the LAN door down with it. Skipped, not refused, on a platform
  // that cannot run it: the plain-HTTP door above is what those pair on.
  function appendAwayFromHome(page, st) {
    if (st.httpsSupported === false) return;
    const tls = st.https || {};
    const setup = st.httpsSetup || {};
    const box = section(t('ra_guide_group_away'));
    box.appendChild(switchRow(t('ra_https'), t('ra_https_hint'), st.httpsEnabled === true, (toggle) => {
      toggle.disabled = true;
      act('/api/remote-access/https', { value: toggle.checked });
    }));
    if (setup.running) {
      // A setup is under way. Show the step it is on and nothing else: while the
      // job is driving, offering the manual instructions as well would be two
      // sets of directions at once.
      box.appendChild(setupProgress(setup));
    } else if (st.httpsEnabled === true && !tls.running) {
      box.appendChild(httpsFailure(st));
    } else if (tls.running) {
      box.appendChild(addressRow(t('ra_https_url'), tls.url));
      box.appendChild(el('p', 'settings-note', t('ra_https_pair_note')));
      // Up on this PC is only half of it — the phone still needs the same app,
      // the same account and its VPN switch on, or the address does not resolve
      // there at all. That is the step people get stuck on, so it is stated
      // exactly where they are about to hit it.
      box.appendChild(el('p', 'settings-note', t('ra_https_phone_note')));
    }
    page.appendChild(box);
  }

  // What a paired device can and cannot do. Stated in the UI, not only in the
  // code: a user who expects something from the phone should learn it here rather
  // than by tapping it and getting nothing.
  function appendLimits(page, st) {
    const box = section();
    const more = el('details', 'settings-expander');
    const name = el('summary');
    name.appendChild(el('span', 'settings-label-line', t('ra_limits_title')));
    const list = el('ul', 'settings-expander-list');
    for (const key of ['ra_can_1', 'ra_can_2', 'ra_can_3', 'ra_cant_1', 'ra_cant_2', 'ra_cant_3']) {
      list.appendChild(el('li', null, t(key)));
    }
    // The cleartext caveat is true of the LAN door and stops being true the
    // moment the secure one is up. Leaving it on screen either way would be the
    // panel contradicting itself.
    if (!(st.https && st.https.running)) list.appendChild(el('li', null, t('ra_http_note')));
    more.append(name, list);
    box.appendChild(more);
    page.appendChild(box);
  }

  function init() {
    if (!document.getElementById(MOUNT_ID)) return;
    refresh();
  }

  window.RemoteAccessPage = { init, refresh, render };
})();
