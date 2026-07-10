'use strict';
// Community gallery ("Scopri") — browse artifacts published on the project
// site and install them through the NORMAL import pipeline.
//
// The catalog arrives via GET /api/community/catalog (server-normalized, TTL
// cached — see server/community-catalog.js). Every field is still treated as
// untrusted text here (textContent only), and tapping Install NEVER applies
// anything: it feeds the entry's share code into PresetShare.openImport, so
// the user gets the exact same per-kind preview/permission dialogs as a
// hand-pasted code. Live previews exist only for 'bg' entries and run inside
// the same sandboxed iframe the import preview uses (CustomBg.buildSrcdoc),
// created lazily while the card is on screen and torn down when it leaves.
(function () {
  const t = (k, fb) => {
    const v = (typeof window.t === 'function') ? window.t(k) : k;
    return (v === k && fb != null) ? fb : v;
  };
  const el = makeEl; // shared DOM factory from utils.js
  const BMC_URL = 'https://www.buymeacoffee.com/marcimastro98';

  const api = apiJson; // shared fetch-JSON helper from utils.js

  let overlayEl = null;
  let previewObserver = null;   // IntersectionObserver for lazy bg previews
  // Screenshot sidecars live NEXT TO the catalog on the project site; the URL is
  // derived from the (charset-pinned) entry id — never from catalog-supplied text.
  const SHOTS_BASE = 'https://marcimastro98.github.io/Xenon/community/shots/';
  // Browse state (kept while the overlay is open).
  let searchQuery = '';
  let activeKind = '';
  let activeCategory = '';

  function close() {
    if (previewObserver) { previewObserver.disconnect(); previewObserver = null; }
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  }

  function kindLabel(kind) {
    return t('gallery_kind_' + kind, t('preset_kind_' + kind, kind));
  }

  // Lazy live preview for 'bg' entries: mount the sandboxed iframe only while
  // the card is visible, and only for inline codes (a codeFile entry would need
  // a fetch per card — not worth it for a browse view).
  function armPreview(host, entry) {
    if (entry.kind !== 'bg' || !entry.code || !window.CustomBg || !window.PresetShare) return;
    if (!previewObserver) {
      previewObserver = new IntersectionObserver((records) => {
        for (const r of records) {
          const box = r.target;
          if (r.isIntersecting && !document.body.classList.contains('game-mode')) {
            if (!box.firstChild && box._cgCode) {
              const frame = document.createElement('iframe');
              frame.className = 'cgal-preview-frame';
              frame.setAttribute('sandbox', 'allow-scripts');
              frame.setAttribute('referrerpolicy', 'no-referrer');
              frame.srcdoc = CustomBg.buildSrcdoc(box._cgCode, box._cgAssets);
              box.appendChild(frame);
            }
          } else {
            box.replaceChildren();   // off-screen → stop the animation entirely
          }
        }
      }, { threshold: 0.15 });
    }
    const env = PresetShare.decodePreset(entry.code);
    if (!env || env.kind !== 'bg' || typeof env.data.code !== 'string') return;
    host._cgCode = env.data.code;
    // Bundled images ride the envelope — the preview must show them, or an
    // image-based background would look broken here yet fine on import.
    host._cgAssets = CustomBg.sanitizeBgAssets ? CustomBg.sanitizeBgAssets(env.data.assets) : null;
    previewObserver.observe(host);
  }

  async function resolveCode(entry) {
    if (entry.code) return entry.code;
    const d = await api('/api/community/code?id=' + encodeURIComponent(entry.id));
    return (d && d.ok && typeof d.code === 'string') ? d.code : null;
  }

  function renderCard(entry) {
    const card = el('div', 'cgal-card');
    card.id = 'cgal-' + entry.id;

    const head = el('div', 'cgal-card-head');
    const kind = el('span', 'preset-modal-kind', kindLabel(entry.kind));
    head.appendChild(kind);
    if (entry.locked || entry.supportersOnly) {
      const lockBadge = document.createElement('a');
      lockBadge.className = 'cgal-badge cgal-badge-lock';
      lockBadge.textContent = '🔒 ' + t('gallery_locked_badge', 'Supporters');
      lockBadge.href = BMC_URL;
      lockBadge.target = '_blank';
      lockBadge.rel = 'noopener noreferrer';
      lockBadge.title = t('gallery_locked_hint', 'Protected with access codes — become a supporter to get one.');
      head.appendChild(lockBadge);
    }
    card.appendChild(head);

    const nameRow = el('div', 'cgal-name', entry.name);
    if (entry.version) nameRow.appendChild(el('span', 'cgal-version', ' v' + entry.version));
    card.appendChild(nameRow);
    // Publisher (v2) wins over the plain author string; its link renders only
    // because the server already scheme+host-allowlisted it (github.com https).
    if (entry.publisher && entry.publisher.handle) {
      const by = el('div', 'cgal-author');
      by.appendChild(document.createTextNode(t('gallery_by', 'by') + ' '));
      if (entry.publisher.url) {
        const a = document.createElement('a');
        a.href = entry.publisher.url;
        a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = '@' + entry.publisher.handle;
        by.appendChild(a);
      } else {
        by.appendChild(document.createTextNode('@' + entry.publisher.handle));
      }
      if (entry.authorSupporter) { by.appendChild(document.createTextNode(' ⭐')); by.title = t('gallery_supporter_badge', 'Xenon supporter'); }
      card.appendChild(by);
    } else if (entry.author) {
      const by = el('div', 'cgal-author', t('gallery_by', 'by') + ' ' + entry.author + (entry.authorSupporter ? ' ⭐' : ''));
      if (entry.authorSupporter) by.title = t('gallery_supporter_badge', 'Xenon supporter');
      card.appendChild(by);
    }
    if (entry.description) card.appendChild(el('div', 'cgal-desc', entry.description));
    if (Array.isArray(entry.tags) && entry.tags.length) {
      const tags = el('div', 'cgal-tags');
      entry.tags.forEach((tag) => tags.appendChild(el('span', 'cgal-tag', '#' + tag)));
      card.appendChild(tags);
    }
    // Screenshot / GIF sidecars (lazy; a missing shot removes itself). Up to
    // MAX_SHOTS live next to the catalog as id-derived .webp files
    // (shots/<id>.webp, shots/<id>-2.webp … — animated WebP allowed). One shot
    // renders inline; two or more become a swipeable scroll-snap strip.
    const shotCount = entry.shots || (entry.screenshot ? 1 : 0);
    if (shotCount > 0) {
      const strip = el('div', 'cgal-shots' + (shotCount > 1 ? ' multi' : ''));
      for (let i = 1; i <= shotCount; i++) {
        const shot = document.createElement('img');
        shot.className = 'cgal-shot';
        shot.loading = 'lazy';
        shot.alt = '';
        shot.src = SHOTS_BASE + encodeURIComponent(entry.id) + (i === 1 ? '' : '-' + i) + '.webp';
        shot.addEventListener('error', () => shot.remove());
        strip.appendChild(shot);
      }
      card.appendChild(strip);
    }

    // Theme swatches (server-validated hex — used only as CSS background).
    if (entry.preview && (entry.preview.accent || entry.preview.bg || entry.preview.text)) {
      const sw = el('div', 'cgal-swatches');
      for (const key of ['accent', 'bg', 'text']) {
        const v = entry.preview[key];
        if (!v) continue;
        const dot = el('span', 'preset-swatch-dot');
        dot.style.background = v;
        sw.appendChild(dot);
      }
      card.appendChild(sw);
    }

    // Live bg preview slot (filled lazily by the observer).
    if (entry.kind === 'bg' && entry.code) {
      const prev = el('div', 'cgal-preview');
      card.appendChild(prev);
      armPreview(prev, entry);
    }

    const row = el('div', 'cgal-card-actions');
    const install = el('button', 'settings-btn primary', t('gallery_import', 'Import…'));
    install.type = 'button';
    // Version gating is computed server-side (same semver helpers as the
    // update checker) — the client just renders the verdict.
    if (entry.needsNewerApp) {
      install.disabled = true;
      row.appendChild(el('span', 'cgal-needs', t('gallery_requires_version', 'Requires Xenon') + ' v' + entry.appVersionMin));
    }
    install.addEventListener('click', async () => {
      install.disabled = true;
      const code = await resolveCode(entry);
      install.disabled = false;
      if (!code) {
        if (window.XenonToast) XenonToast.show({ type: 'error', title: t('gallery_error', 'Could not load this entry.') });
        return;
      }
      close();
      if (window.PresetShare) PresetShare.openImport(code);
    });
    row.appendChild(install);
    card.appendChild(row);
    return card;
  }

  // Available updates for installed SDK packages: catalog entries whose pkgId
  // matches an installed manifest with an older version. Best-effort (empty
  // when the SDK is off / nothing installed / offline). THE single update-join
  // implementation — Settings' installed-packages manager and the daily check
  // consume it via window.CommunityGallery.findUpdates, so the two surfaces can
  // never disagree about whether an update exists. Locked entries are excluded:
  // they can't be one-click updated (the code needs an access code).
  async function findUpdates(entries) {
    try {
      const inst = await api('/sdk/widgets');
      const installed = new Map(((inst && inst.packages) || []).map((p) => [p.id, String(p.version || '0.0.0')]));
      if (!installed.size) return [];
      // Fail-CLOSED parse (mirrors server/semver.js, which is server-only):
      // installed manifest versions are loosely validated ('v1.2.3',
      // '2.0.0-beta' survive install), and coercing junk to 0.0.0 would show a
      // false "update available" badge inviting a downgrade-reinstall. A
      // malformed side must never produce an update hint.
      const parse = (v) => (/^[0-9]+(\.[0-9]+)*$/.test(String(v)) ? String(v).split('.').map(Number) : null);
      const less = (a, b) => {
        const pa = parse(a), pb = parse(b);
        if (!pa || !pb) return false;
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
        }
        return false;
      };
      return entries.filter((e) => e && e.pkgId && e.version && !e.locked && installed.has(e.pkgId) && less(installed.get(e.pkgId), e.version));
    } catch { return []; }
  }

  function matchesBrowse(entry) {
    if (activeKind && entry.kind !== activeKind) return false;
    if (activeCategory && entry.category !== activeCategory) return false;
    if (searchQuery) {
      const hay = [entry.name, entry.author, entry.description,
        entry.publisher && entry.publisher.handle, ...(entry.tags || [])].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    return true;
  }

  async function render(body, filterKind, force) {
    // A re-render (↻) replaces every card — release the old ones from the
    // preview observer or refreshed grids pile up detached nodes + bg code.
    if (previewObserver) { previewObserver.disconnect(); previewObserver = null; }
    body.replaceChildren(el('div', 'cgal-status', t('gallery_loading', 'Loading the gallery…')));
    const out = await api('/api/community/catalog' + (force ? '?refresh=1' : ''));
    if (!overlayEl) return;   // closed while loading
    if (!out || !out.ok) {
      body.replaceChildren(el('div', 'cgal-status', t('gallery_error', 'Could not load the gallery. Check your connection and retry.')));
      return;
    }
    const all = Array.isArray(out.entries) ? out.entries : [];
    if (filterKind) activeKind = filterKind;
    const frag = document.createDocumentFragment();

    // Browse toolbar: search + kind chips + category chips (built from what the
    // catalog actually contains, so empty filters never show).
    const bar = el('div', 'cgal-toolbar');
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'settings-input cgal-search';
    search.placeholder = t('gallery_search_ph', 'Search name, author, #tag…');
    search.value = searchQuery;
    let searchTimer = null;
    search.addEventListener('input', () => {
      searchQuery = search.value.trim().toLowerCase();
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => paintGrid(), 150);
    });
    bar.appendChild(search);
    const chipRow = (values, getActive, setActive, labelFor) => {
      const rowEl = el('div', 'cgal-chips');
      values.forEach((v) => {
        const chip = el('button', 'cgal-chip' + (getActive() === v ? ' active' : ''), labelFor(v));
        chip.type = 'button';
        chip.addEventListener('click', () => {
          setActive(getActive() === v ? '' : v);
          rowEl.querySelectorAll('.cgal-chip').forEach((c) => c.classList.remove('active'));
          if (getActive() === v) chip.classList.add('active');
          paintGrid();
        });
        rowEl.appendChild(chip);
      });
      return rowEl;
    };
    const kinds = Array.from(new Set(all.map((e) => e.kind)));
    if (kinds.length > 1) bar.appendChild(chipRow(kinds, () => activeKind, (v) => { activeKind = v; }, kindLabel));
    const cats = Array.from(new Set(all.map((e) => e.category).filter(Boolean)));
    if (cats.length) bar.appendChild(chipRow(cats, () => activeCategory, (v) => { activeCategory = v; }, (c) => t('gallery_cat_' + c.replace('-', '_'), c)));
    frag.appendChild(bar);

    // "Updates available" section for installed packages.
    const updates = await findUpdates(all);
    if (!overlayEl) return;
    if (updates.length) {
      frag.appendChild(el('div', 'cgal-section-head', '⬆ ' + t('gallery_updates', 'Updates for your widgets')));
      const ugrid = el('div', 'cgal-grid');
      updates.forEach((entry) => ugrid.appendChild(renderCard(entry)));
      frag.appendChild(ugrid);
      frag.appendChild(el('div', 'cgal-section-head', t('gallery_browse', 'Browse')));
    }

    const gridHost = el('div', 'cgal-gridhost');
    frag.appendChild(gridHost);
    const stale = out.stale ? el('div', 'cgal-status cgal-stale', t('gallery_stale', 'Offline — showing the last saved copy.')) : null;
    if (stale) frag.appendChild(stale);

    function paintGrid() {
      if (previewObserver) { previewObserver.disconnect(); previewObserver = null; }
      const entries = all.filter(matchesBrowse);
      if (!entries.length) {
        gridHost.replaceChildren(el('div', 'cgal-status', t('gallery_empty', 'Nothing here yet — new community creations will appear as they are published.')));
        return;
      }
      const grid = el('div', 'cgal-grid');
      entries.forEach((entry) => grid.appendChild(renderCard(entry)));
      gridHost.replaceChildren(grid);
    }
    body.replaceChildren(frag);
    paintGrid();
  }

  function open(filterKind) {
    close();
    searchQuery = ''; activeKind = ''; activeCategory = '';
    const bd = el('div', 'preset-modal-overlay');
    const modal = el('div', 'preset-modal cgal-modal');
    const head = el('div', 'preset-modal-head');
    head.appendChild(el('h3', 'preset-modal-title', t('gallery_title', 'Discover — community gallery')));
    const controls = el('div', 'cgal-head-actions');
    const refresh = el('button', 'preset-modal-close', '↻');
    refresh.type = 'button';
    refresh.title = t('gallery_refresh', 'Refresh');
    const x = el('button', 'preset-modal-close', '✕');
    x.type = 'button';
    x.addEventListener('click', close);
    controls.appendChild(refresh); controls.appendChild(x);
    head.appendChild(controls);
    modal.appendChild(head);
    modal.appendChild(el('p', 'preset-modal-desc', t('gallery_lead', 'Themes, backgrounds, widgets, scenes and packages shared by the community. Importing always shows you what is inside before anything is applied.')));
    const body = el('div', 'cgal-body');
    modal.appendChild(body);
    bd.appendChild(modal);
    bd.addEventListener('click', (ev) => { if (ev.target === bd) close(); });
    refresh.addEventListener('click', () => render(body, filterKind, true));
    document.body.appendChild(bd);
    overlayEl = bd;
    render(body, filterKind, false);
  }

  window.CommunityGallery = { open, close, findUpdates };
})();
