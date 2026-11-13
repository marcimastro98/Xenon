// The Search and Disk settings: the indexed folders and the options of the disk tools.
'use strict';

// ── Ricerca e disco (Spotlight + Disk widget knobs) ─────────────────────────
function updateSearchSettings(patch) {
  const cur = hubSettings.searchSettings || {};
  hubSettings = normalizeSettings({ ...hubSettings, searchSettings: { ...cur, ...patch } });
  saveHubSettings();
  renderSearchDiskSettings();
}
function getSearchSettings() {
  const cur = hubSettings.searchSettings || {};
  return { ...cur, indexRoots: [...(cur.indexRoots || [])] };
}
async function addSearchIndexRoot(rootPath) {
  const current = (hubSettings.searchSettings || {}).indexRoots || [];
  const candidate = String(rootPath || '').trim();
  if (current.some((r) => String(r).toLowerCase() === candidate.toLowerCase())) {
    return getSearchSettings();
  }
  const normalized = normalizeSearchSettings({
    ...(hubSettings.searchSettings || {}),
    indexRoots: [...current, candidate],
  });
  if (normalized.indexRoots.length === current.length) return normalized;
  updateSearchSettings({ indexRoots: normalized.indexRoots });
  // A disk-chip tap immediately asks /disk/status for the new root. Commit the
  // settings first when hydration is complete so that request cannot race the
  // normal debounced save and make the chip appear to do nothing.
  if (_hubHydratedFromServer) {
    try { await flushHubSettingsToServer(); } catch { /* the normal retry still owns recovery */ }
  }
  return normalized;
}
window.updateSearchSettings = updateSearchSettings;
window.getSearchSettings = getSearchSettings;
window.addSearchIndexRoot = addSearchIndexRoot;
function updateDiskSettings(patch) {
  const cur = hubSettings.diskSettings || {};
  hubSettings = normalizeSettings({ ...hubSettings, diskSettings: { ...cur, ...patch } });
  saveHubSettings();
  renderSearchDiskSettings();
}
function renderSearchDiskSettings() {
  const s = hubSettings.searchSettings || {};
  const d = hubSettings.diskSettings || {};
  const hot = document.getElementById('settings-search-hotkey');
  if (hot) hot.checked = s.hotkeyEnabled === true;
  const combo = document.getElementById('settings-search-combo');
  if (combo && document.activeElement !== combo) combo.value = s.hotkeyCombo || 'alt+space';
  const folders = document.getElementById('settings-search-folders');
  if (folders && document.activeElement !== folders) folders.value = (s.indexRoots || []).join('\n');
  const brain = document.getElementById('settings-search-aibrain');
  if (brain) brain.checked = s.aiFullContext === true;
  const recentTile = document.getElementById('settings-search-recent-tile');
  if (recentTile) recentTile.checked = s.recentInTile === true;
  const dev = document.getElementById('settings-disk-devfolders');
  if (dev && document.activeElement !== dev) dev.value = (d.devFolders || []).join('\n');
  const age = document.getElementById('settings-disk-installer-age');
  if (age && document.activeElement !== age) age.value = d.installerAgeDays || 30;
  // Living Index state (files, RAM, building) — asked while the pane is open.
  const idxStatus = document.getElementById('settings-search-index-status');
  if (idxStatus) {
    // An empty list is the OFF state, and it says so. Hiding the line here left
    // the one question the hint raises unanswered on screen: the default is the
    // whole system drive, so "did clearing it stick, or does C:\ come back?"
    // had no answer anywhere in the app. It sticks — normalizeSearchSettings
    // defaults only when the key was never set, and usableIndexRoots returns []
    // for an explicitly emptied list — so the note states it, plus the part the
    // user does not expect (the Disk space map reads these same roots).
    if (!(s.indexRoots || []).length) {
      // The second sentence is Windows-only and is the one users actually ask
      // for: the search box keeps working with the index off, because
      // filesearch.js also queries the Windows Search catalog, which Microsoft
      // maintains whether Xenon exists or not. Off Windows there is no such
      // catalog, so the sentence would be false. XenonPlatform can be '' before
      // /status answers — unknown omits the clause rather than guessing.
      const wds = window.XenonPlatform === 'win32'
        ? ' ' + t('settings_search_idx_off_wds', 'La ricerca continua a trovare file tramite l’indice di Windows, che è di Microsoft e non nostro: Xenon lo interroga soltanto.')
        : '';
      idxStatus.textContent = t('settings_search_idx_off', 'Indice vivo spento: la lista è vuota e resta vuota. Xenon non indicizza nulla, e anche la mappa del widget Spazio disco resta vuota.') + wds;
      idxStatus.hidden = false;
    }
    else {
      fetch('/index/status').then((r) => r.json()).then((st) => {
        if (_settingsCat !== 'search' || !st) return;
        // macOS revoked Full Disk Access — which it does by itself, on every
        // Xenon update, because the grant is bound to the app's signature. The
        // list above still shows the folder the user chose and it is still
        // correct, so every other message here ("add a folder", "rerun the
        // installer") would send them to fix something that is not broken.
        if (st.fdaBlocked) {
          idxStatus.textContent = t('settings_search_idx_fda',
            'macOS ha revocato a Xenon l’Accesso completo al disco: succede a ogni aggiornamento. Finché manca, Xenon non indicizza la tua cartella utente: altrimenti macOS chiederebbe il permesso per Scrivania, Documenti, Download, Foto e Musica a ogni scansione. Riattivalo in Impostazioni di Sistema → Privacy e Sicurezza → Accesso completo al disco: togli Xenon dall’elenco e riaggiungila.');
          idxStatus.hidden = false;
          return;
        }
        // The entry cap, said where the roots are chosen. The Disk widget has
        // always shown it; this pane, the one place the user can DO something
        // about it, showed "Living index active: 2,000,000 files" — which reads
        // as success while search can no longer see a whole drive. Reported
        // during the build too: past the cap the walk has stopped adding, so
        // waiting for `ready` would keep saying "learning your disk" over an
        // index that has finished growing.
        const roots = (st.cappedRoots || []).filter(Boolean);
        // Said BEFORE the cap too. "Limit reached" arrives when a whole drive
        // is already missing; at 85% of the way there the user still has time
        // to trim the list, and an index that quietly stops growing next week
        // is the "looks alive, does nothing" failure. The cap is per machine
        // (the helper derives it from the RAM), so the number is read, never
        // assumed.
        const files = Number(st.files) || 0;
        const maxEntries = Number(st.maxEntries) || 0;
        const nearCap = !st.capped && maxEntries > 0 && files >= maxEntries * 0.85;
        const capNote = st.capped ? ' '
          + t('settings_search_idx_capped', 'Limite raggiunto: Xenon ha smesso di aggiungere file, quindi la ricerca non li vede tutti. Togli una cartella dall’elenco qui sopra, oppure indica cartelle precise invece di interi dischi.')
          + (roots.length ? ' ' + t('settings_search_idx_capped_roots', 'Rimasto fuori:') + ' ' + roots.join(', ') : '')
          : nearCap ? ' '
            + t('settings_search_idx_near_cap', 'L’indice è al {pct}% del suo limite ({max} file): se i file crescono ancora, Xenon smetterà di aggiungerli e la ricerca non li vedrà tutti. Togli una cartella dall’elenco qui sopra, oppure indica cartelle precise invece di interi dischi.')
              .replace('{pct}', String(Math.min(99, Math.floor((files / maxEntries) * 100))))
              .replace('{max}', maxEntries.toLocaleString())
            : '';
        idxStatus.textContent = !st.on || !st.helper
          ? t('settings_search_idx_helper', 'L’indice vivo non è disponibile: aggiungi una cartella qui sopra, oppure rilancia l’installer di Xenon.')
          : st.building
            ? t('settings_search_idx_building', 'Sto imparando il disco…') + ' ' + ((st.progress && st.progress.files) || st.files || 0).toLocaleString() + ' file' + capNote
            : t('settings_search_idx_on', 'Indice vivo attivo:') + ' ' + (st.files || 0).toLocaleString() + ' file · ~' + (st.ramMB || 0) + ' MB RAM' + capNote;
        idxStatus.classList.toggle('settings-note-warn', !!capNote);
        idxStatus.hidden = !idxStatus.textContent;
      }).catch(() => { idxStatus.hidden = true; });
    }
  }
  // Hotkey listener state, asked only while the pane is open and the toggle on.
  const status = document.getElementById('settings-search-hotkey-status');
  if (!status) return;
  if (s.hotkeyEnabled !== true) { status.hidden = true; return; }
  fetch('/search/hotkey-status').then((r) => r.json()).then((st) => {
    if (_settingsCat !== 'search' || !st) return;
    const map = {
      listening: t('settings_search_hk_on', 'Scorciatoia attiva.'),
      taken: t('settings_search_hk_taken', 'La combinazione è già usata da un’altra app: scegline una diversa.'),
      helper_missing: t('settings_search_hk_helper', 'La scorciatoia globale non è disponibile su questo sistema.'),
      // Linux: the desktop owns global shortcuts, and only GNOME's store can be
      // written safely. Everywhere else the user has to add the binding
      // themselves, so the message has to say what to bind it TO.
      unsupported_de: t('settings_search_hk_de', 'Il tuo desktop gestisce le scorciatoie globali a modo suo. Aggiungila a mano nelle sue impostazioni, con questo comando: curl -X POST http://127.0.0.1:3030/search/hotkey-press'),
      error: t('settings_search_hk_err', 'La scorciatoia non è partita. Riprova salvando di nuovo.'),
      starting: t('settings_search_hk_starting', 'Attivazione…'),
      retrying: t('settings_search_hk_retry', 'Non è partita. Xenon riprova tra poco.'),
      off: '',
    };
    status.textContent = map[st.state] || '';
    status.hidden = !status.textContent;
  }).catch(() => { status.hidden = true; });
}
