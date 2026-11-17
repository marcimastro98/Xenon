// What a row waits on from the person: a newer version, a permission, a background slot, and which
// row gets the one green key.
'use strict';

(() => {
  const { t } = window.InstalledManagerRefused;

  // The catalog entry offering a newer version of this row, joined the same two
  // ways the rows themselves are built: SDK packages by pkgId, receipt-installed
  // content by the entry id it came from.
  function updateFor(row, cat) {
    if (row.pkg && cat.updates.has(row.pkg.id)) return cat.updates.get(row.pkg.id);
    if (row.record && row.record.source === 'catalog' && row.record.sourceId) {
      const direct = cat.updatesById.get(row.record.sourceId);
      if (direct) return direct;
      // Same copy-id/entry-id gap entryFor() closes: an update published for the
      // drop is an update for every copy of it.
      const drop = cat.byDropId.get(row.record.sourceId);
      return (drop && cat.updatesById.get(drop.id)) || null;
    }
    return null;
  }

  // What a row waits on from the person: a new version, or a permission without
  // which an installed widget never runs. Said in words under the name, so the
  // list answers "does anything need me?" without reading the keys.
  // A background package past the cap of hidden frames: it only works while its
  // tile is on screen, and the row says so instead of the widget going quiet.
  function leftOutOfBackground(row) {
    const CW = window.CustomWidget;
    return !!(row.pkg && CW && typeof CW.serviceLeftOut === 'function' && CW.serviceLeftOut().includes(row.pkg.id));
  }

  function needsYou(row, cat) {
    const upd = updateFor(row, cat);
    if (upd) return { kind: 'update', text: t('installed_state_update', 'Versione {v} disponibile').replace('{v}', String(upd.version)) };
    if (row.pkg && window.CustomWidget && typeof CustomWidget.packageGranted === 'function' && !CustomWidget.packageGranted(row.pkg)) {
      return { kind: 'allow', text: t('installed_state_allow', 'Spento finché non dai i permessi') };
    }
    return null;
  }

  // One green key per page, for the next thing to do: "Update all" when it is
  // offered, otherwise the first shown row that waits on the person.
  function greenRow(shown, cat, sweeping) {
    if (sweeping) return null;
    return shown.find((row) => needsYou(row, cat)) || null;
  }

  window.InstalledManagerRowNeeds = { updateFor, leftOutOfBackground, needsYou, greenRow };
})();
