// Connessioni tab of the lighting hub: where each lighting system is set up —
// Corsair iCUE (SDK component), the motherboard Xenon drives itself, Razer Chroma,
// the network providers (WLED, Hue, Govee, …, with on-demand discovery, pairing
// and add-by-IP) and SignalRGB.
// What each device then SHOWS is chosen in the Dispositivi tab.
(function () {
  'use strict';
  const UI = () => window.LightingUI;
  const NATIVE_OPEN_WAIT_MS = 1500;   // USB open + init before the card shows what was found
  const NO_ADDRESS = ['chroma'];      // one local session: nothing to type, no host to show

  // --- Corsair iCUE --------------------------------------------------------------
  function icueCard(rerender, status) {
    let state = null;
    if (status.available) {
      state = status.connected
        ? UI().el('span', 'lighting-provider-ok', 'lighting_icue_connected', 'Collegato')
        : UI().el('span', 'lighting-provider-off', 'lighting_icue_disconnected', 'Non collegato');
    }
    const card = UI().card('', 'Corsair iCUE', state);
    if (!status.available) {
      // Since iCUE 5.48 stopped installing the SDK component, this is the
      // ordinary case rather than a broken iCUE — so offer to fetch it.
      card.body.append(...sdkInstall(rerender));
    } else if (!status.connected) {
      card.body.appendChild(UI().hintP('', 'lighting_icue_off_hint'));
    } else {
      card.body.appendChild(UI().hintP('', 'lighting_icue_ok_hint'));
    }
    return card;
  }

  // One-tap fetch of the iCUE SDK component from Corsair's official release.
  // Deliberately NOT automatic: it downloads native code the server then loads,
  // so the user starts it. The server pins the version and verifies the archive's
  // SHA-256 before anything is extracted (icue-sdk-update.ps1).
  function sdkInstall(rerender) {
    const state = UI().hintP('');
    state.hidden = true;
    const btn = UI().button('settings-btn', 'lighting_sdk_install', 'Scarica componente', async () => {
      btn.disabled = true;
      state.hidden = false;
      state.removeAttribute('data-i18n');
      state.textContent = UI().tr('lighting_sdk_installing', 'Download in corso…');
      let r = null;
      try { r = await (await fetch('/api/lighting/sdk-install', { method: 'POST' })).json(); }
      catch (e) { r = { ok: false, error: e && e.message }; }
      if (r && r.ok) {
        state.textContent = UI().tr('lighting_sdk_installed', 'Componente installato. Attivo alla prossima connessione a iCUE.');
        rerender();
        return;
      }
      // Keep the real reason visible: a checksum mismatch or a blocked download
      // is exactly what the user needs to see, not a generic failure.
      state.textContent = UI().tr('lighting_sdk_failed', 'Download non riuscito.') + (r && r.error ? ' ' + r.error : '');
      btn.disabled = false;
    });
    return [UI().noteRow(UI().hintP('Componente iCUE SDK non presente su questo PC. Serve per controllare le luci Corsair: Xenon può scaricarlo da Corsair.', 'lighting_sdk_missing'), btn), state];
  }

  // Linux keeps the controller for root until a udev rule says otherwise: the chip
  // is there, so "nothing found" would be false. One line to paste, then Search again.
  function nativeAccessHelp(body, command) {
    body.appendChild(UI().hintP('', 'lighting_native_permission'));
    const row = UI().el('div', 'streaming-copy-row');
    const code = UI().el('code', 'streaming-copy-val');
    code.textContent = command;
    const copy = UI().button('settings-btn streaming-copy-btn', 'streaming_copy', 'Copy', async () => {
      const ok = await copyText(command);
      copy.textContent = UI().tr(ok ? 'streaming_copied' : 'streaming_copy', ok ? 'Copied' : 'Copy');
    });
    row.append(code, copy);
    body.appendChild(row);
  }

  // --- Motherboard (controllers Xenon drives itself over USB) --------------------
  // Opt-in: taking the controller means the vendor app and iCUE's motherboard
  // plugin must let go of it, which the hint says before anything happens.
  function motherboardCard(rerender, status) {
    const n = status.native || {};
    const card = UI().card('lighting_native_title', 'Scheda madre');
    if (!n.available) {
      card.body.appendChild(UI().hintP('', 'lighting_native_unsupported'));
      return card;
    }
    card.body.appendChild(UI().toggleRow('lighting_native_enable', n.enabled, async (on) => {
      await UI().post('/api/lighting/native', { enabled: on });
      // Opening the controller takes a moment (longer with a Gen2 scan).
      setTimeout(rerender, NATIVE_OPEN_WAIT_MS);
    }, 'lighting_native_enable_hint'));
    if (n.beta) card.body.appendChild(UI().hintP('', 'lighting_native_beta'));
    if (!n.enabled) return card;
    card.body.appendChild(UI().hintP('', 'lighting_native_conflict'));
    const controllers = n.controllers || [];
    controllers.forEach((c) => {
      const line = UI().hintP(UI().tr('lighting_native_found', 'Trovato: {name}, {n} uscite')
        .replace('{name}', c.name || 'RGB Fusion').replace('{n}', String(c.outputs)));
      line.classList.add('lighting-provider-ok');
      card.body.appendChild(line);
    });
    if (!n.starting && !controllers.length) {
      if (n.accessCommand) nativeAccessHelp(card.body, n.accessCommand);
      else {
        card.body.appendChild(UI().hintP('', 'lighting_native_none'));
        // The controller's own reason, when it is more than "nothing found".
        if (n.error && n.error !== 'no-controller') card.body.appendChild(UI().hintP(n.error));
      }
    }
    const rescan = UI().button('settings-btn', 'lighting_native_rescan', 'Cerca di nuovo', async () => {
      rescan.disabled = true;
      await UI().post('/api/lighting/native/scan', {});
      rerender();
    });
    card.body.appendChild(UI().keysRow(rescan));
    return card;
  }

  // --- Razer Chroma --------------------------------------------------------------
  // The enable flag lives in the client settings (hubSettings.chroma) and is saved
  // by settings.js; the element ids are the ones settings.js syncs and reports to.
  function chromaCard(rerender, status) {
    const card = UI().card('settings_chroma_title', 'Razer Chroma');
    const provider = (status.providers || []).find(p => p.id === 'chroma');
    card.body.appendChild(UI().hintP('', 'settings_chroma_hint'));
    const enabled = typeof hubSettings === 'object' && hubSettings && hubSettings.chroma && hubSettings.chroma.enabled === true;
    const toggle = UI().toggleRow('settings_chroma_enable', enabled, (on) => {
      if (typeof window.updateChromaEnabled === 'function') window.updateChromaEnabled(on);
    }, 'settings_chroma_enable_hint');
    toggle.querySelector('input').id = 'settings-chroma-enabled';
    const btn = UI().button('settings-btn', 'settings_chroma_test', 'Verifica connessione', () => {
      if (typeof window.testChromaConnection === 'function') window.testChromaConnection(btn);
    });
    const out = UI().el('p', 'settings-note');
    out.id = 'settings-chroma-status';
    const keys = UI().keysRow(btn);
    if (provider && provider.download) keys.appendChild(downloadKey(provider));
    keys.appendChild(out);
    card.body.append(toggle, keys);
    return card;
  }

  // --- network providers (Govee / LIFX / WLED / Hue / Nanoleaf / OpenRGB …) ------
  function externalSection(rerender, status) {
    const box = UI().card('lighting_external_title', 'Sistemi esterni');
    const scanBtn = UI().button('settings-btn', 'lighting_scan', 'Cerca dispositivi sulla rete', async () => {
      scanBtn.disabled = true;
      scanBtn.removeAttribute('data-i18n');
      scanBtn.textContent = UI().tr('lighting_scanning', 'Ricerca…');
      await UI().post('/api/lighting/scan', {});
      rerender();
    });
    box.body.appendChild(UI().keysRow(scanBtn));
    // Power-user providers (OpenRGB) go last; they are add-by-IP only (never auto-scanned).
    // Razer has its own card above; it joins this list only with lights to show.
    const providers = (status.providers || []).filter(p => p.id !== 'chroma' || (p.devices || []).length);
    [...providers.filter(p => !p.advanced), ...providers.filter(p => p.advanced)]
      .forEach(p => box.body.appendChild(providerBlock(rerender, p)));
    return box;
  }

  // One provider: a row that opens, already open when it has lights to show.
  function providerBlock(rerender, p) {
    const devices = Array.isArray(p.devices) ? p.devices : [];
    const box = UI().el('details', 'settings-expander');
    box.open = devices.length > 0;
    const name = UI().el('summary');
    name.appendChild(UI().el('span', 'settings-label-line', '', p.name));
    const body = UI().el('div', 'settings-grid');
    const descKey = 'lighting_desc_' + p.id;
    const download = p.download ? downloadKey(p) : null;
    if (UI().tr(descKey, '')) body.appendChild(UI().noteRow(UI().hintP('', descKey), download));
    else if (download) body.appendChild(UI().keysRow(download));
    devices.forEach(d => body.appendChild(externalDeviceRow(rerender, p, d)));
    if (!NO_ADDRESS.includes(p.id)) body.appendChild(addIpRow(rerender, p));
    box.append(name, body);
    return box;
  }

  // Official setup/info page; the URL is resolved server-side from the catalogue,
  // never taken from here.
  function downloadKey(p) {
    return UI().button('settings-btn', 'lighting_download', 'Scarica',
      () => UI().post('/api/lighting/open-download', { provider: p.id }));
  }

  function deviceLabel(d) {
    return d.host && d.name !== d.host ? `${d.name}, ${d.host}` : (d.name || d.host);
  }

  // One configured device: pairing when the provider needs it and the device has
  // no token yet; otherwise its on/off switch and remove button.
  function externalDeviceRow(rerender, p, d) {
    const row = UI().el('div', 'settings-row');
    const title = UI().el('span', 'settings-label-line');
    title.appendChild(UI().el('span', '', '', d.name || d.host));
    if (d.host && d.name !== d.host && !NO_ADDRESS.includes(p.id)) title.appendChild(UI().el('span', 'settings-hint', '', d.host));
    const actions = UI().el('span', 'lighting-ext-device-actions');
    row.append(title, actions);
    if (d.needsPairing && !d.paired) {
      const hint = UI().hintP('', 'lighting_pair_hint_' + p.id);
      const pairBtn = UI().button('settings-btn primary', 'lighting_pair', 'Associa', async () => {
        pairBtn.disabled = true;
        const r = await UI().post('/api/lighting/device', { provider: p.id, action: 'pair', host: d.host });
        if (r && r.ok) { rerender(); return; }
        pairBtn.disabled = false;
        hint.removeAttribute('data-i18n');
        hint.textContent = UI().tr('lighting_pair_retry', 'Premi il pulsante…') + ' ' + UI().tr('lighting_pair_hint_' + p.id, '');
      });
      actions.append(pairBtn, removeBtn(rerender, p.id, d.id));
      row.appendChild(hint);
      return row;
    }
    const optIn = document.createElement('input');
    optIn.type = 'checkbox'; optIn.className = 'settings-check'; optIn.checked = d.optedIn !== false;
    optIn.setAttribute('aria-label', deviceLabel(d));
    optIn.addEventListener('change', () =>
      UI().post('/api/lighting/device', { provider: p.id, action: 'optin', id: d.id, optedIn: optIn.checked }));
    actions.append(optIn, removeBtn(rerender, p.id, d.id));
    return row;
  }

  function removeBtn(rerender, providerId, deviceId) {
    const rm = UI().button('settings-btn lighting-remove', '', '✕', async () => {
      await UI().post('/api/lighting/device', { provider: providerId, action: 'remove', id: deviceId });
      rerender();
    });
    rm.setAttribute('data-i18n-title', 'lighting_remove');
    return rm;
  }

  // Manual add by IP — or by entity id for Home Assistant (probe-validated
  // server-side; rejected hosts mark the input).
  function addIpRow(rerender, p) {
    const field = UI().el('div', 'lighting-addip');
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'settings-text-input';
    input.placeholder = p.id === 'homeassistant' ? 'light.nome_luce' : '192.168.1.50';
    input.spellcheck = false; input.maxLength = 64;
    const btn = UI().button('settings-btn', 'lighting_add', 'Aggiungi', async () => {
      const ip = input.value.trim();
      if (!ip) return;
      btn.disabled = true;
      const r = await UI().post('/api/lighting/device', { provider: p.id, action: 'add', host: ip });
      btn.disabled = false;
      if (r && r.ok) rerender();
      else input.classList.add('invalid');
    });
    input.addEventListener('input', () => input.classList.remove('invalid'));
    field.append(input, btn);
    return UI().labeledRow('lighting_add_light', field);
  }

  // --- SignalRGB -----------------------------------------------------------------
  // A scene switcher, NOT a colour provider: it can't follow the album or flash on
  // notifications. Enabling it unlocks the "Apply SignalRGB effect" Deck action.
  // Status has its own endpoint and the toggle posts to /api/signalrgb/config
  // (not a lighting status, so it must not go through post()).
  function signalRgbCard() {
    const card = UI().card('signalrgb_title', 'SignalRGB');
    card.body.append(UI().hintP('Applica una scena SignalRGB con un tasto del Deck. Non è un provider di colore: non segue l\'album né le notifiche.', 'signalrgb_hint'));
    fetch('/api/signalrgb/status').then(r => r.json()).then((st) => {
      if (!st || !st.ok) return;
      if (!st.installed) {
        card.body.appendChild(UI().hintP('SignalRGB non rilevato su questo PC.', 'signalrgb_not_installed'));
      } else {
        card.body.appendChild(UI().toggleRow('signalrgb_enable', st.enabled, async (on) => {
          try { await fetch('/api/signalrgb/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: on }) }); }
          catch { /* offline — the toggle just reflects intent */ }
        }));
      }
      UI().localizeSubtree(card);
    }).catch(() => {});
    return card;
  }

  function build(rerender, status) {
    const box = UI().el('div', 'lighting-panel-body');
    box.append(icueCard(rerender, status), motherboardCard(rerender, status), chromaCard(rerender, status));
    if (Array.isArray(status.providers) && status.providers.length) {
      box.appendChild(externalSection(rerender, status));
    }
    box.appendChild(signalRgbCard());
    return box;
  }

  window.LightingConnections = { build };
})();
