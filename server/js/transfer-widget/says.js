// What the file transfer tile says: a size and an age in words, a note under a list, the help
// panel, the notes of the sheet, and the lines about the folder files arrive in. Every text goes in
// as text; nothing here sends or receives a file.
'use strict';

(() => {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;

  // Intl writes the unit in the app's language, so no language reads "1 g" but Italian.
  function fmtUnit(value, unit) {
    try {
      const lang = document.documentElement.lang || 'en';
      return new Intl.NumberFormat(lang, { style: 'unit', unit, unitDisplay: 'short' }).format(value);
    } catch {
      return value + ' ' + unit;
    }
  }

  function fmtAge(at) {
    const s = Math.max(0, Math.floor((Date.now() - (at || 0)) / 1000));
    if (s < 60) return t('xfer_now', 'ora');
    if (s < 3600) return fmtUnit(Math.floor(s / 60), 'minute');
    if (s < 86400) return fmtUnit(Math.floor(s / 3600), 'hour');
    return fmtUnit(Math.floor(s / 86400), 'day');
  }

  function note(row, text) {
    if (!row) {
      if (window.XenonToast && typeof window.XenonToast.show === 'function') {
        window.XenonToast.show({ type: 'warn', title: t('xfer_title', 'Trasferimento file'), message: text });
      }
      return;
    }
    let n = row.querySelector('.xfer-note');
    if (!n) { n = el('div', 'xfer-note'); row.appendChild(n); }
    n.textContent = text;
  }

  // Both directions, in the order somebody meets them, and the pairing step
  // first: a phone that was never paired cannot send anything, and that is the
  // part the tile could not have shown you by existing.
  //
  // Built once with the tile and toggled, not built on demand: the surface is
  // rebuilt by ensure() only when the mount is empty, so a panel created on the
  // first press would be the one thing in here that can go missing.
  function helpPanel() {
    const box = el('div', 'xfer-help');
    box.hidden = true;

    const steps = (titleKey, titleFb, lines) => {
      const sec = el('div', 'xfer-help-sec');
      sec.append(el('div', 'xfer-help-head', t(titleKey, titleFb)));
      const ol = document.createElement('ol');
      ol.className = 'xfer-help-steps';
      for (const [k, fb] of lines) ol.append(el('li', null, t(k, fb)));
      sec.append(ol);
      return sec;
    };

    box.append(steps('xfer_help_to_pc', 'Dal telefono a questo PC', [
      // "Open Xenon on the phone" was step one for a whole version, and it never
      // said WHERE: the phone has no app to open, it has the address the QR
      // opened in its browser. Hence the home-screen line — the dashboard is
      // already installable (index.html carries the apple-mobile-web-app meta),
      // and nothing anywhere said so.
      ['xfer_help_to_pc_1', 'Su questo PC: Impostazioni → Telefono → Aggiungi dispositivo. Inquadra il QR con la fotocamera del telefono.'],
      ['xfer_help_to_pc_2', 'Il QR apre Xenon nel browser del telefono. Aggiungilo alla schermata Home e diventa un\'icona: da lì lo riapri quando vuoi.'],
      ['xfer_help_to_pc_3', 'In Xenon sul telefono tocca Invia al PC nella barra in basso, poi Foto e video o Altri file.'],
    ]));
    box.append(steps('xfer_help_to_phone', 'Da questo PC al telefono', [
      ['xfer_help_to_phone_1', 'Trascina i file qui dentro, o usa i due tasti qui sotto.'],
      ['xfer_help_to_phone_2', 'In Xenon sul telefono tocca Scarica sulla riga del file.'],
    ]));
    box.append(el('p', 'xfer-help-where', t('xfer_help_where',
      'I file che arrivano vengono copiati in Download\\Xenon. La cartella si cambia da Impostazioni → Telefono.')));
    // The boundaries, from the one place that already words them — the phone
    // sheet has printed these since 4.11.0 and the tile never did.
    for (const line of sheetNotes()) box.append(el('p', 'xfer-help-note', line));
    return box;
  }

  // The boundaries, said where they would otherwise be discovered.
  function sheetNotes() {
    const out = [t('xfer_note_lan', 'Funziona quando il telefono e il PC sono sulla stessa rete, o su Tailscale.')];
    if (/iP(hone|ad|od)/.test(navigator.userAgent)) {
      // Not a shortcoming of Xenon and not fixable from a web page: WebKit does
      // not implement Web Share Target at all.
      out.push(t('xfer_note_ios', 'Su iPhone devi aprire Xenon per mandare qualcosa. Il tasto Condividi di iOS non può mandare a Xenon.'));
      out.push(t('xfer_note_ios_save', 'Un file scaricato va in File, non nel rullino. Per una foto, tienila premuta e scegli Aggiungi a Foto.'));
    }
    out.push(t('xfer_note_limits', 'Un file alla volta, uno dopo l’altro. Se chiudi Xenon a metà, quel file riparte da capo.'));
    return out;
  }

  function sectionPage() {
    const page = el('section', 'settings-section');
    page.append(el('div', 'settings-section-title', t('xfer_settings_title', 'Trasferimento file')),
      el('p', 'settings-note', t('xfer_settings_intro',
        'Manda foto e file dal telefono a questo PC, e da questo PC al telefono. I file passano dalla tua rete, non da internet.')));
    return page;
  }

  function folderError(code) {
    return {
      not_found: t('xfer_folder_not_found', 'Questa cartella non esiste.'),
      not_absolute: t('xfer_folder_not_absolute', 'Serve il percorso completo.'),
      not_a_dir: t('xfer_folder_not_a_dir', 'Questo non è una cartella.'),
      inside_data: t('xfer_folder_inside', 'Questa cartella è di Xenon. Scegline un’altra.'),
      inside_app: t('xfer_folder_inside', 'Questa cartella è di Xenon. Scegline un’altra.'),
      symlink: t('xfer_folder_symlink', 'Questo è un collegamento. Indica la cartella vera.'),
      picking: t('settings_folder_busy', 'A folder window is already open'),
    }[code] || t('xfer_folder_failed', 'Non ho potuto usarla.');
  }

  function folderHint() {
    return el('p', 'settings-hint', t('xfer_settings_folder_hint',
      'I file arrivano qui con il loro nome. Se un nome esiste già, Xenon aggiunge un numero e non sostituisce mai niente.'));
  }

  function folderName(detail) {
    const words = el('span', 'settings-label-line');
    words.append(el('span', null, t('xfer_settings_folder', 'Cartella di arrivo')));
    if (detail) words.append(detail);
    return words;
  }

  window.TransferWidgetSays = {
    t, el, fmtAge, note, helpPanel, sheetNotes, sectionPage, folderError, folderHint, folderName,
  };
})();
