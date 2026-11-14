// How the disk tile names a drive and a kind of file, which entries of a level of the map get a
// tile of their own, and the words of its advice.
'use strict';

(() => {
  const { tr, categoryName } = window.DiskWidgetWording;

  const VIEW_META = [
    ['overview', 'disk_tab_overview', 'Panoramica'],
    ['clean', 'disk_tab_clean', 'Pulizia'],
    ['explore', 'disk_tab_explore', 'Esplora'],
    ['duplicates', 'disk_tab_duplicates', 'Duplicati'],
  ];

  const CATEGORY_GUIDE = {
    temp: {
      after: ['disk_guide_temp_after', 'Le app ricreano solo ciò che serve; il primo avvio può essere appena più lento.'],
      prevent: ['disk_guide_temp_prevent', 'Chiudi correttamente le app e limita i programmi che accumulano sessioni o crash log.'],
    },
    browserCache: {
      after: ['disk_guide_browser_after', 'I siti ricostruiscono la cache durante le visite successive; account e preferiti non vengono toccati.'],
      prevent: ['disk_guide_browser_prevent', 'Riduci la cache dalle impostazioni del browser o puliscila periodicamente, senza bloccarla del tutto.'],
    },
    pkgCache: {
      after: ['disk_guide_pkg_after', 'npm, pip, NuGet o Gradle riscaricheranno i pacchetti necessari; il codice dei progetti resta intatto.'],
      prevent: ['disk_guide_pkg_prevent', 'Usa i comandi di prune/cache clean del relativo gestore e rimuovi ambienti di progetti abbandonati.'],
    },
    buildOutput: {
      after: ['disk_guide_build_after', 'La prossima build o installazione può richiedere più tempo e ricreare gran parte dello spazio.'],
      prevent: ['disk_guide_build_prevent', 'Configura clean automatici nei progetti e conserva output offline solo per i lavori attivi.'],
    },
    installers: {
      after: ['disk_guide_installer_after', 'Per riparare o reinstallare l’app dovrai riscaricare il pacchetto eliminato.'],
      prevent: ['disk_guide_installer_prevent', 'Archivia solo driver rari o installer con licenza; elimina i download sostituibili dopo l’installazione.'],
    },
    recycleBin: {
      after: ['disk_guide_bin_after', 'Perdi definitivamente la possibilità di ripristinare quei file dal Cestino.'],
      prevent: ['disk_guide_bin_prevent', 'Svuotalo solo dopo aver controllato il contenuto; usa una pulizia pianificata se vuoi limitarne la crescita.'],
    },
  };

  // One spelling for a root, so a trailing separator or a capital never makes
  // two names for the same volume.
  function rootKeyOf(value) {
    const raw = String(value || '');
    const key = raw.replace(/[\\/]+$/, '').toLowerCase();
    // The filesystem root "/" is nothing BUT a trailing separator, so the strip
    // leaves it empty. Keep it as "/" so it stays a real, matchable key —
    // otherwise it collapses to the same '' as a garbage/empty path and the
    // primary macOS volume (Macintosh HD) can never be offered as an index root.
    if (!key && /[\\/]/.test(raw)) return '/';
    return key;
  }

  function drivePresentation(source) {
    const item = source || {};
    const pathValue = String(item.path || (item.letter ? item.letter + ':\\' : ''));
    const drive = String(item.drive || (item.letter ? item.letter + ':' : '') ||
      ((/^[A-Za-z]:/.exec(pathValue) || [])[0] || '')).toUpperCase();
    const label = String(item.label || '').trim();
    const model = String(item.model || '').trim();
    const fileSystem = String(item.fileSystem || '').trim();
    // A whole volume rather than a folder inside one: a bare drive letter on
    // Windows, and on macOS/Linux the filesystem root or a mount point the
    // server named as addable. Those get the volume's label ("Macintosh HD")
    // instead of their last path segment, which for "/" is nothing at all.
    const isDriveRoot = /^[A-Za-z]:\\?$/.test(pathValue)
      || (!!item.path && pathValue.startsWith('/') && rootKeyOf(pathValue) === rootKeyOf(item.drive));
    const leaf = pathValue.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || pathValue;
    const primary = isDriveRoot
      ? (label || model || tr('disk_local_drive', 'Disco locale'))
      : leaf;
    const details = [];
    const addDetail = (value) => {
      const text = String(value || '').trim();
      if (!text || details.some((part) => part.toLowerCase() === text.toLowerCase())) return;
      details.push(text);
    };
    addDetail(drive);
    if (isDriveRoot) {
      if (label) addDetail(model);
      addDetail(fileSystem);
    } else {
      addDetail(label || model);
      addDetail(fileSystem);
    }
    const titleParts = [pathValue];
    if (label) titleParts.push(label);
    if (model) titleParts.push(model);
    if (fileSystem) titleParts.push(fileSystem);
    return {
      primary,
      details,
      secondary: details.join(' · ') || pathValue,
      title: titleParts.filter(Boolean).join(' · '),
    };
  }

  const KIND_LABEL = {
    video: ['disk_kind_video', 'Video'],
    image: ['disk_kind_image', 'Foto e immagini'],
    audio: ['disk_kind_audio', 'Musica e audio'],
    document: ['disk_kind_document', 'Documenti'],
    archive: ['disk_kind_archive', 'Archivi e immagini disco'],
    app: ['disk_kind_app', 'App e sistema'],
    game: ['disk_kind_game', 'Giochi'],
    other: ['disk_kind_other', 'Altri file'],
    unlisted: ['disk_kind_unlisted', 'Non indicizzato'],
  };
  const kindName = (k) => tr(KIND_LABEL[k][0], KIND_LABEL[k][1]);

  function advisorAiReady() {
    const settings = typeof hubSettings !== 'undefined' && hubSettings ? hubSettings : {};
    const provider = settings.aiProvider || 'gemini';
    if (provider === 'ollama' || provider === 'localapi') return true;
    if (provider === 'claudecode' || provider === 'codex' || provider === 'xenon') return true;
    if (provider === 'openai') return settings.openaiApiKeySet === true;
    if (provider === 'anthropic') return settings.anthropicApiKeySet === true;
    return geminiKeyReady(settings);
  }

  function advisorFullContext() {
    if (typeof window.getSearchSettings === 'function') {
      const settings = window.getSearchSettings();
      return settings && settings.aiFullContext === true;
    }
    return typeof hubSettings !== 'undefined' && hubSettings && hubSettings.searchSettings &&
      hubSettings.searchSettings.aiFullContext === true;
  }

  function advisorRiskWords(risk) {
    if (risk === 'safe') return tr('disk_risk_recommended', 'Consigliata, con conferma');
    if (risk === 'permanent') return tr('disk_risk_permanent', 'Definitiva');
    return tr('disk_risk_your_choice', 'Decidi tu');
  }

  function advisorRecoveryItems(a) {
    const items = a.categories
      .filter((category) => category.bytes > 0 || category.count > 0)
      .map((category) => ({ ...category, label: categoryName(category.id) }));
    if (a.duplicateBytes > 0) {
      items.push({ label: tr('disk_verified_copies', 'Copie identiche verificate'), bytes: a.duplicateBytes, risk: 'review' });
    }
    return items.sort((left, right) => right.bytes - left.bytes);
  }

  // A treemap with dozens of cells turns small folders into pixel-sized squares
  // no finger can hit on the Edge. Keep as a tile only what is big enough to
  // read and touch; fold the rest into ONE "Altre N voci" tile that opens a
  // tappable list. The floors keep the map from emptying out when folders are
  // evenly sized.
  const TREEMAP_MAX_TILES = 14;    // hard cap on standalone tiles
  const TREEMAP_MIN_TILES = 4;     // always show at least this many, even if small
  const TREEMAP_MIN_SHARE = 0.02;  // a tile must be ≥2% of the level to stand alone

  // Split the level's entries into standalone tiles and a grouped remainder.
  // `entries` is size-desc and may end with a server "other" (unlisted bytes).
  function splitTreemapEntries(entries) {
    const serverOther = entries.find((e) => e.other) || null;
    const real = entries.filter((e) => !e.other);
    const totalBytes = real.reduce((s, e) => s + (e.s || 0), 0) + (serverOther ? serverOther.s || 0 : 0);
    const tiles = [];
    const grouped = [];
    real.forEach((ref, i) => {
      const share = totalBytes > 0 ? (ref.s || 0) / totalBytes : 0;
      const keep = tiles.length < TREEMAP_MAX_TILES && (share >= TREEMAP_MIN_SHARE || i < TREEMAP_MIN_TILES);
      if (keep) tiles.push(ref); else grouped.push(ref);
    });
    // A lone leftover with nothing unlisted behind it is better shown than hidden.
    if (grouped.length === 1 && !serverOther) { tiles.push(grouped.pop()); }
    const residual = serverOther ? (serverOther.s || 0) : 0;
    // groupedBytes counts ONLY the real small entries — the residual is unlisted
    // space, not "an item", and folding it in made a tile say "3 items · 50 GB"
    // when 50 GB of that was unattributed. It gets its own tile below.
    const groupedBytes = grouped.reduce((s, e) => s + (e.s || 0), 0);
    return { tiles, grouped, groupedBytes, residual, totalBytes };
  }

  window.DiskWidgetPresentation = {
    VIEW_META, CATEGORY_GUIDE, rootKeyOf, drivePresentation, kindName, advisorAiReady,
    advisorFullContext, advisorRiskWords, advisorRecoveryItems, TREEMAP_MIN_SHARE,
    splitTreemapEntries,
  };
})();
