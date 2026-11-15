// What a row of the Installed list is and says under its name: its kind, the catalog entry it came
// from, and the line of facts (source, version, date, what it was allowed).
'use strict';

(() => {
  const { t } = window.InstalledManagerRefused;

  const HS = () => { try { return (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : {}; } catch { return {}; } };
  const PS = () => window.PresetShare || null;

  // A row answers to ONE chip: the thing it actually is. A receipt files under
  // the kind it was published as — so a bundle lives under "Packages", not under
  // every kind it happens to contain. Filtering "Widget" must list widgets, not
  // the package they arrived in (which the "Packages" chip already shows).
  function kindOf(row) {
    if (!row.record) return 'widget';           // a bare SDK package
    return row.record.kind || 'bundle';
  }

  // The catalog entry a row came from, when we can prove it: a receipt records
  // the entry id it was installed from, and a widget package carries the pkgId
  // the catalog publishes it under. An import from a pasted code has neither —
  // it gets the kind glyph instead of a screenshot, which is honest.
  function entryFor(row, cat) {
    const fromRecord = (record) => {
      if (!record || record.source !== 'catalog' || !record.sourceId) return null;
      return cat.byId.get(record.sourceId) || cat.byDropId.get(record.sourceId) || null;
    };
    if (row.record && row.record.source === 'catalog' && row.record.sourceId) {
      const e = cat.byId.get(row.record.sourceId);
      if (e) return e;
      // A NUMBERED limited drop hands out one artifact per copy, each with its own
      // redeem id ('vanguard-50-01'), while the catalog publishes ONE entry for the
      // drop ('vanguard-50'). The receipt records the copy, so a direct lookup
      // misses and the owner of a numbered edition — the most special thing they
      // can install — got the generic glyph and was never offered its updates.
      // Matched through the entry's declared `limited.dropId`, never by trimming
      // the id blind: an unrelated entry that merely ends in -01 must not claim it.
      const drop = cat.byDropId.get(row.record.sourceId);
      if (drop) return drop;
    }
    // A widget published on its own carries the pkgId the catalog knows it by;
    // one that arrived inside a package inherits that package's entry.
    if (row.pkg) return cat.byPkgId.get(row.pkg.id) || fromRecord(row.owner) || null;
    return null;
  }

  function grantChips(pkg) {
    const grants = (HS().sdkWidgets && HS().sdkWidgets.grants) || {};
    const g = grants[pkg.id];
    if (!g) return null;
    const bits = [];
    if (Array.isArray(g.streams) && g.streams.length) bits.push(g.streams.length + ' ' + t('settings_sdk_grant_streams', 'dati'));
    if (Array.isArray(g.actions) && g.actions.length) bits.push(g.actions.length + ' ' + t('settings_sdk_grant_actions', 'azioni'));
    if (Array.isArray(g.hosts) && g.hosts.length) bits.push(t('settings_sdk_grant_net', 'rete'));
    if (Array.isArray(g.handlers) && g.handlers.length) bits.push(g.handlers.length + ' ' + t('settings_sdk_grant_handlers', 'tasti Deck'));
    return bits.length ? bits.join(' · ') : null;
  }

  function metaLine(row) {
    const bits = [];
    if (row.record) {
      const summary = PS() ? PS().installResourceSummary(row.record.resources) : '';
      if (row.record.legacy) bits.push(t('installed_content_legacy_note', 'Le versioni precedenti di Xenon non registravano la provenienza, quindi questi import si rimuovono insieme.'));
      if (summary) bits.push(summary);
      if (row.record.source === 'catalog') bits.push(t('installed_content_catalog', 'Catalogo'));
      if (row.record.sourceVersion) bits.push('v' + row.record.sourceVersion);
      if (row.record.installedAt) {
        try { bits.push(new Date(row.record.installedAt).toLocaleDateString()); } catch { /* no date */ }
      }
    }
    if (row.pkg && !row.record) {
      bits.push('v' + (row.pkg.version || '0.0.0'));
      if (row.pkg.author) bits.push(row.pkg.author);
    }
    if (row.pkg) {
      const chips = grantChips(row.pkg);
      if (chips) bits.push(chips);
    }
    return bits.filter(Boolean).join(' · ');
  }

  window.InstalledManagerRowFacts = { HS, PS, kindOf, entryFor, metaLine };
})();
