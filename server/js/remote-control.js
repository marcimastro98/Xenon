// Remote Control settings page — guided setup wizard for Sunshine + Tailscale.
// Renders into #settings-remote-hub (Settings → Controllo Remoto).
// Mirrors lighting-page.js module structure: IIFE, window.RemoteControl exposed.
(function () {
  'use strict';

  const POLL_INTERVAL_MS = 3000;
  const POLL_MAX_ATTEMPTS = 40; // ~2 min before giving up

  let _mounted = false;

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
  function render(host, status) {
    const configured = !!(
      status &&
      status.installed &&
      status.installed.sunshine &&
      status.installed.tailscale
    );
    if (configured) {
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
    statoBox.className = 'remote-panel-section';

    const statoTitle = document.createElement('div');
    statoTitle.className = 'remote-section-title';
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
        const prefix = document.createTextNode('Connesso: ');
        const nameSpan = document.createElement('strong');
        nameSpan.textContent = name; // dynamic → textContent
        clientVal.appendChild(prefix);
        clientVal.appendChild(nameSpan);
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

    page.appendChild(statoBox);

    // ── Section: Selettore schermo ────────────────────────────────────────
    const screenBox = document.createElement('div');
    screenBox.className = 'remote-panel-section';

    const screenTitle = document.createElement('div');
    screenTitle.className = 'remote-section-title';
    screenTitle.setAttribute('data-i18n', 'remote.screen_label');
    screenTitle.textContent = 'Schermo';
    screenBox.appendChild(screenTitle);

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
      opt.textContent = 'Errore caricamento monitor';
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
        screenStatus.textContent = 'Cambio schermo non riuscito — riprova.';
      });
    });

    screenRow.appendChild(screenLabel);
    screenRow.appendChild(screenSelect);
    screenBox.appendChild(screenRow);
    screenBox.appendChild(screenStatus);

    page.appendChild(screenBox);

    // ── Section: Azioni ───────────────────────────────────────────────────
    const actionsBox = document.createElement('div');
    actionsBox.className = 'remote-panel-section';

    const actionsTitle = document.createElement('div');
    actionsTitle.className = 'remote-section-title';
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
      actionStatus.textContent = 'Errore di rete — riprova.';
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
    killBtn.textContent = 'Kill-switch';
    killBtn.addEventListener('click', () => {
      killBtn.disabled = true;
      actionStatus.hidden = true;
      api('/remote/kill', 'POST').then(() => refreshStatus()).then(() => renderAll())
        .catch(actionFailed(killBtn));
    });
    secondaryRow.appendChild(killBtn);

    // Riconfigura credenziali
    const reconfigBtn = document.createElement('button');
    reconfigBtn.type = 'button';
    reconfigBtn.className = 'remote-btn remote-btn-secondary';
    reconfigBtn.setAttribute('data-i18n', 'remote.reconfigure');
    reconfigBtn.textContent = 'Riconfigura credenziali';

    const reconfigStatus = document.createElement('div');
    reconfigStatus.className = 'remote-status';
    reconfigStatus.hidden = true;

    reconfigBtn.addEventListener('click', () => {
      reconfigBtn.disabled = true;
      reconfigStatus.hidden = false;
      reconfigStatus.className = 'remote-status';
      reconfigStatus.textContent = 'Riconfigurazione in corso…';
      api('/remote/sunshine/configure', 'POST').then(res => {
        if (res && res.ok) {
          reconfigStatus.className = 'remote-status ok';
          reconfigStatus.textContent = 'Credenziali rigenerate con successo.';
          return refreshStatus().then(() => renderAll());
        } else {
          reconfigStatus.className = 'remote-status error';
          reconfigStatus.textContent = 'Errore: ' + ((res && res.error) || 'configurazione fallita');
          reconfigBtn.disabled = false;
        }
      }).catch(() => {
        reconfigStatus.className = 'remote-status error';
        reconfigStatus.textContent = 'Errore di rete — verifica che Sunshine sia in esecuzione.';
        reconfigBtn.disabled = false;
      });
    });
    secondaryRow.appendChild(reconfigBtn);

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

    // 1. Intro
    page.appendChild(buildIntro());

    // 2. Warnings
    page.appendChild(buildWarnings());

    // 3. Consent button (always visible if wizard not open)
    if (!_wizardOpen) {
      const row = document.createElement('div');
      row.className = 'remote-consent-row';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'remote-consent-btn';
      btn.setAttribute('data-i18n', 'remote.consent_btn');
      btn.textContent = 'Ho capito, configura';
      btn.addEventListener('click', () => {
        _wizardOpen = true;
        renderAll();
      });
      row.appendChild(btn);
      page.appendChild(row);
    }

    // 4. Wizard (visible after consent)
    if (_wizardOpen) {
      page.appendChild(buildWizard(status));
    }

    // 5. Controls (kill-switch / disable / enable) — shown if wizard open
    if (_wizardOpen) {
      page.appendChild(buildControls(status));
    }

    host.appendChild(page);
    localizeSubtree(host);
  }

  // ── Intro section ─────────────────────────────────────────────────────────
  function buildIntro() {
    const box = document.createElement('div');
    box.className = 'remote-intro';

    const title = document.createElement('div');
    title.className = 'remote-intro-title';
    title.setAttribute('data-i18n', 'remote.intro_title');
    title.textContent = 'Controllo remoto sicuro del PC';
    box.appendChild(title);

    const body = document.createElement('div');
    body.className = 'remote-intro-body';

    const lines = [
      { key: 'remote.intro_p1', text: 'Permette di accedere al desktop del PC da smartphone o tablet tramite la rete privata Tailscale (VPN peer-to-peer). Lo streaming video è gestito da Sunshine, il ricevitore gratuito Moonlight gira sul telefono.' },
      { key: 'remote.intro_p2', text: 'Sunshine e Tailscale vengono installati con winget (gestore pacchetti ufficiale Microsoft) direttamente dai repository ufficiali.' },
      { key: 'remote.intro_p3', text: 'Il server del dashboard NON viene mai esposto a internet. La connessione passa interamente dentro la tua rete Tailscale.' },
    ];
    lines.forEach(({ key, text }) => {
      const p = document.createElement('p');
      p.setAttribute('data-i18n', key);
      p.textContent = text;
      body.appendChild(p);
    });

    box.appendChild(body);
    return box;
  }

  // ── Warnings section ──────────────────────────────────────────────────────
  function buildWarnings() {
    const box = document.createElement('div');
    box.className = 'remote-warnings';

    const title = document.createElement('div');
    title.className = 'remote-warnings-title';
    title.setAttribute('data-i18n', 'remote.warnings_title');
    title.textContent = 'Prima di procedere';
    box.appendChild(title);

    const ul = document.createElement('ul');
    const items = [
      { key: 'remote.warn_uac', text: 'Windows chiederà una conferma UAC durante l\'installazione.' },
      { key: 'remote.warn_tailscale', text: 'Dovrai accedere con il tuo account Tailscale (gratuito per uso personale).' },
      { key: 'remote.warn_pin', text: 'Moonlight mostrerà un PIN di abbinamento da inserire qui.' },
      { key: 'remote.warn_controllable', text: 'Una volta configurato, il PC potrà essere controllato remotamente.' },
    ];
    items.forEach(({ key, text }) => {
      const li = document.createElement('li');
      li.setAttribute('data-i18n', key);
      li.textContent = text;
      ul.appendChild(li);
    });
    box.appendChild(ul);

    return box;
  }

  // ── Wizard ────────────────────────────────────────────────────────────────
  function buildWizard(status) {
    const wizard = document.createElement('div');
    wizard.className = 'remote-wizard';

    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'remote-section-title';
    sectionTitle.setAttribute('data-i18n', 'remote.wizard_title');
    sectionTitle.textContent = 'Configurazione guidata';
    wizard.appendChild(sectionTitle);

    wizard.appendChild(buildStep1(status));
    wizard.appendChild(buildStep2(status));
    wizard.appendChild(buildStep3(status));
    wizard.appendChild(buildStep4(status));
    wizard.appendChild(buildStep5(status));

    return wizard;
  }

  // Step 1 — Install tools
  function buildStep1(status) {
    const installed = (status && status.installed) || {};
    const sunshineOk = !!installed.sunshine;
    const tailscaleOk = !!installed.tailscale;
    const allDone = sunshineOk && tailscaleOk;

    const step = buildStepShell('1', 'remote.step1_title', 'Installa gli strumenti', allDone);
    const body = step.querySelector('.remote-step-body');

    // Sunshine row
    body.appendChild(buildInstallRow(
      'Sunshine',
      'remote.sunshine_status_installed', 'remote.sunshine_status_missing',
      '✓ Installato', 'Non installato',
      sunshineOk,
      () => installTool('sunshine'),
    ));

    // Tailscale row
    body.appendChild(buildInstallRow(
      'Tailscale',
      'remote.tailscale_status_installed', 'remote.tailscale_status_missing',
      '✓ Installato', 'Non installato',
      tailscaleOk,
      () => installTool('tailscale'),
    ));

    if (!allDone) {
      const hint = document.createElement('div');
      hint.className = 'remote-hint';
      hint.setAttribute('data-i18n', 'remote.step1_hint');
      hint.textContent = 'Potrebbe aprirsi una finestra UAC — confermala per procedere.';
      body.appendChild(hint);
    }

    return step;
  }

  function buildInstallRow(toolName, okKey, missingKey, okFallback, missingFallback, isInstalled, onInstall) {
    const row = document.createElement('div');
    row.className = 'remote-install-row';

    const labelWrap = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'remote-tool-label';
    label.textContent = toolName;
    labelWrap.appendChild(label);

    const statusEl = document.createElement('div');
    if (isInstalled) {
      statusEl.className = 'remote-tool-ok';
      statusEl.setAttribute('data-i18n', okKey);
      statusEl.textContent = okFallback;
    } else {
      statusEl.className = 'remote-tool-status';
      statusEl.setAttribute('data-i18n', missingKey);
      statusEl.textContent = missingFallback;
    }
    labelWrap.appendChild(statusEl);
    row.appendChild(labelWrap);

    if (!isInstalled) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'remote-btn';
      btn.setAttribute('data-i18n', 'remote.install_btn');
      btn.textContent = 'Installa';
      btn.addEventListener('click', () => {
        btn.disabled = true;
        // winget can legitimately take minutes and the elevated window doesn't
        // report progress here — tick the elapsed time so the row visibly stays
        // alive instead of looking hung.
        const startedAt = Date.now();
        const tick = () => {
          const secs = Math.round((Date.now() - startedAt) / 1000);
          statusEl.textContent = secs < 20
            ? 'Installazione in corso…'
            : `Installazione in corso… (${secs}s — può richiedere qualche minuto)`;
        };
        tick();
        const ticker = setInterval(tick, 5000);
        const fail = () => {
          clearInterval(ticker);
          btn.disabled = false;
          statusEl.textContent = 'Errore — riprova';
        };
        // /remote/install replies {ok:false} (HTTP 500) when the post-install
        // verify fails — a resolved promise is NOT success by itself.
        onInstall().then((res) => {
          if (!res || res.ok !== true) { fail(); return; }
          clearInterval(ticker);
          refreshStatus().then(renderAll);
        }).catch(fail);
      });
      row.appendChild(btn);
    }

    return row;
  }

  // Step 2 — Tailscale login
  function buildStep2(status) {
    const ts = (status && status.tailscale) || {};
    const connected = !!ts.connected;

    const step = buildStepShell('2', 'remote.step2_title', 'Accedi a Tailscale', connected);
    const body = step.querySelector('.remote-step-body');

    if (connected) {
      const ok = document.createElement('div');
      ok.className = 'remote-status ok';
      ok.setAttribute('data-i18n', 'remote.tailscale_connected');
      ok.textContent = 'Tailscale connesso';
      if (ts.ip) {
        ok.textContent = '';
        const connText = document.createTextNode('Tailscale connesso — ');
        const ipSpan = document.createElement('strong');
        ipSpan.textContent = ts.ip; // dynamic data → textContent
        ok.appendChild(connText);
        ok.appendChild(ipSpan);
      }
      body.appendChild(ok);
    } else {
      const hint = document.createElement('div');
      hint.className = 'remote-hint';
      hint.setAttribute('data-i18n', 'remote.step2_hint');
      hint.textContent = 'Verrà aperta una pagina nel browser per autenticarsi. Torna qui quando è fatto.';
      body.appendChild(hint);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'remote-btn primary';
      btn.setAttribute('data-i18n', 'remote.tailscale_login_btn');
      btn.textContent = 'Apri pagina di login';

      const statusEl = document.createElement('div');
      statusEl.className = 'remote-status';
      statusEl.hidden = true;

      btn.addEventListener('click', () => {
        btn.disabled = true;
        statusEl.hidden = false;
        statusEl.className = 'remote-status';
        statusEl.textContent = 'In attesa di autenticazione…';
        tailscaleLogin(statusEl, btn);
      });

      body.appendChild(btn);
      body.appendChild(statusEl);
    }

    return step;
  }

  // Step 3 — Configure Sunshine
  function buildStep3(status) {
    const sunshineOk = !!(status && status.sunshineResponding);
    const step = buildStepShell('3', 'remote.step3_title', 'Configura Sunshine', sunshineOk);
    const body = step.querySelector('.remote-step-body');

    if (sunshineOk) {
      const ok = document.createElement('div');
      ok.className = 'remote-status ok';
      ok.setAttribute('data-i18n', 'remote.sunshine_configured');
      ok.textContent = 'Sunshine configurato e in ascolto';
      body.appendChild(ok);
    } else {
      const hint = document.createElement('div');
      hint.className = 'remote-hint';
      hint.setAttribute('data-i18n', 'remote.step3_hint');
      hint.textContent = 'Avvia Sunshine e aggiorna le impostazioni di rete per renderlo raggiungibile da Moonlight.';
      body.appendChild(hint);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'remote-btn primary';
      btn.setAttribute('data-i18n', 'remote.sunshine_configure_btn');
      btn.textContent = 'Configura Sunshine';

      const statusEl = document.createElement('div');
      statusEl.className = 'remote-status';
      statusEl.hidden = true;

      btn.addEventListener('click', () => {
        btn.disabled = true;
        statusEl.hidden = false;
        statusEl.className = 'remote-status';
        statusEl.textContent = 'Configurazione in corso…';
        configureSunshine(statusEl, btn);
      });

      body.appendChild(btn);
      body.appendChild(statusEl);
    }

    return step;
  }

  // Step 4 — Pairing PIN
  function buildStep4(status) {
    const paired = !!(status && Array.isArray(status.connectedClients) && status.connectedClients.length > 0);
    const step = buildStepShell('4', 'remote.step4_title', 'Abbinamento Moonlight', paired);
    const body = step.querySelector('.remote-step-body');

    const hint = document.createElement('div');
    hint.className = 'remote-hint';
    hint.setAttribute('data-i18n', 'remote.step4_hint');
    hint.textContent = 'Apri Moonlight sul telefono, seleziona questo PC e inserisci il PIN che appare sullo schermo del telefono.';
    body.appendChild(hint);

    const pinRow = document.createElement('div');
    pinRow.className = 'remote-pin-row';

    const pinInput = document.createElement('input');
    pinInput.type = 'text';
    pinInput.className = 'remote-pin-input';
    pinInput.maxLength = 8;
    pinInput.setAttribute('inputmode', 'numeric');
    pinInput.setAttribute('autocomplete', 'off');
    pinInput.setAttribute('spellcheck', 'false');
    pinInput.setAttribute('data-i18n-placeholder', 'remote.pin_placeholder');
    pinInput.placeholder = '1234';

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'remote-btn primary';
    pinBtn.setAttribute('data-i18n', 'remote.pin_send_btn');
    pinBtn.textContent = 'Abbina';

    const statusEl = document.createElement('div');
    statusEl.className = 'remote-status';
    statusEl.hidden = true;

    pinBtn.addEventListener('click', () => {
      const pin = pinInput.value.trim();
      if (!pin) return;
      pinBtn.disabled = true;
      statusEl.hidden = false;
      statusEl.className = 'remote-status';
      statusEl.textContent = 'Invio PIN…';
      sendPin(pin, statusEl, pinBtn, pinInput);
    });

    pinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') pinBtn.click();
    });

    pinRow.appendChild(pinInput);
    pinRow.appendChild(pinBtn);
    body.appendChild(pinRow);
    body.appendChild(statusEl);

    return step;
  }

  // Step 5 — Ready / status summary
  function buildStep5(status) {
    const ready = !!(status && status.ready);
    const step = buildStepShell('5', 'remote.step5_title', 'Stato', ready);
    const body = step.querySelector('.remote-step-body');

    body.appendChild(buildStatusSummary(status));

    return step;
  }

  // Aggregated status grid
  function buildStatusSummary(status) {
    const grid = document.createElement('div');
    grid.className = 'remote-ready-grid';

    const ts = (status && status.tailscale) || {};
    const installed = (status && status.installed) || {};
    const clients = (status && Array.isArray(status.connectedClients)) ? status.connectedClients : [];

    const rows = [
      { labelKey: 'remote.status_sunshine', labelFallback: 'Sunshine', val: installed.sunshine ? '✓' : '—', ok: !!installed.sunshine },
      { labelKey: 'remote.status_tailscale', labelFallback: 'Tailscale', val: ts.connected ? '✓' : '—', ok: !!ts.connected },
      { labelKey: 'remote.status_tailscale_ip', labelFallback: 'IP Tailscale', val: ts.ip || '—', ok: !!ts.ip },
      { labelKey: 'remote.status_sunshine_responding', labelFallback: 'Sunshine in ascolto', val: status && status.sunshineResponding ? '✓' : '—', ok: !!(status && status.sunshineResponding) },
      { labelKey: 'remote.status_ready', labelFallback: 'Pronto', val: status && status.ready ? '✓ Pronto' : 'Non pronto', ok: !!(status && status.ready) },
    ];

    rows.forEach(({ labelKey, labelFallback, val, ok }) => {
      const row = document.createElement('div');
      row.className = 'remote-ready-row';

      const lbl = document.createElement('span');
      lbl.className = 'remote-ready-label';
      lbl.setAttribute('data-i18n', labelKey);
      lbl.textContent = labelFallback;

      const valEl = document.createElement('span');
      valEl.className = 'remote-ready-val' + (ok ? ' ok' : '');
      valEl.textContent = val; // dynamic data → textContent (IPs, status strings)

      row.appendChild(lbl);
      row.appendChild(valEl);
      grid.appendChild(row);
    });

    // Connected clients
    const clientRow = document.createElement('div');
    clientRow.className = 'remote-ready-row';

    const clientLbl = document.createElement('span');
    clientLbl.className = 'remote-ready-label';
    clientLbl.setAttribute('data-i18n', 'remote.status_clients');
    clientLbl.textContent = 'Client connessi';

    const clientVal = document.createElement('span');
    clientVal.className = 'remote-ready-val' + (clients.length > 0 ? ' ok' : '');
    clientVal.textContent = String(clients.length); // count → textContent

    clientRow.appendChild(clientLbl);
    clientRow.appendChild(clientVal);
    grid.appendChild(clientRow);

    if (clients.length > 0) {
      const list = document.createElement('div');
      list.className = 'remote-clients-list';
      clients.forEach(c => {
        const item = document.createElement('div');
        item.textContent = typeof c === 'string' ? c : (c && c.name) || String(c);
        list.appendChild(item);
      });
      grid.appendChild(list);
    }

    return grid;
  }

  // ── Controls (kill-switch, disable, enable) ───────────────────────────────
  function buildControls(status) {
    const box = document.createElement('div');
    box.className = 'remote-controls';

    const title = document.createElement('div');
    title.className = 'remote-controls-title';
    title.setAttribute('data-i18n', 'remote.controls_title');
    title.textContent = 'Controlli';
    box.appendChild(title);

    const row = document.createElement('div');
    row.className = 'remote-controls-row';

    // Kill-switch
    const killBtn = document.createElement('button');
    killBtn.type = 'button';
    killBtn.className = 'remote-btn danger';
    killBtn.setAttribute('data-i18n', 'remote.kill_btn');
    killBtn.textContent = 'Kill-switch (disconnetti subito)';
    killBtn.addEventListener('click', () => killSwitch(killBtn));
    row.appendChild(killBtn);

    // Disable
    const disableBtn = document.createElement('button');
    disableBtn.type = 'button';
    disableBtn.className = 'remote-btn';
    disableBtn.setAttribute('data-i18n', 'remote.disable_btn');
    disableBtn.textContent = 'Disabilita';
    disableBtn.addEventListener('click', () => disable(disableBtn));
    row.appendChild(disableBtn);

    // Enable
    const enableBtn = document.createElement('button');
    enableBtn.type = 'button';
    enableBtn.className = 'remote-btn primary';
    enableBtn.setAttribute('data-i18n', 'remote.enable_btn');
    enableBtn.textContent = 'Abilita';
    enableBtn.addEventListener('click', () => enable(enableBtn));
    row.appendChild(enableBtn);

    box.appendChild(row);
    box.appendChild(buildOnDemandToggle(status));

    return box;
  }

  // On-demand startup toggle (shared by the wizard controls and the ready panel):
  // keeps Sunshine/Tailscale from auto-starting with Windows. Returns a fragment.
  function buildOnDemandToggle(status) {
    const frag = document.createDocumentFragment();
    const onDemand = !!(status && status.onDemand);

    const odRow = document.createElement('div');
    odRow.className = 'remote-controls-row remote-ondemand-row';

    const odBtn = document.createElement('button');
    odBtn.type = 'button';
    odBtn.className = 'remote-btn remote-ondemand-btn' + (onDemand ? ' active' : '');
    odBtn.setAttribute('aria-pressed', onDemand ? 'true' : 'false');
    odBtn.setAttribute('data-i18n', onDemand ? 'remote.ondemand_on' : 'remote.ondemand_off');
    odBtn.textContent = onDemand ? 'Avvio su richiesta: ON' : 'Avvio su richiesta: OFF';
    odBtn.addEventListener('click', () => setOnDemand(!onDemand, odBtn));
    odRow.appendChild(odBtn);
    frag.appendChild(odRow);

    const odHint = document.createElement('div');
    odHint.className = 'remote-ondemand-hint';
    odHint.setAttribute('data-i18n', 'remote.ondemand_hint');
    odHint.textContent = 'Se attivo, Sunshine e Tailscale non si avviano con Windows e partono solo quando abiliti il controllo remoto. Richiede un’autorizzazione amministratore (UAC).';
    frag.appendChild(odHint);

    return frag;
  }

  // ── Step shell builder ────────────────────────────────────────────────────
  function buildStepShell(num, titleKey, titleFallback, done) {
    const step = document.createElement('div');
    step.className = 'remote-step';

    const head = document.createElement('div');
    head.className = 'remote-step-head' + (done ? ' done' : '');

    const numEl = document.createElement('span');
    numEl.className = 'remote-step-num';
    numEl.textContent = done ? '✓' : num;

    const titleEl = document.createElement('span');
    titleEl.setAttribute('data-i18n', titleKey);
    titleEl.textContent = titleFallback;

    head.appendChild(numEl);
    head.appendChild(titleEl);
    step.appendChild(head);

    const body = document.createElement('div');
    body.className = 'remote-step-body';
    step.appendChild(body);

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
      statusEl.textContent = 'Errore avvio login. Riprova.';
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
          statusEl.textContent = 'Connesso!';
          renderAll();
          return;
        }
        if (attempts >= POLL_MAX_ATTEMPTS) {
          statusEl.className = 'remote-status error';
          statusEl.textContent = 'Timeout — verifica di aver completato il login nel browser.';
          if (btn) btn.disabled = false;
          return;
        }
        statusEl.textContent = `In attesa di autenticazione… (${attempts})`;
        _pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      }).catch(() => {
        statusEl.className = 'remote-status error';
        statusEl.textContent = 'Errore di connessione — riprova.';
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
        statusEl.textContent = 'Errore: ' + (res.error || 'configurazione fallita');
        if (btn) btn.disabled = false;
        return;
      }
      statusEl.className = 'remote-status ok';
      statusEl.textContent = 'Sunshine configurato';
      await refreshStatus();
      renderAll();
    } catch {
      statusEl.className = 'remote-status error';
      statusEl.textContent = 'Errore — verifica che Sunshine sia in esecuzione.';
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
          statusEl.textContent = 'Autenticazione Sunshine fallita (401): riavvia Sunshine e riprova "Configura Sunshine".';
        } else if (res.status) {
          statusEl.textContent = 'Sunshine ha rifiutato la richiesta (HTTP ' + res.status + '). Verifica che Sunshine sia in esecuzione.';
        } else {
          statusEl.textContent = 'PIN errato o scaduto — riprova da Moonlight.';
        }
        if (btn) btn.disabled = false;
        return;
      }
      statusEl.className = 'remote-status ok';
      statusEl.textContent = 'Abbinamento riuscito!';
      if (pinInput) pinInput.value = '';
      await refreshStatus();
      renderAll();
    } catch {
      statusEl.className = 'remote-status error';
      statusEl.textContent = 'Errore di rete — riprova.';
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
      await api('/remote/enable', 'POST');
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
    const tiles = Array.from(document.querySelectorAll('[data-dashboard-widget="remote"]')).filter(el => el.closest('.pager-page'));
    if (!tiles.length) return;
    const configured = !!(
      _status &&
      _status.installed &&
      _status.installed.sunshine &&
      _status.installed.tailscale
    );
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
    msg.textContent = 'Controllo remoto non attivo — abilitalo in Impostazioni';
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
    isConfigured: () => !!(_status && _status.installed && _status.installed.sunshine && _status.installed.tailscale),
    refreshStatus,
    renderControlPanel,
    renderWidgets,
  };
})();
