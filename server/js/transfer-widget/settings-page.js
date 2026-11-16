// How Settings → Phone draws file transfer: the on switch, the arrival folder group, the phone
// alert toggle and the note on who may send. Saving and the folder fields stay in the entry.
'use strict';

window.TransferWidgetSettingsPage = (wrapper) => {
  const { saveSettings, syncDock, pickedFolderField, typedFolderField } = wrapper;

  const { t, el, sectionPage } = window.TransferWidgetSays;
  const { setup } = window.TransferWidgetKnown;

  function renderSettings() {
    if (!setup.settingsBox || !setup.cfg) return;
    const page = sectionPage();

    page.append(toggleRow('enabled', t('xfer_settings_enabled', 'Attiva il trasferimento file'),
      t('xfer_settings_enabled_hint', 'Da spento, il riquadro e il tasto sul telefono spariscono.')));

    // Everything below is governed by that switch, and follows it off screen.
    // A folder field belonging to a feature that is not running is a control
    // that asks to be filled in and then does nothing — the same reason the
    // device list above hides its own body when access is off.
    if (setup.cfg.enabled !== false) {
      page.append(...folderRows());

      // Hidden entirely rather than shown broken: a toggle that cannot work is
      // worse than an absent one. Push needs the HTTPS door AND a phone that
      // has already been given notification permission.
      if (setup.pushInfo && setup.pushInfo.supported && setup.pushInfo.secure) {
        page.append(toggleRow('notifyPhone', t('xfer_settings_notify', 'Avvisa il telefono quando c’è un file'),
          t('xfer_settings_notify_hint', 'Solo per i file che metti qui dal PC. L’avviso non contiene il nome del file.')));
      }

      page.append(el('p', 'settings-note', t('xfer_settings_devices',
        'Possono mandare file i telefoni e i tablet che hai già associato qui sopra. Per fermarne uno, rimuovilo dall’elenco.')));
    }

    setup.settingsBox.replaceChildren(page);
  }

  // The arrival folder: where the copy goes, and whether a copy is made at all.
  // The two belong in one group because the second answers "and what is that
  // folder for" — split apart, the toggle read as an unrelated third setting.
  function folderRows() {
    const deliver = toggleRow('autoDeliver', t('xfer_settings_deliver', 'Copia i file in quella cartella'),
      t('xfer_settings_deliver_hint', 'Da spento i file restano solo nell’elenco di Xenon, e li apri o li salvi da lì.'));
    if (setup.cfg.autoDeliver === false) return [deliver];
    return [deliver, setup.cfg.canPick === true ? pickedFolderField() : typedFolderField()];
  }

  function toggleRow(key, labelText, hint) {
    const row = el('label', 'settings-toggle-row');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'settings-check';
    // Default-off keys read `=== true`, default-on keys read `!== false`, the
    // same split normalizeFileTransfer uses on the server.
    input.checked = key === 'notifyPhone' ? setup.cfg[key] === true : setup.cfg[key] !== false;
    input.addEventListener('change', async () => {
      const res = await saveSettings({ [key]: input.checked });
      if (!res.ok) { input.checked = !input.checked; return; }
      if (key === 'enabled') syncDock();
      // Both of these decide what else is on screen, so the panel is redrawn
      // rather than left showing controls the new state does not have.
      if (key === 'enabled' || key === 'autoDeliver') renderSettings();
    });
    const text = el('span', 'settings-label-line');
    text.append(el('span', null, labelText));
    if (hint) text.append(el('span', 'settings-hint', hint));
    row.append(input, text);
    return row;
  }

  return { renderSettings };
};
