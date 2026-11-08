// Remote Control settings page — guided setup wizard for Sunshine + Tailscale.
// Renders into #settings-remote-hub (Settings → Controllo Remoto, which since
// v4.11.0 is this wizard alone — the phone door moved to Settings → Telefono).
// Mirrors lighting-page.js module structure: IIFE, window.RemoteControl exposed.
(function () {
  'use strict';

  const POLL_INTERVAL_MS = 3000;
  const POLL_MAX_ATTEMPTS = 40; // ~2 min before giving up

  let _mounted = false;

  // ── Platform ──────────────────────────────────────────────────────────────
  // Published by settings.js once /version answers (see applyPlatformGating).
  // This panel is no longer hidden off Windows, so the words in it have to be
  // right on three systems instead of one.
  function platform() { return window.XenonPlatform || ''; }

  // Suffix a key with the platform, falling back to the bare key. Undefined —
  // /version has not landed yet — deliberately yields the bare key, which is
  // the Windows wording: it is what shipped, and a flash of the wrong package
  // manager beats a flash of a missing string.
  function platformKey(key) {
    const p = platform();
    if (p === 'linux') return `${key}_linux`;
    if (p === 'darwin') return `${key}_mac`;
    return key;
  }

  // ── API helper ────────────────────────────────────────────────────────────
  async function api(path, method = 'GET', body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json().catch(() => ({}));
  }

  // ── State ─────────────────────────────────────────────────────────────────
  // `_status` caches the last known /remote/status response so we can
  // re-render without a fresh network call when the wizard step changes.
  let _status = null;
  // Whether the user has consented and the wizard is revealed.
  let _wizardOpen = false;
  // Ongoing Tailscale-login poll handle — cleared on success/timeout/error.
  let _pollTimer = null;
  // The monitor list changes rarely; cache the fetch so the dashboard widget
  // (re-rendered on every layout pass) hits /remote/screens once per minute
  // instead of once per render. The short TTL (vs a session-lifetime cache)
  // means a hot-plugged/removed monitor shows up on the next render within a
  // minute. Reset on an empty/failed result so a later render retries.
  const SCREENS_TTL_MS = 60000;
  let _screensPromise = null;
  let _screensAt = 0;
  function loadRemoteScreens() {
    if (_screensPromise && Date.now() - _screensAt < SCREENS_TTL_MS) return _screensPromise;
    _screensAt = Date.now();
    _screensPromise = api('/remote/screens').then(s => {
      const list = Array.isArray(s) ? s : [];
      if (!list.length) _screensPromise = null;
      return list;
    }).catch(() => { _screensPromise = null; return []; });
    return _screensPromise;
  }

  // ── Mount helpers ─────────────────────────────────────────────────────────
  function getMounts() {
    return Array.from(document.querySelectorAll('[data-remotef="mount"]'));
  }

  // ── Render dispatcher ─────────────────────────────────────────────────────
  // Branches to the control panel (feature already configured) or the setup
  // wizard (first-time / incomplete setup).
  function toolsInstalled(status) {
    return !!(status && status.installed && status.installed.sunshine && status.installed.tailscale);
  }

  // The setup stays on screen until it is closed: the two tools being installed
  // is only its first step, and the panel has no way to sign in or pair.
  function render(host, status) {
    if (toolsInstalled(status) && !_wizardOpen) {
      renderControlPanel(host, status);
    } else {
      renderWizard(host, status);
    }
  }

  // ── Control panel (feature configured — primary operational view) ─────────
  // Standalone and reusable: can be mounted in any host element.
  function renderControlPanel(host, status) {
    if (!host) return;
    host.textContent = '';

    const page = document.createElement('div');
    page.className = 'remote-page';

    // ── Section: Stato ────────────────────────────────────────────────────
    const statoBox = document.createElement('div');
    statoBox.className = 'remote-panel-section settings-section';

    const statoTitle = document.createElement('div');
    statoTitle.className = 'remote-section-title settings-section-title';
    statoTitle.setAttribute('data-i18n', 'remote.panel_status');
    statoTitle.textContent = 'Stato';
    statoBox.appendChild(statoTitle);

    // Access state row
    const accessRow = document.createElement('div');
    accessRow.className = 'remote-ready-row';

    const accessLabel = document.createElement('span');
    accessLabel.className = 'remote-ready-label';
    accessLabel.setAttribute('data-i18n', 'remote.panel_access');
    accessLabel.textContent = 'Accesso';
    accessRow.appendChild(accessLabel);

    const accessVal = document.createElement('span');
    const isBlocked = !!(status && status.blocked);
    const isReady = !!(status && status.ready);
    if (isBlocked) {
      accessVal.className = 'remote-ready-val remote-state-blocked';
      accessVal.setAttribute('data-i18n', 'remote.panel_blocked');
      accessVal.textContent = 'Accesso bloccato';
    } else if (isReady) {
      accessVal.className = 'remote-ready-val ok';
      accessVal.setAttribute('data-i18n', 'remote.panel_active');
      accessVal.textContent = 'Accesso attivo';
    } else {
      accessVal.className = 'remote-ready-val';
      accessVal.setAttribute('data-i18n', 'remote.panel_not_ready');
      accessVal.textContent = 'Non pronto';
    }
    accessRow.appendChild(accessVal);
    statoBox.appendChild(accessRow);

    // Connected device row
    const clients = (status && Array.isArray(status.connectedClients)) ? status.connectedClients : [];
    const clientRow = document.createElement('div');
    clientRow.className = 'remote-ready-row';

    const clientLabel = document.createElement('span');
    clientLabel.className = 'remote-ready-label';
    clientLabel.setAttribute('data-i18n', 'remote.panel_device');
    clientLabel.textContent = 'Dispositivo';
    clientRow.appendChild(clientLabel);

    const clientVal = document.createElement('span');
    if (clients.length > 0) {
      const first = clients[0];
      const name = typeof first === 'string' ? first : (first && first.name) || null;
      clientVal.className = 'remote-ready-val ok';
      if (name) {
        clientVal.textContent = name; // dynamic → textContent
      } else {
        clientVal.setAttribute('data-i18n', 'remote.panel_connected');
        clientVal.textContent = 'Connesso';
      }
    } else {
      clientVal.className = 'remote-ready-val';
      clientVal.setAttribute('data-i18n', 'remote.panel_no_device');
      clientVal.textContent = 'Nessun dispositivo';
    }
    clientRow.appendChild(clientVal);
    statoBox.appendChild(clientRow);

    // Tailscale IP row
    const ts = (status && status.tailscale) || {};
    if (ts.ip) {
      const ipRow = document.createElement('div');
      ipRow.className = 'remote-ready-row';

      const ipLabel = document.createElement('span');
      ipLabel.className = 'remote-ready-label';
      ipLabel.setAttribute('data-i18n', 'remote.status_tailscale_ip');
      ipLabel.textContent = 'IP Tailscale';
      ipRow.appendChild(ipLabel);

      const ipVal = document.createElement('span');
      ipVal.className = 'remote-ready-val';
      ipVal.textContent = ts.ip; // dynamic → textContent
      ipRow.appendChild(ipVal);
      statoBox.appendChild(ipRow);
    }

    // Selettore schermo
    const screenRow = document.createElement('div');
    screenRow.className = 'remote-panel-screen-row';

    const screenLabel = document.createElement('label');
    screenLabel.className = 'remote-panel-label';
    screenLabel.setAttribute('data-i18n', 'remote.screen_select_label');
    screenLabel.textContent = 'Monitor attivo:';

    const screenSelect = document.createElement('select');
    screenSelect.className = 'remote-panel-select';

    // Fetch available screens and populate the select (cached for the session)
    loadRemoteScreens().then(screens => {
      screenSelect.textContent = ''; // clear placeholder options
      if (!Array.isArray(screens) || screens.length === 0) {
        screenSelect.disabled = true;
        const opt = document.createElement('option');
        opt.setAttribute('data-i18n', 'remote.no_monitors');
        opt.textContent = 'Nessun monitor rilevato';
        screenSelect.appendChild(opt);
        localizeSubtree(screenSelect.parentElement || host);
      } else {
        screens.forEach(m => {
          const opt = document.createElement('option');
          opt.value = String(m.id); // safe: id is set as attribute value, not innerHTML
          opt.textContent = m.name; // dynamic → textContent
          if (m.active) opt.selected = true;
          screenSelect.appendChild(opt);
        });
      }
      // Sostituisce il <select> nativo (tendina bianca illeggibile) con il
      // dropdown stilizzato del progetto, coerente col tema. .value e l'evento
      // change continuano a funzionare invariati.
      if (window.initCustomSelect) window.initCustomSelect(screenSelect);
    }).catch(() => {
      screenSelect.disabled = true;
      const opt = document.createElement('option');
      opt.textContent = t('remote.monitors_failed');
      screenSelect.appendChild(opt);
    });

    const screenStatus = document.createElement('div');
    screenStatus.className = 'remote-status';
    screenStatus.hidden = true;

    screenSelect.addEventListener('change', () => {
      const id = screenSelect.value;
      screenSelect.disabled = true;
      screenStatus.hidden = true;
      api('/remote/screen', 'POST', { id }).then((res) => {
        if (!res || res.ok !== true) throw new Error('screen_failed');
        return refreshStatus();
      }).then(() => {
        renderAll();
      }).catch(() => {
        screenSelect.disabled = false;
        screenStatus.hidden = false;
        screenStatus.className = 'remote-status error';
        screenStatus.textContent = t('remote.screen_failed');
      });
    });

    screenRow.appendChild(screenLabel);
    screenRow.appendChild(screenSelect);
    statoBox.appendChild(screenRow);
    statoBox.appendChild(screenStatus);

    page.appendChild(statoBox);

    // ── Section: Azioni ───────────────────────────────────────────────────
    const actionsBox = document.createElement('div');
    actionsBox.className = 'remote-panel-section settings-section';

    const actionsTitle = document.createElement('div');
    actionsTitle.className = 'remote-section-title settings-section-title';
    actionsTitle.setAttribute('data-i18n', 'remote.panel_actions');
    actionsTitle.textContent = 'Azioni';
    actionsBox.appendChild(actionsTitle);

    const primaryRow = document.createElement('div');
    primaryRow.className = 'remote-controls-row';

    // Shared inline feedback for every panel action. Before this, a failed
    // disconnect/block/kill just silently re-enabled its button — the user had
    // no way to tell "done instantly" from "failed"; now failures say so.
    const actionStatus = document.createElement('div');
    actionStatus.className = 'remote-status';
    actionStatus.hidden = true;
    const actionFailed = (btn) => () => {
      if (btn) btn.disabled = false;
      actionStatus.hidden = false;
      actionStatus.className = 'remote-status error';
      actionStatus.textContent = t('remote.network_error');
    };

    // Disconnetti ora
    const disconnectBtn = document.createElement('button');
    disconnectBtn.type = 'button';
    disconnectBtn.className = 'remote-btn';
    disconnectBtn.setAttribute('data-i18n', 'remote.disconnect');
    disconnectBtn.textContent = 'Disconnetti ora';
    disconnectBtn.addEventListener('click', () => {
      disconnectBtn.disabled = true;
      actionStatus.hidden = true;
      api('/remote/session/close', 'POST').then(() => refreshStatus()).then(() => renderAll())
        .catch(actionFailed(disconnectBtn));
    });
    primaryRow.appendChild(disconnectBtn);

    // Blocca / Riattiva
    const blockBtn = document.createElement('button');
    blockBtn.type = 'button';
    if (isBlocked) {
      blockBtn.className = 'remote-btn primary';
      blockBtn.setAttribute('data-i18n', 'remote.unblock');
      blockBtn.textContent = 'Riattiva accesso';
      blockBtn.addEventListener('click', () => {
        blockBtn.disabled = true;
        actionStatus.hidden = true;
        api('/remote/unblock', 'POST').then(() => refreshStatus()).then(() => renderAll())
          .catch(actionFailed(blockBtn));
      });
    } else {
      blockBtn.className = 'remote-btn';
      blockBtn.setAttribute('data-i18n', 'remote.block');
      blockBtn.textContent = 'Blocca accesso';
      blockBtn.addEventListener('click', () => {
        blockBtn.disabled = true;
        actionStatus.hidden = true;
        api('/remote/block', 'POST').then(() => refreshStatus()).then(() => renderAll())
          .catch(actionFailed(blockBtn));
      });
    }
    primaryRow.appendChild(blockBtn);

    actionsBox.appendChild(primaryRow);
    actionsBox.appendChild(actionStatus);

    // ── Secondary row: Kill-switch + Riconfigura credenziali ──────────────
    const secondaryRow = document.createElement('div');
    secondaryRow.className = 'remote-controls-row remote-panel-secondary-row';

    // Kill-switch
    const killBtn = document.createElement('button');
    killBtn.type = 'button';
    killBtn.className = 'remote-btn danger';
    killBtn.setAttribute('data-i18n', 'remote.kill_btn');
    killBtn.addEventListener('click', () => {
      killBtn.disabled = true;
      actionStatus.hidden = true;
      api('/remote/kill', 'POST').then(() => refreshStatus()).then(() => renderAll())
        .catch(actionFailed(killBtn));
    });
    // Riconfigura credenziali
    const reconfigBtn = document.createElement('button');
    reconfigBtn.type = 'button';
    reconfigBtn.className = 'remote-btn';
    reconfigBtn.setAttribute('data-i18n', 'remote.reconfigure');
    reconfigBtn.textContent = 'Riconfigura credenziali';

    const reconfigStatus = document.createElement('div');
    reconfigStatus.className = 'remote-status';
    reconfigStatus.hidden = true;

    reconfigBtn.addEventListener('click', () => {
      reconfigBtn.disabled = true;
      reconfigStatus.hidden = false;
      reconfigStatus.className = 'remote-status';
      reconfigStatus.textContent = t('remote.reconfiguring');
      api('/remote/sunshine/configure', 'POST').then(res => {
        if (res && res.ok) {
          reconfigStatus.className = 'remote-status ok';
          reconfigStatus.textContent = t('remote.reconfigured');
          return refreshStatus().then(() => renderAll());
        } else {
          reconfigStatus.className = 'remote-status error';
          reconfigStatus.textContent = configureError(res);
          reconfigBtn.disabled = false;
        }
      }).catch(() => {
        reconfigStatus.className = 'remote-status error';
        reconfigStatus.textContent = configureError();
        reconfigBtn.disabled = false;
      });
    });
    secondaryRow.appendChild(reconfigBtn);

    // Signing in and pairing live in the setup, and the setup lives in Settings.
    if (host.closest('#settings-overlay')) {
      secondaryRow.appendChild(button('settings-btn' + (isReady || isBlocked ? '' : ' primary'), 'remote.setup_open', () => {
        _wizardOpen = true;
        renderAll();
      }));
    }
    secondaryRow.appendChild(killBtn);

    actionsBox.appendChild(secondaryRow);
    actionsBox.appendChild(reconfigStatus);
    actionsBox.appendChild(buildOnDemandToggle(status));

    page.appendChild(actionsBox);

    host.appendChild(page);
    localizeSubtree(host);
  }

  // ── Wizard renderer (first-time / incomplete setup) ───────────────────────
  function renderWizard(host, status) {
    if (!host) return;
    host.textContent = '';
    const page = document.createElement('div');
    page.className = 'remote-page';

    if (_wizardOpen) {
      page.appendChild(buildWizard(status));
      // Nothing to enable or disable until the tools are on this PC.
      if (toolsInstalled(status)) page.appendChild(buildControls(status));
    } else {
      page.append(buildIntro(), buildWarnings());
    }

    host.appendChild(page);
    localizeSubtree(host);
  }

  // ── Pieces of a Settings page (SettingsPage.css) ──────────────────────────
  function el(tag, className, key) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (key) node.setAttribute('data-i18n', key);
    return node;
  }

  function section(titleKey) {
    const box = el('section', 'settings-section');
    box.appendChild(el('div', 'settings-section-title', titleKey));
    return box;
  }

  function button(className, key, onClick) {
    const btn = el('button', className, key);
    btn.type = 'button';
    btn.addEventListener('click', () => onClick(btn));
    return btn;
  }

  function keyRow(...keys) {
    const row = el('div', 'settings-row settings-row-keys');
    row.append(...keys);
    return row;
  }

  function statusLine() {
    const line = el('div', 'remote-status');
    line.hidden = true;
    return line;
  }

  // The cause rides along when the server has one: a generic line alone would
  // hide the real failure.
  function configureError(res) {
    return t('remote.configure_failed') + (res && res.error ? ' (' + res.error + ')' : '');
  }

  // ── What this is, and the consent ─────────────────────────────────────────
  function buildIntro() {
    const box = section('remote.intro_title');
    // Where the software comes from, named honestly per platform. Telling a
    // Linux user their packages arrive "via winget, Microsoft's official
    // package manager" is worse than saying nothing: it describes a machine
    // they are not sitting at.
    for (const key of ['remote.intro_p1', platformKey('remote.intro_p2'), 'remote.intro_p3']) {
      box.appendChild(el('p', 'settings-note', key));
    }
    return box;
  }

  function buildWarnings() {
    const box = section('remote.warnings_title');
    const list = el('ul', 'remote-warn-list');
    // "Windows will ask for a UAC confirmation" is true on one platform out of
    // three. The prompt itself is universal — pkexec on Linux, the admin
    // dialog on macOS — so the sentence names the moment, not the vendor.
    const items = ['remote.warn_elevate', 'remote.warn_tailscale', 'remote.warn_pin', 'remote.warn_controllable'];
    // macOS only, and stated up front rather than discovered later: upstream
    // marks its own macOS build experimental, and gamepads do not work there.
    // Someone setting this up to play with a controller should learn that here.
    if (platform() === 'darwin') items.push('remote.warn_macos_experimental');
    for (const key of items) list.appendChild(el('li', null, key));
    box.appendChild(list);
    box.appendChild(keyRow(button('settings-btn primary', 'remote.consent_btn', () => {
      _wizardOpen = true;
      renderAll();
    })));
    return box;
  }

  // ── Setup ─────────────────────────────────────────────────────────────────
  function stepsDone(status) {
    const s = status || {};
    return [
      toolsInstalled(s),
      !!(s.tailscale && s.tailscale.connected),
      !!s.sunshineResponding,
      Array.isArray(s.connectedClients) && s.connectedClients.length > 0,
    ];
  }

  // The first step not done yet holds the page's one main action, and the steps
  // after it wait with their names only: their controls could not work yet.
  function buildWizard(status) {
    const done = stepsDone(status);
    const current = done.indexOf(false);
    const wizard = el('div', 'remote-wizard');
    const head = el('div', 'settings-steps-head');
    head.appendChild(el('div', 'settings-section-title', 'remote.wizard_title'));
    if (toolsInstalled(status)) {
      head.appendChild(button('settings-btn', 'remote.setup_close', () => {
        _wizardOpen = false;
        renderAll();
      }));
    }
    const steps = el('div', 'settings-steps');
    [buildStep1, buildStep2, buildStep3, buildStep4].forEach((build, i) => {
      const step = build(status, done[i], i === current);
      step.querySelector('.settings-step-body').hidden = current >= 0 && i > current;
      steps.appendChild(step);
    });
    wizard.append(head, steps);
    return wizard;
  }

  // Step 1 — Install tools
  function buildStep1(status, done, current) {
    const installed = (status && status.installed) || {};
    const step = buildStepShell('1', 'remote.step1_title', done, current);
    const body = step.querySelector('.settings-step-body');

    body.appendChild(buildInstallRow('Sunshine', 'remote.sunshine_status_installed', 'remote.sunshine_status_missing',
      !!installed.sunshine, current, () => installTool('sunshine')));
    body.appendChild(buildInstallRow('Tailscale', 'remote.tailscale_status_installed', 'remote.tailscale_status_missing',
      !!installed.tailscale, current && !!installed.sunshine, () => installTool('tailscale')));

    if (!done) body.appendChild(el('p', 'settings-note', 'remote.step1_hint'));
    return step;
  }

  function buildInstallRow(toolName, okKey, missingKey, isInstalled, main, onInstall) {
    const row = el('div', 'settings-row');
    const words = el('span', 'settings-label-line');
    const name = el('span');
    name.textContent = toolName;
    const statusEl = el('span', 'settings-hint', isInstalled ? okKey : missingKey);
    words.append(name, statusEl);
    row.appendChild(words);
    if (isInstalled) return row;

    row.appendChild(button('settings-btn' + (main ? ' primary' : ''), 'remote.install_btn', (btn) => {
      btn.disabled = true;
      // An install can legitimately take minutes and the elevated window doesn't
      // report progress here — tick the elapsed time so the row visibly stays
      // alive instead of looking hung.
      const startedAt = Date.now();
      const tick = () => {
        const secs = Math.round((Date.now() - startedAt) / 1000);
        statusEl.textContent = secs < 20 ? t('remote.installing') : t('remote.installing_long').replace('{s}', secs);
      };
      tick();
      const ticker = setInterval(tick, 5000);
      const fail = () => {
        clearInterval(ticker);
        btn.disabled = false;
        statusEl.textContent = t('remote.try_again');
      };
      // /remote/install replies {ok:false} (HTTP 500) when the post-install
      // verify fails — a resolved promise is NOT success by itself.
      onInstall().then((res) => {
        if (!res || res.ok !== true) { fail(); return; }
        clearInterval(ticker);
        refreshStatus().then(renderAll);
      }).catch(fail);
    }));
    return row;
  }

  // Step 2 — Tailscale login
  function buildStep2(status, done, current) {
    const ts = (status && status.tailscale) || {};
    const step = buildStepShell('2', 'remote.step2_title', done, current);
    const body = step.querySelector('.settings-step-body');

    if (done) {
      const ok = el('p', 'settings-note');
      ok.textContent = t('remote.tailscale_connected') + (ts.ip ? ', ' + ts.ip : ''); // dynamic → textContent
      body.appendChild(ok);
      return step;
    }

    const statusEl = statusLine();
    body.append(
      el('p', 'settings-note', 'remote.step2_hint'),
      button('settings-btn' + (current ? ' primary' : ''), 'remote.tailscale_login_btn', (btn) => {
        btn.disabled = true;
        statusEl.hidden = false;
        statusEl.className = 'remote-status';
        statusEl.textContent = t('remote.login_waiting');
        tailscaleLogin(statusEl, btn);
      }),
      statusEl,
    );
    return step;
  }

  // Step 3 — Configure Sunshine
  function buildStep3(status, done, current) {
    const step = buildStepShell('3', 'remote.step3_title', done, current);
    const body = step.querySelector('.settings-step-body');

    if (done) {
      body.appendChild(el('p', 'settings-note', 'remote.sunshine_configured'));
      return step;
    }

    const statusEl = statusLine();
    body.append(
      el('p', 'settings-note', 'remote.step3_hint'),
      button('settings-btn' + (current ? ' primary' : ''), 'remote.sunshine_configure_btn', (btn) => {
        btn.disabled = true;
        statusEl.hidden = false;
        statusEl.className = 'remote-status';
        statusEl.textContent = t('remote.configuring');
        configureSunshine(statusEl, btn);
      }),
      statusEl,
    );
    return step;
  }

  // Step 4 — Pairing PIN
  function buildStep4(status, done, current) {
    const step = buildStepShell('4', 'remote.step4_title', done, current);
    const body = step.querySelector('.settings-step-body');

    const pinInput = el('input', 'settings-text-input remote-pin-input');
    pinInput.type = 'text';
    pinInput.maxLength = 8;
    pinInput.setAttribute('inputmode', 'numeric');
    pinInput.setAttribute('autocomplete', 'off');
    pinInput.setAttribute('spellcheck', 'false');
    pinInput.setAttribute('data-i18n-placeholder', 'remote.pin_placeholder');

    const statusEl = statusLine();
    const pinBtn = button('settings-btn' + (current ? ' primary' : ''), 'remote.pin_send_btn', (btn) => {
      const pin = pinInput.value.trim();
      if (!pin) return;
      btn.disabled = true;
      statusEl.hidden = false;
      statusEl.className = 'remote-status';
      statusEl.textContent = t('remote.pin_sending');
      sendPin(pin, statusEl, btn, pinInput);
    });
    pinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') pinBtn.click();
    });

    const pinRow = el('div', 'remote-pin-row');
    pinRow.append(pinInput, pinBtn);
    body.append(el('p', 'settings-note', 'remote.step4_hint'), pinRow, statusEl);
    return step;
  }

  // ── Controls (remove devices, disable, enable) ────────────────────────────
  function buildControls(status) {
    const box = section('remote.controls_title');
    box.appendChild(keyRow(
      button('settings-btn', 'remote.enable_btn', enable),
      button('settings-btn', 'remote.disable_btn', disable),
      button('settings-btn danger', 'remote.kill_btn', killSwitch),
    ));
    box.appendChild(buildOnDemandToggle(status));
    return box;
  }

  // On-demand startup (shared by the setup controls and the panel): keeps
  // Sunshine/Tailscale from auto-starting with the system.
  function buildOnDemandToggle(status) {
    const row = el('label', 'settings-toggle-row');
    const input = el('input', 'settings-check');
    input.type = 'checkbox';
    input.checked = !!(status && status.onDemand);
    input.addEventListener('change', () => setOnDemand(input.checked, input));
    const words = el('span', 'settings-label-line');
    // Off Windows this manages Sunshine ALONE, as a user service — no password,
    // and deliberately not the user's VPN (see remote-control/service.js). Two
    // different promises, so two different sentences.
    words.append(el('span', null, 'remote.ondemand_label'), el('span', 'settings-hint', platformKey('remote.ondemand_hint')));
    row.append(input, words);
    return row;
  }

  // ── Step shell builder ────────────────────────────────────────────────────
  function buildStepShell(num, titleKey, done, current) {
    const step = el('div', 'settings-step' + (done ? ' done' : '') + (current ? ' current' : ''));
    const head = el('div', 'settings-step-head');
    const numEl = el('span', 'settings-step-num');
    numEl.textContent = done ? '✓' : num;
    head.append(numEl, el('span', 'settings-step-title', titleKey));
    step.append(head, el('div', 'settings-step-body'));
    return step;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async function refreshStatus() {
    try {
      _status = await api('/remote/status');
    } catch {
      _status = null;
    }
    return _status;
  }

  async function installTool(tool) {
    return api('/remote/install', 'POST', { tool });
  }

  async function tailscaleLogin(statusEl, btn) {
    try {
      const res = await api('/remote/tailscale/login', 'POST');
      if (!res.ok) throw new Error('login failed');
    } catch {
      statusEl.className = 'remote-status error';
      statusEl.textContent = t('remote.try_again');
      if (btn) btn.disabled = false;
      return;
    }

    // Poll until connected or timeout
    let attempts = 0;
    clearTimeout(_pollTimer);

    function poll() {
      attempts++;
      refreshStatus().then(s => {
        const ts = (s && s.tailscale) || {};
        if (ts.connected) {
          statusEl.className = 'remote-status ok';
          statusEl.textContent = t('remote.panel_connected');
          renderAll();
          return;
        }
        if (attempts >= POLL_MAX_ATTEMPTS) {
          statusEl.className = 'remote-status error';
          statusEl.textContent = t('remote.login_timeout');
          if (btn) btn.disabled = false;
          return;
        }
        _pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      }).catch(() => {
        statusEl.className = 'remote-status error';
        statusEl.textContent = t('remote.network_error');
        if (btn) btn.disabled = false;
      });
    }

    _pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  }

  async function configureSunshine(statusEl, btn) {
    try {
      const res = await api('/remote/sunshine/configure', 'POST');
      if (!res.ok) {
        statusEl.className = 'remote-status error';
        statusEl.textContent = configureError(res);
        if (btn) btn.disabled = false;
        return;
      }
      statusEl.className = 'remote-status ok';
      statusEl.textContent = t('remote.sunshine_configured');
      await refreshStatus();
      renderAll();
    } catch {
      statusEl.className = 'remote-status error';
      statusEl.textContent = configureError();
      if (btn) btn.disabled = false;
    }
  }

  async function sendPin(pin, statusEl, btn, pinInput) {
    try {
      const res = await api('/remote/pin', 'POST', { pin });
      if (!res.ok) {
        statusEl.className = 'remote-status error';
        // Distinguo l'errore reale: 401 = problema di credenziali/servizio
        // Sunshine (non un PIN sbagliato); altri status = rifiuto generico.
        if (res.status === 401) {
          statusEl.textContent = t('remote.pin_401');
        } else if (res.status) {
          statusEl.textContent = t('remote.pin_refused').replace('{code}', res.status);
        } else {
          statusEl.textContent = t('remote.pin_wrong');
        }
        if (btn) btn.disabled = false;
        return;
      }
      statusEl.className = 'remote-status ok';
      statusEl.textContent = t('remote.pin_ok');
      if (pinInput) pinInput.value = '';
      await refreshStatus();
      renderAll();
    } catch {
      statusEl.className = 'remote-status error';
      statusEl.textContent = t('remote.network_error');
      if (btn) btn.disabled = false;
    }
  }

  async function killSwitch(btn) {
    if (btn) btn.disabled = true;
    try {
      await api('/remote/kill', 'POST');
      await refreshStatus();
      renderAll();
    } catch {
      if (btn) btn.disabled = false;
    }
  }

  async function enable(btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await api('/remote/enable', 'POST');
      if (r && r.ok === false && /^sunshine_/.test(String(r.error || ''))) {
        // Remote desktop stays off on a Sunshine with known takeover flaws.
        const tr = (k, fb) => (typeof window.t === 'function' && window.t(k)) || fb;
        if (typeof showHubToast === 'function') {
          showHubToast('Xenon', tr('rc_sunshine_old_title', 'Sunshine needs an update'),
            tr('rc_sunshine_old', 'This version has security flaws and could not be updated automatically. Update Sunshine to the latest version, then try again.'));
        }
        if (btn) btn.disabled = false;
        return;
      }
      await refreshStatus();
      renderAll();
    } catch {
      if (btn) btn.disabled = false;
    }
  }

  async function disable(btn) {
    if (btn) btn.disabled = true;
    try {
      await api('/remote/disable', 'POST');
      await refreshStatus();
      renderAll();
    } catch {
      if (btn) btn.disabled = false;
    }
  }

  // Toggle on-demand startup. The server runs an elevated Set-Service (one UAC);
  // a declined prompt leaves the services unchanged and the flag unset, so we
  // always re-read the real state and re-render — the toggle never lies.
  async function setOnDemand(value, btn) {
    if (btn) btn.disabled = true;
    try {
      const res = await api('/remote/ondemand', 'POST', { value });
      if (!res || !res.ok) throw new Error('failed');
    } catch {
      /* UAC declined or error: state below reflects reality */
    }
    await refreshStatus().catch(() => {});
    renderAll();
  }

  // ── Re-render all mounts ──────────────────────────────────────────────────
  function renderAll() {
    const mounts = getMounts();
    if (!mounts.length) return;
    mounts.forEach(m => render(m, _status));
  }

  // ── Dashboard widget render ───────────────────────────────────────────────
  // Called by dashboard-layout.js `applyDashboardLayout` (remoteRender step).
  // Renders all [data-dashboard-widget="remote"] tiles in the DOM — both the
  // primary tile and any duplicated copies. Each tile's inner `.remote-widget-mount`
  // is the live host for renderControlPanel (or the disabled notice).
  function renderWidgets() {
    if (typeof document === 'undefined') return;
    // Only tiles actually placed on a dashboard page — a hidden / never-added
    // widget sits in the #widget-pool (outside any .pager-page) and must not
    // trigger the /remote/screens probe.
    const tiles = Array.from(document.querySelectorAll('[data-dashboard-widget="remote"]')).filter(el => el.closest('.pager-page, .layer-slot'));
    if (!tiles.length) return;
    const configured = toolsInstalled(_status);
    tiles.forEach(tile => {
      const mount = tile.querySelector('.remote-widget-mount');
      if (!mount) return;
      if (!configured) {
        // If status is not yet known, kick a fetch so a later layout pass will
        // show the right content; show the disabled notice in the meantime.
        if (!_status) {
          refreshStatus().then(() => renderWidgets());
        }
        renderWidgetDisabled(mount);
        return;
      }
      renderControlPanel(mount, _status);
    });
  }

  // Minimal "not configured" notice shown inside a dashboard tile when the
  // feature is not yet set up. Avoids displaying the full wizard inside a small
  // tile. Directs the user to Settings where the full wizard lives.
  function renderWidgetDisabled(host) {
    if (!host) return;
    host.textContent = '';
    const notice = document.createElement('div');
    notice.className = 'remote-widget-disabled';
    const msg = document.createElement('span');
    msg.setAttribute('data-i18n', 'remote.widget_disabled');
    msg.textContent = 'Controllo remoto non attivo: abilitalo in Impostazioni';
    notice.appendChild(msg);
    host.appendChild(notice);
    localizeSubtree(host);
  }

  // ── Scoped i18n pass (mirrors lighting-page.js pattern) ──────────────────
  // Runs ONLY on our injected subtree to avoid triggering a settings-modal
  // re-render (which would call renderSettingsModal → syncSettingsControls →
  // RemoteControl.init → here, causing an infinite cycle).
  function localizeSubtree(root) {
    if (!root || typeof t !== 'function') return;
    root.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
  }

  // ── Public init ───────────────────────────────────────────────────────────
  async function init(host) {
    // Guard: if there's no remote-control mount anywhere on the page
    // (e.g. a stripped-down host page without it), bail silently.
    let mounts = getMounts();
    if (!mounts.length) {
      const fallback = host || document.querySelector('#settings-remote-hub');
      if (fallback) mounts = [fallback];
    }
    if (!mounts.length) return;

    _mounted = true;

    // Fetch status; render immediately with whatever we have (may be null on
    // first call — each step degrades gracefully to "not installed" state).
    const status = await refreshStatus();
    mounts.forEach(m => render(m, status));
  }

  // Expose globally — settings.js calls window.RemoteControl.init() from
  // syncSettingsControls() when the remote tab is shown.
  // getStatus() returns the last cached /remote/status response so Deck keys
  // can derive remoteConnected/remoteActive without an extra network call.
  // isConfigured() returns true once _status confirms both tools are installed.
  // Starts false (unknown) — the editor's refreshCapabilities() fetch is the
  // authoritative first-open path; this getter covers any caller that needs a
  // synchronous check after the settings panel has already fetched /remote/status.
  // renderControlPanel and refreshStatus are also exposed so the dashboard widget
  // render path can call them directly.
  // renderWidgets re-renders all [data-dashboard-widget="remote"] tiles; called by
  // applyDashboardLayout (remoteRender step in dashboard-layout.js).
  window.RemoteControl = {
    init,
    isMounted: () => _mounted,
    getStatus: () => _status,
    isConfigured: () => toolsInstalled(_status),
    refreshStatus,
    renderControlPanel,
    renderWidgets,
  };
})();
