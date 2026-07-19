'use strict';
// Installed manager — the Store's "Installed" tab.
//
// ONE place to see and remove everything Xenon has downloaded: what used to be
// split between Settings → "Widget installati" (SDK packages) and the separate
// "Contenuti installati" modal (import receipts). Both lenses are merged here,
// filterable by kind, with per-row removal and a remove-everything action.
//
// It owns NO removal logic. Receipts are removed through
// PresetShare.uninstallContent — the reference-counted engine that knows a
// download's true footprint (shared widgets, pack updates, active-theme
// fallback). SDK packages with no owning receipt are removed the way the
// settings list always removed them: DELETE /sdk/widget/<id> plus a purge of
// their tile assignment and grant. Forking either path would let the two
// surfaces disagree about what a download owns.
//
// Rows come from two sources:
//   • an import receipt (theme/page/deck/bundle/bg/widget/ambient/icons/sounds)
//   • an SDK widget package, individually manageable
// A widget-kind receipt owning exactly one package is merged INTO that package's
// row (grants, update, export) rather than listed twice. A bundle keeps its own
// row AND its widgets keep theirs — removing the bundle takes everything,
// removing one widget just drops it from the bundle's receipt.
//
// All catalog/manifest text is untrusted → textContent only.
(function () {
  const t = (k, fb) => {
    const v = (typeof window.t === 'function') ? window.t(k) : k;
    return (v === k && fb != null) ? fb : v;
  };
  const el = makeEl; // shared DOM factory from utils.js
  const HS = () => { try { return (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : {}; } catch { return {}; } };
  const PS = () => window.PresetShare || null;
  // There is no global `toast` — XenonToast is the shared toaster (preset-share
  // wraps it the same way). Guarding on a bare `toast` identifier would silently
  // swallow every message here.
  const toast = (title, message, type) => {
    if (window.XenonToast) window.XenonToast.show({ type: type || 'info', title, message: message || '', duration: 3600 });
  };

  // Kind chips, in the Store's own display order. '' is "All".
  const KIND_ORDER = ['bundle', 'theme', 'bg', 'page', 'widget', 'deck', 'ambient', 'icons', 'sounds'];
  let activeKind = '';

  // ── Rejected widget folders ────────────────────────────────────────────────
  // The package scan already records WHY it skipped a folder (server-side
  // listPackages → `invalid`), and the host has always cached that list — but
  // nothing ever put it on screen. So dropping a folder Xenon can't read meant
  // the widget simply never appeared, with no message anywhere: the user was
  // left guessing, which is exactly the silent no-op the project forbids. The
  // reported case was a folder named "ip-info-widget 1.0.0" — the folder name IS
  // the package id, so a space and dots fail the id rule and the whole folder is
  // skipped. Listing it here with the reason turns a dead end into a fix.
  const REJECT_HINTS = {
    bad_id: ['installed_bad_id', 'Il nome della cartella può contenere solo lettere minuscole, cifre e trattini. Rinominala (per esempio «ip-info-widget») e riapri lo Store.'],
    id_mismatch: ['installed_bad_id_mismatch', 'L\'id nel manifest.json non corrisponde al nome della cartella. Rendili identici.'],
    missing_manifest: ['installed_no_manifest', 'Manca manifest.json nella cartella.'],
    bad_manifest: ['installed_bad_manifest', 'manifest.json non è leggibile o è troppo grande.'],
    missing_entry: ['installed_no_entry', 'Il file indicato da "entry" nel manifest non esiste nella cartella.'],
    bad_entry: ['installed_bad_entry', 'Il campo "entry" del manifest non è valido.'],
    missing_name: ['installed_no_name', 'Nel manifest manca il campo "name".'],
    bad_version: ['installed_bad_version', 'Il campo "version" del manifest non è valido.'],
    unsupported_api: ['installed_bad_api', 'Il widget dichiara una versione di API che questa build non supporta.'],
    too_large: ['installed_too_large', 'La cartella supera il limite di dimensione.'],
  };
  function rejectHint(reason) {
    const hit = REJECT_HINTS[reason];
    if (hit) return t(hit[0], hit[1]);
    // Unknown/rarer reasons (bad_hosts, bad_deck, bad_storage_group…) still get a
    // real answer: the raw code names the offending manifest field precisely
    // enough for a creator to act on, which beats inventing a vague sentence.
    return t('installed_bad_generic', 'Il manifest non ha superato il controllo ({r}).').replace('{r}', String(reason || '?'));
  }
  function rejectedBlock(invalid) {
    if (!Array.isArray(invalid) || !invalid.length) return null;
    const box = el('div', 'inst-rejected');
    box.appendChild(el('p', 'inst-rejected-title', invalid.length === 1
      ? t('installed_rejected_one', '1 cartella widget non è stata caricata')
      : t('installed_rejected_n', '{n} cartelle widget non sono state caricate').replace('{n}', String(invalid.length))));
    const list = el('div', 'inst-rejected-list');
    invalid.forEach((bad) => {
      const row = el('div', 'inst-rejected-row');
      // Folder names are untrusted filesystem text → textContent, never markup.
      row.appendChild(el('code', 'inst-rejected-name', String((bad && bad.id) || '?')));
      row.appendChild(el('span', 'inst-rejected-why', rejectHint(bad && bad.reason)));
      list.appendChild(row);
    });
    box.appendChild(list);
    box.appendChild(el('p', 'cgal-status', t('installed_rejected_foot', 'Le cartelle si trovano in server/data/widgets. Dopo averle sistemate, riapri lo Store.')));
    return box;
  }

  // A row answers to ONE chip: the thing it actually is. A receipt files under
  // the kind it was published as — so a bundle lives under "Packages", not under
  // every kind it happens to contain. Filtering "Widget" must list widgets, not
  // the package they arrived in (which the "Packages" chip already shows).
  function kindOf(row) {
    if (!row.record) return 'widget';           // a bare SDK package
    return row.record.kind || 'bundle';
  }

  // Build the row list. Two kinds of row, and they never describe the same
  // thing twice:
  //   • a receipt — the download unit; removing it removes its whole footprint
  //   • an SDK package — an individually removable widget
  // A widget-kind receipt that owns exactly one package IS that package, so it
  // renders as a single enriched row. A bundle's widgets stay individually
  // listed (that granularity existed before this tab and must survive): removing
  // one drops it from the bundle's receipt via forgetInstalledContentResource.
  async function collect() {
    let packages = [];
    try {
      const d = await fetch('/sdk/widgets').then((r) => r.json());
      packages = (d && d.packages) || [];
    } catch { /* server unreachable → receipts only */ }
    const records = (typeof ContentInstalls !== 'undefined')
      ? ContentInstalls.normalizeContentInstalls(HS().contentInstalls) : [];
    let legacy = null;
    try { legacy = PS() ? await PS().legacyImportRecord(records, packages) : null; } catch { legacy = null; }
    const all = legacy ? records.concat([legacy]) : records;

    const pkgById = new Map(packages.map((p) => [p.id, p]));
    const merged = new Set();   // packages already represented by their own receipt
    const rows = all.slice().sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0)).map((record) => {
      const ids = record.resources.widgetIds || [];
      const solo = (record.kind === 'widget' && ids.length === 1 && ContentInstalls.resourceCount(record.resources) === 1)
        ? pkgById.get(ids[0]) : null;
      if (solo) merged.add(solo.id);
      return { record, pkg: solo || null };
    });
    // A bundle's widgets stay individually listed, so the SAME package appears
    // twice: once as the download it came in, once as the removable widget. The
    // widget half had nothing to look itself up with — the catalog publishes the
    // BUNDLE (pkgId: null), not its parts — so it fell back to the grey glyph and
    // the two rows for one thing looked like two different things. The receipt
    // already records which widgets it installed, so the owner is provable rather
    // than guessed, and the widget row inherits the artwork of the package it
    // arrived in.
    const ownerByPkg = new Map();
    for (const record of all) {
      for (const id of (record.resources.widgetIds || [])) {
        if (!merged.has(id) && !ownerByPkg.has(id)) ownerByPkg.set(id, record);
      }
    }
    packages.filter((p) => !merged.has(p.id))
      .forEach((pkg) => rows.push({ record: null, pkg, owner: ownerByPkg.get(pkg.id) || null }));
    return rows;
  }

  // ONE catalog read serves both jobs: which rows have an update, and which have
  // a published screenshot. The update JOIN stays CommunityGallery.findUpdates —
  // the single implementation shared with the gallery and the daily toast, so
  // the surfaces can never disagree. Offline just means no badges and no thumbs.
  let catalogCache = null;
  async function catalogIndex(force) {
    if (catalogCache && !force) return catalogCache;
    // `updates` is keyed by pkgId (SDK packages), `updatesById` by catalog entry
    // id (everything installed through a receipt: themes, decks, packs, pages).
    // Keeping only the pkgId half — as this did — meant a theme with a published
    // update showed no button here at all, even though findUpdates had returned
    // it and the gallery was already offering it.
    const out = { updates: new Map(), updatesById: new Map(), byId: new Map(), byPkgId: new Map(), byDropId: new Map() };
    try {
      const cat = await fetch('/api/community/catalog').then((r) => r.json());
      const entries = (cat && cat.entries) || [];
      for (const e of entries) {
        if (!e || !e.id) continue;
        out.byId.set(e.id, e);
        if (e.pkgId) out.byPkgId.set(e.pkgId, e);
        // Every copy id a numbered drop can hand out, mapped to the one published
        // entry, so a receipt naming a single copy still finds its catalog row.
        const lim = e.limited;
        if (lim && lim.numbered && lim.dropId && Number(lim.total) > 0) {
          const width = String(lim.total).length;
          for (let n = 1; n <= Math.min(Number(lim.total), 999); n++) {
            out.byDropId.set(lim.dropId + '-' + String(n).padStart(width, '0'), e);
          }
        }
      }
      const updates = (window.CommunityGallery && window.CommunityGallery.findUpdates)
        ? await window.CommunityGallery.findUpdates(entries) : [];
      for (const entry of updates) {
        if (entry.pkgId) out.updates.set(entry.pkgId, entry);
        else out.updatesById.set(entry.id, entry);
      }
    } catch { /* offline → no update hints, no thumbnails */ }
    catalogCache = out;
    return out;
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

  // A single 1st-screenshot thumbnail: webp → png → kind glyph. Deliberately not
  // the gallery's buildMedia (shot strips, live bg iframes, generated canvases) —
  // this is a dense operational list, not a storefront.
  function thumbFor(row, entry) {
    const kind = kindOf(row);
    const glyph = () => {
      const box = el('span', 'inst-thumb is-glyph');
      if (window.CommunityGallery && CommunityGallery.kindIcon) box.appendChild(CommunityGallery.kindIcon(kind));
      return box;
    };
    const shots = entry && entry.shots ? entry.shots : 0;
    if (!shots || !(window.CommunityGallery && CommunityGallery.shotUrl)) return glyph();
    const box = el('span', 'inst-thumb');
    const img = document.createElement('img');
    img.loading = 'lazy'; img.alt = ''; img.decoding = 'async';
    let triedPng = false;
    img.addEventListener('error', () => {
      if (!triedPng) { triedPng = true; img.src = CommunityGallery.shotUrl(entry.id, 1, 'png'); return; }
      box.replaceWith(glyph());   // sidecar genuinely missing → don't leave a hole
    });
    img.src = CommunityGallery.shotUrl(entry.id, 1, 'webp');
    box.appendChild(img);
    return box;
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

  // Remove an SDK package no receipt owns. Same steps the settings list ran:
  // delete the folder, forget any stale receipt reference, purge assignment+grant.
  async function removePackage(pkg, skipConfirm) {
    const ok = skipConfirm === true || (typeof settingsPrompt === 'function'
      ? await settingsPrompt({
        type: 'confirm',
        title: t('settings_sdk_remove', 'Rimuovi'),
        message: t('settings_sdk_remove_confirm', 'Rimuovere questo widget? Le tile che lo usano torneranno alla scelta del widget.'),
        okLabel: t('settings_sdk_remove', 'Rimuovi'),
      })
      : window.confirm(t('settings_sdk_remove_confirm', 'Rimuovere questo widget?')));
    if (!ok) return false;
    try {
      await fetch('/sdk/widget/' + encodeURIComponent(pkg.id), { method: 'DELETE' }).then((r) => r.arrayBuffer());
      if (typeof forgetInstalledContentResource === 'function') forgetInstalledContentResource('widgetIds', pkg.id);
      const cur = HS().sdkWidgets || {};
      const assign = Object.assign({}, cur.assign || {});
      for (const k of Object.keys(assign)) if (assign[k] === pkg.id) delete assign[k];
      const grants = Object.assign({}, cur.grants || {});
      delete grants[pkg.id];
      if (typeof updateSdkWidgets === 'function') updateSdkWidgets({ assign, grants });
      if (window.CustomWidget && CustomWidget.refreshPackages) CustomWidget.refreshPackages();
      return true;
    } catch {
      toast(t('settings_sdk_remove_failed', 'Rimozione non riuscita'), '', 'error');
      return false;
    }
  }

  // Remove EVERYTHING downloaded, in one confirmed sweep. Each item still goes
  // through its own engine (receipts through uninstallContent, orphan packages
  // through removePackage) — this only skips the per-item confirmation, which
  // the user just gave once for the whole set.
  async function removeAll(rows, repaint) {
    const ok = (typeof settingsPrompt === 'function')
      ? await settingsPrompt({
        type: 'confirm',
        title: t('installed_remove_all_title', 'Rimuovi tutto'),
        message: t('installed_remove_all_confirm', 'Rimuovere tutti i {n} contenuti installati e tutto ciò che hanno aggiunto? Le tue creazioni non vengono toccate. Non si può annullare.').replace('{n}', String(rows.length)),
        okLabel: t('installed_remove_all_ok', 'Rimuovi tutto'),
      })
      : window.confirm(t('installed_remove_all_confirm', 'Rimuovere tutti i contenuti installati?'));
    if (!ok) return;
    let done = 0;
    for (const row of rows) {
      try {
        const removed = row.record
          ? await PS().uninstallContent(row.record, { skipConfirm: true })
          : await removePackage(row.pkg, true);
        if (removed) done++;
      } catch { /* keep sweeping — one failure must not strand the rest */ }
    }
    catalogCache = null;
    {
      if (done === rows.length) toast(t('installed_content_removed', 'Contenuti rimossi'), '', 'success');
      // Report the shortfall honestly rather than claiming a clean sweep.
      else toast(t('installed_remove_all_partial', 'Rimossi {n} di {total} — riprova per i restanti.').replace('{n}', String(done)).replace('{total}', String(rows.length)), '', 'error');
    }
    repaint();
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

  // Apply an available update. Returns true when the row should repaint.
  //
  // Two shapes, because installing a widget and installing a theme are genuinely
  // different acts. An SDK package re-installs through /sdk/install (a widened
  // manifest re-prompts via grantNeedsReview on next mount, never auto-granted).
  // Everything else goes back through PresetShare.openImport — the same full
  // preview + approval a first install gets. Neither path ever swaps content
  // silently, which is the property that makes a one-click update safe to offer.
  async function applyUpdate(upd) {
    try {
      const codeRes = upd.code
        ? { ok: true, code: upd.code }
        : await fetch('/api/community/code?id=' + encodeURIComponent(upd.id)).then((r) => r.json());
      if (!codeRes || !codeRes.ok || !codeRes.code) throw new Error('bad_code');
      const env = PS() ? PS().decodePreset(codeRes.code) : null;
      if (!env) throw new Error('bad_code');

      if (env.kind === 'widget' || env.kind === 'ambient') {
        const payload = (env.data && env.data.payload) || env.data;
        if (!payload) throw new Error('bad_code');
        const r = await fetch('/sdk/install', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          // Tell the server which catalog version this is. The package manifest
          // carries a different number, set by whoever built it, and comparing
          // the two produced an update that re-appeared after every successful
          // install (see recordWidgetOrigin in server.js).
          body: JSON.stringify(Object.assign({}, payload, { origin: 'import', catalogVersion: upd.version || '' })),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || 'install_failed');
        if (window.CustomWidget && CustomWidget.refreshPackages) CustomWidget.refreshPackages();
        return true;
      }

      // A theme/deck/pack update is an import: it opens the normal dialog, which
      // owns the outcome from here (including the receipt that clears the badge).
      if (!PS()) throw new Error('no_import');
      PS().openImport(codeRes.code, { source: 'catalog', sourceId: upd.id, sourceVersion: upd.version || '' });
      return false;
    } catch {
      toast(t('settings_sdk_update_failed', 'Aggiornamento non riuscito'), '', 'error');
      return false;
    }
  }

  function renderRow(row, cat, repaint) {
    const wrap = el('div', 'inst-row' + (row.record && row.record.legacy ? ' is-legacy' : ''));
    wrap.appendChild(thumbFor(row, entryFor(row, cat)));
    const info = el('div', 'inst-row-info');
    const head = el('div', 'inst-row-head');
    const name = el('b', 'inst-row-name', row.record
      ? (row.record.name || t('installed_content_unnamed', 'Contenuto importato'))
      : row.pkg.name);
    head.appendChild(name);

    const kindKey = row.record ? row.record.kind : 'widget';
    const badge = el('span', 'inst-kind', row.record && row.record.legacy
      ? t('installed_content_legacy_badge', 'Legacy')
      : t('preset_kind_' + kindKey, kindKey));
    head.appendChild(badge);

    // Provenance: only two honest labels — your own work, or a community
    // install. An 'unknown' package gets none; it offers the claim button below.
    if (row.pkg && row.pkg.exportable) head.appendChild(el('span', 'inst-origin is-mine', t('settings_sdk_origin_mine', 'Creato da te')));
    else if (row.record ? row.record.source === 'catalog' : row.pkg.origin === 'import') head.appendChild(el('span', 'inst-origin', t('settings_sdk_origin_community', 'Dalla community')));
    // Live resource accounting from the host probe (custom-widget.js): a small
    // chip so the user can SEE which installed widget is costing CPU instead of
    // bisecting by uninstall. Only shown once a report exists for this package.
    const suspended = row.pkg && window.CustomWidget && typeof CustomWidget.isSuspended === 'function'
      && CustomWidget.isSuspended(row.pkg.id);
    if (suspended) {
      head.appendChild(el('span', 'inst-activity is-paused', t('settings_sdk_suspended_badge', 'In pausa')));
    } else if (row.pkg && window.CustomWidget && typeof CustomWidget.getPerfStats === 'function') {
      const stat = CustomWidget.getPerfStats()[row.pkg.id];
      if (stat) {
        const chip = el('span', 'inst-activity is-' + stat.level,
          t('settings_sdk_activity', 'Attività') + ': ' + t('settings_sdk_activity_' + stat.level, stat.level));
        if (stat.longTaskMsPerMin > 0) chip.title = t('settings_sdk_activity_detail', 'Tempo CPU bloccato al minuto') + ': ~' + stat.longTaskMsPerMin + ' ms';
        head.appendChild(chip);
      }
    }
    info.appendChild(head);

    const meta = metaLine(row);
    if (meta) info.appendChild(el('span', 'inst-row-meta', meta));
    wrap.appendChild(info);

    const upd = updateFor(row, cat);
    // What the new version changes, straight from the publisher. Before this the
    // prompt asked for a permission re-approval while explaining nothing, so
    // "should I?" had no answerable form.
    if (upd && upd.changelog) {
      const cl = el('span', 'inst-row-changelog');
      cl.textContent = '“' + upd.changelog + '”';
      info.appendChild(cl);
    }

    const btns = el('div', 'inst-row-btns');
    if (upd) {
      const b = el('button', 'settings-btn primary', t('settings_sdk_update', 'Aggiorna') + ' → v' + upd.version);
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const done = await applyUpdate(upd);
        if (done) { catalogCache = null; repaint(); }
        else b.disabled = false;
      });
      btns.appendChild(b);
    }
    // An installed-but-ungranted package is an installed DEAD package, and this
    // list was the one place that showed it without offering the fix. Placing a
    // tile used to be the only way to reach the dialog — impossible for a widget
    // that needs no tile (a badge-only one with `background`), which is exactly
    // how a package could install, look right here, and never appear anywhere.
    if (row.pkg && window.CustomWidget && typeof CustomWidget.packageGranted === 'function'
        && !CustomWidget.packageGranted(row.pkg)) {
      const gr = el('button', 'settings-btn primary', t('settings_sdk_grant_btn', 'Permessi'));
      gr.type = 'button';
      gr.addEventListener('click', () => {
        if (CustomWidget.requestGrant) CustomWidget.requestGrant(row.pkg, repaint);
      });
      btns.appendChild(gr);
    }
    // A package with user-filled address slots needs a way back to the field
    // after approval — a NAS gets a new IP, a port changes, someone mistypes.
    // The permission dialog IS the editor (prefilled), so this just reopens it.
    if (row.pkg && Array.isArray(row.pkg.userHosts) && row.pkg.userHosts.length) {
      const addr = el('button', 'settings-btn', t('settings_sdk_address', 'Indirizzo'));
      addr.type = 'button';
      addr.addEventListener('click', () => {
        if (window.CustomWidget && CustomWidget.requestGrant) CustomWidget.requestGrant(row.pkg, repaint);
      });
      btns.appendChild(addr);
    }
    // Export only your own work — community installs aren't redistributable (the
    // server refuses them anyway). An 'unknown' package instead offers the
    // deliberate "I made this" claim, which unlocks export.
    if (row.pkg && row.pkg.exportable) {
      const exp = el('button', 'settings-btn', t('settings_sdk_export', 'Esporta'));
      exp.type = 'button';
      exp.addEventListener('click', () => { if (PS() && PS().exportWidgetPkg) PS().exportWidgetPkg(row.pkg); });
      btns.appendChild(exp);
    } else if (row.pkg && row.pkg.origin === 'unknown') {
      const claim = el('button', 'settings-btn subtle', t('settings_sdk_claim', 'L\'ho creato io'));
      claim.type = 'button';
      claim.addEventListener('click', async () => {
        const ok = (typeof settingsPrompt === 'function') ? await settingsPrompt({
          type: 'confirm',
          title: t('settings_sdk_claim', 'L\'ho creato io'),
          message: t('settings_sdk_claim_confirm', 'Confermi di aver creato tu questo widget? Solo le tue creazioni originali si possono condividere — non marcare come tuo qualcosa installato da altri.'),
          okLabel: t('settings_sdk_claim_ok', 'Sì, è mio'),
        }) : window.confirm(t('settings_sdk_claim_confirm', 'Confermi di aver creato tu questo widget?'));
        if (!ok) return;
        try {
          const r = await fetch('/sdk/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: row.pkg.id }) });
          const d = await r.json().catch(() => ({}));
          if (r.ok && d.ok) repaint();
          else toast(t('settings_sdk_claim_failed', 'Operazione non riuscita'), '', 'error');
        } catch { toast(t('settings_sdk_claim_failed', 'Operazione non riuscita'), '', 'error'); }
      });
      btns.appendChild(claim);
    }
    // Pause without uninstalling: the frame (tile + background) stops, grants
    // and assignments stay, and Resume brings it back exactly as it was. The
    // cheap answer to "this widget is heavy but I still want it".
    if (row.pkg && window.CustomWidget && typeof CustomWidget.setSuspended === 'function') {
      const isSus = !!suspended;
      const sus = el('button', 'settings-btn', isSus ? t('settings_sdk_resume', 'Riattiva') : t('settings_sdk_suspend', 'Sospendi'));
      sus.type = 'button';
      sus.addEventListener('click', () => { CustomWidget.setSuspended(row.pkg.id, !isSus); repaint(); });
      btns.appendChild(sus);
    }
    const del = el('button', 'settings-btn danger', t('settings_sdk_remove', 'Rimuovi'));
    del.type = 'button';
    del.addEventListener('click', async () => {
      del.disabled = true;
      const done = row.record ? await PS().uninstallContent(row.record) : await removePackage(row.pkg);
      if (!done) { del.disabled = false; return; }
      catalogCache = null;
      repaint();
    });
    btns.appendChild(del);
    wrap.appendChild(btns);
    return wrap;
  }

  // Paint into `host` (the Store's scroll body). Re-entrant: every mutation
  // repaints from freshly collected state rather than patching the DOM.
  async function render(host, force) {
    if (!host) return;
    host.replaceChildren(el('div', 'cgal-status', t('installed_loading', 'Cerco i contenuti installati…')));
    const rows = await collect();
    if (!host.isConnected) return;
    const cat = await catalogIndex(force);
    if (!host.isConnected) return;
    const repaint = () => render(host, false);
    // Folders the package scan refused. Read from the same cached list the tiles
    // use; a `force` repaint re-scans so a fixed folder disappears from here.
    let rejected = [];
    try {
      if (window.CustomWidget && typeof window.CustomWidget.getPackages === 'function') {
        const scan = await window.CustomWidget.getPackages(!!force);
        if (scan && Array.isArray(scan.invalid)) rejected = scan.invalid;
      }
    } catch { /* the scan is advisory — never block the list on it */ }
    if (!host.isConnected) return;

    const frag = document.createDocumentFragment();
    if (!rows.length) {
      // The rejected block goes in BEFORE this early return on purpose: a user
      // whose only widget folder was refused has nothing installed, and would
      // otherwise get "you haven't installed anything" with no hint that a
      // folder was found and skipped.
      const rejEmpty = rejectedBlock(rejected);
      if (rejEmpty) frag.appendChild(rejEmpty);
      const empty = el('div', 'inst-empty');
      empty.appendChild(el('p', 'inst-empty-title', t('installed_empty_title', 'Non hai ancora installato nulla')));
      empty.appendChild(el('p', 'cgal-status', t('installed_empty_desc', 'Temi, sfondi, widget, scene e pacchetti che installi dallo Store compaiono qui — con tutto ciò che hanno aggiunto.')));
      const cta = el('button', 'cgal-btn cgal-btn--primary', t('installed_empty_cta', 'Sfoglia lo Store'));
      cta.type = 'button';
      cta.addEventListener('click', () => { if (window.CommunityGallery) window.CommunityGallery.open(); });
      empty.appendChild(cta);
      frag.appendChild(empty);
      host.replaceChildren(frag);
      return;
    }

    // Kind chips — only kinds actually present, so the filter never offers a
    // dead end.
    const present = new Set(rows.map(kindOf));
    if (activeKind && !present.has(activeKind)) activeKind = '';
    const chips = el('div', 'inst-chips');
    const mkChip = (k, label) => {
      const b = el('button', 'inst-chip' + (activeKind === k ? ' active' : ''), label);
      b.type = 'button';
      b.addEventListener('click', () => { activeKind = k; render(host, false); });
      return b;
    };
    chips.appendChild(mkChip('', t('gallery_all', 'Tutti')));
    KIND_ORDER.filter((k) => present.has(k)).forEach((k) => chips.appendChild(mkChip(k, t('preset_kind_' + k, k))));
    frag.appendChild(chips);

    // Above the list, not buried under it: a folder that was refused is the
    // reason someone is looking at this tab in the first place.
    const rejBlock = rejectedBlock(rejected);
    if (rejBlock) frag.appendChild(rejBlock);

    // ── Update all ──
    // Only for rows that can genuinely go one-click: an SDK package re-installs
    // without a dialog. Import-kinds (themes, decks, packs) each open their own
    // preview + approval, and firing several of those at once would bury the user
    // under stacked modals — so they keep their per-row button and are counted
    // out of this banner rather than silently included in a promise it can't keep.
    const updatable = rows.filter((row) => {
      const u = updateFor(row, cat);
      return u && row.pkg && cat.updates.has(row.pkg.id);
    });
    const otherUpdates = rows.filter((row) => updateFor(row, cat)).length - updatable.length;
    if (updatable.length) {
      const bar = el('div', 'inst-updbar');
      const label = updatable.length === 1
        ? t('installed_update_one', '1 aggiornamento disponibile')
        : t('installed_update_n', '{n} aggiornamenti disponibili').replace('{n}', String(updatable.length));
      bar.appendChild(el('span', 'inst-updbar-txt', otherUpdates
        ? label + ' · ' + t('installed_update_others', '{n} altri da aggiornare singolarmente').replace('{n}', String(otherUpdates))
        : label));
      const go = el('button', 'settings-btn primary', t('installed_update_all', 'Aggiorna tutti'));
      go.type = 'button';
      go.addEventListener('click', async () => {
        go.disabled = true;
        go.textContent = t('installed_updating', 'Aggiorno…');
        let done = 0;
        for (const row of updatable) {
          const u = updateFor(row, cat);
          if (u && await applyUpdate(u)) done++;
        }
        catalogCache = null;
        if (done === updatable.length) toast(t('installed_update_all_done', 'Tutto aggiornato'), '', 'success');
        // Report the shortfall honestly rather than claiming a clean sweep —
        // same rule the remove-all path follows.
        else toast(t('installed_update_all_partial', 'Aggiornati {n} di {total} — riprova per i restanti.')
          .replace('{n}', String(done)).replace('{total}', String(updatable.length)), '', 'error');
        repaint();
      });
      bar.appendChild(go);
      frag.appendChild(bar);
    }

    const shown = activeKind ? rows.filter((row) => kindOf(row) === activeKind) : rows;
    const list = el('div', 'inst-list');
    if (!shown.length) list.appendChild(el('div', 'cgal-status', t('installed_filter_empty', 'Nessun contenuto di questo tipo.')));
    else shown.forEach((row) => list.appendChild(renderRow(row, cat, repaint)));
    frag.appendChild(list);

    const foot = el('div', 'inst-foot');
    foot.appendChild(el('span', 'cgal-status', t('installed_foot_note', 'Rimuovere un contenuto elimina tutto ciò che aveva aggiunto. Le tue creazioni restano.')));
    const all = el('button', 'settings-btn danger', t('installed_remove_all_ok', 'Rimuovi tutto'));
    all.type = 'button';
    all.addEventListener('click', () => removeAll(rows, repaint));
    foot.appendChild(all);
    frag.appendChild(foot);

    host.replaceChildren(frag);
  }

  function reset() { activeKind = ''; catalogCache = null; }

  window.InstalledManager = { render, reset };
})();
