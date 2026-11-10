'use strict';
// Community gallery ("Store") — browse artifacts published on the project
// site and install them through the NORMAL import pipeline.
//
// The catalog arrives via GET /api/community/catalog (server-normalized, TTL
// cached — see server/community-catalog.js). Every field is still treated as
// untrusted text here (textContent only), and tapping Import NEVER applies
// anything: it feeds the entry's share code into PresetShare.openImport, so
// the user gets the exact same per-kind preview/permission dialogs as a
// hand-pasted code. Live previews exist only for 'bg' entries and run inside
// the same sandboxed iframe the import preview uses (CustomBg.buildSrcdoc),
// created lazily while the card is on screen and torn down when it leaves.
//
// The presentation is a storefront at full screen: a rail of views on the left,
// a spotlight and shelves on the right, and one page per entry. Every install
// still funnels through the one import boundary. Only the STATIC icon markup
// below is ever assigned via innerHTML; all catalog-supplied text stays textContent.
(function () {
  const t = (k, fb) => {
    const v = (typeof window.t === 'function') ? window.t(k) : k;
    return (v === k && fb != null) ? fb : v;
  };
  const el = makeEl; // shared DOM factory from utils.js
  const MAKER_URL = 'https://xenon-app.com/maker/';
  // Descriptions are a small Markdown subset (shared/src/rich-text.js): the
  // detail view formats it, clamped cards and the hero show it as plain text.
  // Without the shared module the raw text shows, as before.
  const richText = () => window.Xenon && window.Xenon.richText;
  const descPlain = (s) => { const rt = richText(); return rt ? rt.plain(s) : s; };
  function descInto(node, s) {
    const rt = richText();
    if (rt) node.appendChild(rt.render(document, s)); else node.textContent = s;
    return node;
  }
  const BMC_URL = 'https://www.buymeacoffee.com/marcimastro98';
  // Monthly membership page, counted per surface through the hub (see
  // supportUrl in @xenon/core); the plain page if the shared module is missing.
  function supportHref(source) {
    const c = window.Xenon && window.Xenon.constants;
    return (c && typeof c.supportUrl === 'function') ? c.supportUrl(source) : BMC_URL + '/membership';
  }
  const HUB_BASE = 'https://xenon-supporter-hub.xenonedge.workers.dev';
  // Default reservation target for limited-edition drops (the project Discord
  // invite). A drop may override it via limited.reserveUrl, but only a Discord
  // https URL survives — re-checked here even though the server already
  // allowlisted it, so a bad value can never reach an href.
  const DISCORD_URL = 'https://discord.gg/MBVrw9kZyg';
  // Where supporters send their email/donation screenshot to be registered and
  // receive their personal access code (rendered only as a mailto: link).
  const SUPPORT_EMAIL = 'support@xenon-app.com';
  // The drop's OWN Discord destination, '' when the entry sets none. The generic
  // server invite is only an acceptable last resort for a Discord-only drop: put
  // next to a working "Claim your copy" it lands you on the welcome channel with
  // nothing about the drop in sight, which reads as a broken button.
  function reserveUrlFor(entry) {
    const u = entry && entry.limited && entry.limited.reserveUrl;
    if (typeof u === 'string') {
      try {
        const p = new URL(u);
        const h = p.hostname.toLowerCase();
        if (p.protocol === 'https:' && (h === 'discord.gg' || h === 'discord.com' || h === 'www.discord.com')) return p.toString();
      } catch (e) { /* not a usable Discord link */ }
    }
    return '';
  }

  // A drop the hub has CLOSED (`active:false` in the live status) is not sold
  // out: the copies are still on the counter — freed serials handed back after a
  // revocation, a drop paused mid-run — but the claim page turns everyone away.
  // The flag was already fetched and normalized and NOTHING here read it, so a
  // closed drop advertised "N of 50 left" next to a "Claim your copy" button
  // that could only ever fail. Unknown (no live status: the catalog fallback
  // carries no `active`) means OPEN, so a hub that stops sending the field can
  // never shutter the whole Store.
  const dropClosed = (entry) => !!(entry && entry.limited && entry.limited.active === false);
  // "No copy is coming out of this drop right now" — the one question every CTA
  // site below actually asks. Sold out and closed differ only in what we SAY.
  // Stock is DERIVED (limitedStock in utils.js), never read raw: `soldOut` and
  // `left` are added by the server proxy, so a catalog read that skipped it
  // showed a drop with every copy claimed as available — and printed
  // "undefined of 50 left" under it.
  const dropSoldOut = (entry) => { const s = entry && limitedStock(entry.limited); return !!s && s.soldOut; };
  // `!limitedStock(...)` is the third case: a limited entry whose numbers cannot
  // be read at all. It can only reach us from a catalog that skipped the server
  // proxy, and "no copy right now" is the honest answer — never a meter built on
  // nothing. It also means every meter site below can trust its stock object.
  const dropUnavailable = (entry) => !!(entry && entry.limited
    && (dropSoldOut(entry) || dropClosed(entry) || !limitedStock(entry.limited)));
  function unavailableLabel(entry) {
    return el('span', 'cgal-soldout', dropSoldOut(entry)
      ? t('gallery_limited_soldout', 'Sold out')
      : t('gallery_limited_closed', 'Claims closed'));
  }

  // "I have a code" opens the import dialog. It answers a question the drop's
  // own state cannot: whether YOU hold a code, which stays true after the last
  // copy is gone. The hub agrees — an item code is perpetual and gated only by
  // its 3-install cap, and a supporter code is grandfathered onto an entry it
  // has already unlocked — so a user who changes machine is still entitled and
  // needs somewhere to type it. This used to sit inside the claim buttons, so
  // it vanished at exactly the moment it became the only thing that helps.
  function haveCodeButton(cls) {
    const have = el('button', cls || 'cgal-btn cgal-havecode');
    have.type = 'button';
    have.appendChild(icon('lock'));
    have.appendChild(el('span', null, t('gallery_have_code', 'I have a code')));
    // Deliberately the EMPTY import dialog, not importButton's fetch-the-bundle
    // path: a limited copy is a personal, numbered file delivered by DM or on
    // the claim page and is never in the catalog, so there is nothing for us to
    // prefill. The user pastes their own copy and their own code.
    have.addEventListener('click', () => {
      if (window.PresetShare && window.PresetShare.openImport) window.PresetShare.openImport();
    });
    return have;
  }

  // The CTA of a limited drop nobody can claim any more: say so, and keep the
  // way back in for whoever already owns a copy.
  function appendUnavailable(parent, entry) {
    const group = el('div', 'cgal-limited-buttons');
    group.appendChild(unavailableLabel(entry));
    group.appendChild(haveCodeButton());
    parent.appendChild(group);
  }

  function directClaimUrlFor(entry) {
    const limited = entry && entry.limited;
    if (!limited || limited.fulfillment !== 'hub' || limited.channels !== 'both') return '';
    if (dropClosed(entry)) return '';
    if (typeof limited.dropId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,60}$/.test(limited.dropId)) return '';
    return HUB_BASE + '/limited/claim/' + encodeURIComponent(limited.dropId) + '?source=web';
  }

  function appendLimitedButtons(parent, entry) {
    const group = el('div', 'cgal-limited-buttons');
    const claimUrl = directClaimUrlFor(entry);
    if (claimUrl) {
      const claim = document.createElement('a');
      claim.className = 'cgal-btn cgal-claim'; claim.href = claimUrl;
      claim.target = '_blank'; claim.rel = 'noopener noreferrer';
      claim.appendChild(icon('limited'));
      claim.appendChild(el('span', null, t('gallery_claim_copy', 'Claim your copy')));
      group.appendChild(claim);
    }
    const reserve = reserveUrlFor(entry);
    if (reserve || !claimUrl) {
      const discord = document.createElement('a');
      discord.className = 'cgal-btn cgal-discord'; discord.href = reserve || DISCORD_URL;
      discord.target = '_blank'; discord.rel = 'noopener noreferrer';
      discord.appendChild(icon('discord'));
      discord.appendChild(el('span', null, t('gallery_reserve', 'Open Discord')));
      group.appendChild(discord);
    }
    // A claimed copy arrives as a personal file plus a personal code, by DM and
    // on the claim page — never through the catalog, because each copy is its
    // own numbered artifact. So the Store, which is where you go looking, had
    // nowhere to put the code you were just given: the import dialog was reachable
    // only from Settings, and only if you knew it was the right one. This opens it
    // directly. It stays visible after claiming (the card cannot know you claimed)
    // and that is the point — it is the way back in.
    // Shown for every limited drop, not only the ones with a claim page: a copy
    // handed over on Discord comes with the same personal code, so gating this
    // on `claimUrl` hid the way back in from exactly the drops that are
    // fulfilled by hand.
    // The owner of an older copy gets an update here. A limited copy has no public
    // file, so the hub is asked as the owner of THIS install (no code to retype);
    // when it does not know this install the user is told how to bring the file in.
    if (entryInstallState(entry) === 'update') {
      const owner = ownedTargetFor(entry);
      const upd = el('button', 'cgal-btn is-update'); upd.type = 'button';
      upd.appendChild(icon('update'));
      upd.appendChild(el('span', null, t('gallery_update', 'Update…')));
      upd.addEventListener('click', async () => {
        if (!owner || !window.PresetShare || !PresetShare.updateOwned) return;
        upd.disabled = true;
        await PresetShare.updateOwned('', { source: 'catalog', sourceId: owner.entryId, sourceVersion: entry.version || '', perfWarning: entry.perfWarning === true, official: isOfficial(entry), owner });
        upd.disabled = false;
      });
      group.appendChild(upd);
    }
    group.appendChild(haveCodeButton());
    parent.appendChild(group);
  }

  async function hydrateLimitedStatus(entries) {
    const automatic = (entries || []).filter((entry) => entry && entry.limited && entry.limited.fulfillment === 'hub');
    const ids = [...new Set(automatic.map((entry) => entry.limited.dropId).filter(Boolean))];
    if (!ids.length) return;
    try {
      const out = await api('/api/community/limited-status?ids=' + encodeURIComponent(ids.join(',')));
      if (!out || !out.ok || !out.drops) return;
      automatic.forEach((entry) => {
        const live = out.drops[entry.limited.dropId];
        if (live) Object.assign(entry.limited, live);
      });
    } catch (e) { /* catalog fallback counters remain usable offline */ }
  }

  const api = apiJson; // shared fetch-JSON helper from utils.js

  let overlayEl = null;
  let infoEl = null;            // the "how it works" sheet over the Store
  let mainEl = null;            // the scrolling side of the Store
  let viewEl = null;            // what the rail chose: home, a list, Installed, Sparks
  let pageEl = null;            // one entry's page, shown in place of the view
  let detailEntry = null;       // the entry on that page
  let detailCta = null;         // its keys, redrawn when an install lands
  let viewScroll = 0;           // where the view was when the page opened
  let rail = null;              // { list, own, search } while the Store is open
  let catalogAll = [];          // the entries of the last load
  let zoomEl = null;            // fullscreen screenshot zoom (over everything)
  let previewObserver = null;   // IntersectionObserver for lazy bg previews
  // Screenshot sidecars are served from a Cloudflare R2 bucket (assets.xenon-app.com)
  // so binary blobs don't bloat the site repo; the URL is still derived from the
  // (charset-pinned) entry id — never from catalog-supplied text. A missing shot
  // 404s cleanly, so the webp→png→generated-canvas fallback in buildMedia/buildGallery
  // is unchanged. Publishing a drop now uploads shots to R2 instead of committing them.
  const SHOTS_BASE = 'https://assets.xenon-app.com/community/shots/';
  // Kind display order for the grouped ("browse all") view.
  const KIND_ORDER = ['widget', 'bundle', 'theme', 'bg', 'ambient', 'deck', 'page', 'icons', 'sounds', 'topbar'];
  // Set at review on what is handy on the screen by itself, not only in a dashboard.
  const ON_SCREEN_TAG = 'on-screen';
  const PAGE = 24;             // load-more page size for lists
  const SHELF_MAX = 12;        // cards on a shelf before "See all"
  const SEE_ALL_FROM = 5;      // fewer than this fit on the shelf itself
  const WIDE_SHOT = 2.1;       // a picture wider than this cannot be shown whole on a card
  // Most of the catalog's pictures are the whole of a wide screen and a card shows less
  // than half of one. A look fills the screen around its middle; a widget or a pack
  // starts on the left, where its name and its numbers are.
  const CENTRED_KINDS = new Set(['theme', 'bg', 'ambient']);
  const HERO_CONTRAST = 4.5;   // the pack's own paper and ink, when they can be read
  const JUST_ADDED_MAX = 8;    // default cap for the "Just added" block
  const KIND_SHELF_MIN = 3;    // a kind with fewer shares the "More" shelf
  const INSTALLS_WAIT_MS = 500; // how long a first paint waits for the install counts

  /* ── The storefront layout ────────────────────────────────────────────────
     Which sections the Store shows, in what order and in what shape. It is
     DATA, chosen in the hub admin and carried in the catalog next to `entries`,
     and the contract is the shared module (packages/core, loaded in index.html
     as shared/src/storefront-layout.js) — the same one the website catalog
     reads. Sharing it is the point: the two storefronts had already drifted
     once (spotlightPick was copied into both), and an order that lives in two
     hand-written lists diverges the first time only one of them is edited.

     Fail-safe twice over. The server normalizes what the catalog carries, and
     this normalizes again on arrival; either an absent or a malformed layout
     yields the default order rather than a blank Store. */
  function storefrontLayout(raw) {
    const sf = window.Xenon && window.Xenon.storefront;
    if (sf) return sf.normalizeLayout(raw);
    // The shared script is missing (the server/shared junction is created by
    // npm postinstall, so this means a broken install). The server normalizes
    // the layout too, so prefer what it sent; only when BOTH are unavailable
    // fall back to bare types, which is order and nothing else.
    const blocks = raw && Array.isArray(raw.blocks) ? raw.blocks : null;
    if (blocks && blocks.length) return blocks;
    return ['spotlight', 'limited', 'supporters', 'kinds', 'archive']
      .map((type) => ({ type, on: true, form: '', source: '', autoplayOver: 0, max: 0 }));
  }
  // Browse state (kept while the overlay is open).
  let searchQuery = '';
  let activeKind = '';
  let sortBy = 'feat';
  let shown = PAGE;
  let activeTab = 'browse';  // 'browse' (the catalog) | 'installed' (this machine) | 'sparks' (the Sparks shop)
  // Set to a repaint fn while the Store is open, cleared on close. Lets an install
  // committed elsewhere (preset-share.js) re-render the open Store so a card flips
  // to "Installed" — the finishing half of keeping the Store open across an
  // install (#1). Browse state (search/sort/filter) above survives the repaint.
  let repaintStore = null;
  // "New" tracking (#5): the per-device set of catalog entry ids this Store has
  // already shown (bounded; replaces the old last-visit timestamp, whose
  // day-granular addedAt comparison could never flag something uploaded later
  // on a day you had already browsed).
  const K_STORE_SEEN = 'xeneonedge.storeSeenIds';
  // Snapshot of the seen-id set taken when the Store OPENS (null = never
  // browsed): what this render calls "new". The persisted set is refreshed to
  // the full current catalog on every render, so newness clears exactly when
  // the user next opens the Store — and never before.
  let storeSeenPrev = null;
  function readSeenIds() {
    try {
      const arr = JSON.parse(localStorage.getItem(K_STORE_SEEN) || 'null');
      return Array.isArray(arr) ? new Set(arr.filter((s) => typeof s === 'string')) : null;
    } catch { return null; }
  }
  function markCatalogSeen(entries) {
    try {
      const cur = (entries || []).map((e) => e && e.id).filter(Boolean);
      const prev = readSeenIds();
      // Union (an entry inside a scheduling window must not re-flag when it
      // comes back), current ids last so the cap sheds the oldest strangers.
      const merged = [...new Set([...(prev ? [...prev] : []), ...cur])].slice(-1000);
      localStorage.setItem(K_STORE_SEEN, JSON.stringify(merged));
    } catch { /* storage off → no "new" tracking, badges just stay off */ }
  }
  // Points at the current render's paintGrid while the Store is open: lets the
  // async ratings / install-count loaders re-sort the grid once their data lands,
  // so "Top rated" / "Most downloaded" settle without the user re-picking the sort.
  let regrid = null;
  // Set while the Store is open: refreshes the red update-count badge on the
  // Installed tab when an install/update lands (so the number drops as you update).
  let refreshInstalledBadge = null;
  let stopCredits = null;     // leaves XenonCredits.onChange when the Store closes
  let searchTimer = null;
  let renderTurn = 0;         // a load that lost its turn draws nothing

  // ── Inline SVG icon set (STATIC, trusted markup — the ONLY innerHTML use). ──
  // Solid 24px glyphs, currentColor. The Installed tab draws from the same set.
  const solid = (d) => '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="' + d + '"/></svg>';
  const ICONS = {
    store: solid('M4 4h16l1 5a3 3 0 0 1-2 2.8V20H5v-8.2A3 3 0 0 1 3 9l1-5Zm5 16h6v-5H9v5Z'),
    home: solid('M12 3 3 10.5V21h6.5v-6h5v6H21V10.5L12 3Z'),
    theme: solid('M12 3a9 9 0 0 0 0 18c1.4 0 2.2-1 2.2-2.1 0-.6-.3-1-.6-1.4-.3-.4-.6-.8-.6-1.3 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4C21 6.4 17 3 12 3ZM7 12.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z'),
    bg: solid('M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm1 12.5V18h14v-3l-4-4-5 5-2-2-3 2.5ZM8.5 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z'),
    page: solid('M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm1 5v9h4V9H5Zm6 0v9h8V9h-8Z'),
    widget: solid('M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z'),
    deck: solid('M4 4h4.5v4.5H4V4Zm5.8 0h4.4v4.5H9.8V4Zm5.7 0H20v4.5h-4.5V4ZM4 9.8h4.5v4.4H4V9.8Zm5.8 0h4.4v4.4H9.8V9.8Zm5.7 0H20v4.4h-4.5V9.8ZM4 15.5h4.5V20H4v-4.5Zm5.8 0h4.4V20H9.8v-4.5Zm5.7 0H20V20h-4.5v-4.5Z'),
    ambient: solid('M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-7v2h3v2H8v-2h3v-2H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z'),
    bundle: solid('m12 2 9 5v10l-9 5-9-5V7l9-5Zm0 2.3L6 7.6l6 3.3 6-3.3-6-3.3ZM5 9.3v6.5l6 3.3v-6.5L5 9.3Zm14 0-6 3.3v6.5l6-3.3V9.3Z'),
    topbar: solid('M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm1 6v8h14v-8H5Z'),
    new: solid('m12 3 2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z'),
    limited: solid('M12 2.2l1.9 5.6a2 2 0 0 0 1.3 1.3l5.6 1.9-5.6 1.9a2 2 0 0 0-1.3 1.3L12 19.8l-1.9-5.6a2 2 0 0 0-1.3-1.3L3.2 11l5.6-1.9a2 2 0 0 0 1.3-1.3z'),
    supporters: solid('M12 20.4l-1.5-1.3C5.7 14.9 3 12.4 3 9.3A4.3 4.3 0 0 1 7.3 5c1.5 0 3 .8 3.7 2 .7-1.2 2.2-2 3.7-2A4.3 4.3 0 0 1 21 9.3c0 3.1-2.7 5.6-7.5 9.8z'),
    search: solid('M10.5 3a7.5 7.5 0 1 0 4.6 13.4l4.2 4.2 1.3-1.3-4.2-4.2A7.5 7.5 0 0 0 10.5 3Zm0 1.9a5.6 5.6 0 1 1 0 11.2 5.6 5.6 0 0 1 0-11.2Z'),
    check: solid('M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.5 8l-1.4-1.4L9.5 16.2Z'),
    update: solid('m12 3 5 5-1.4 1.4L13 6.8V15h-2V6.8L8.4 9.4 7 8l5-5ZM4 14h2v4h12v-4h2v6H4v-6Z'),
    refresh: solid('M12 4a8 8 0 1 0 7.7 10h-2.1A6 6 0 1 1 12 6c1.7 0 3.1.7 4.2 1.8L13 11h8V3l-3.4 3.4A8 8 0 0 0 12 4Z'),
    close: solid('m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z'),
    back: solid('M15.4 4.6 8 12l7.4 7.4 1.4-1.4-6-6 6-6-1.4-1.4Z'),
    next: solid('M8.6 4.6 16 12l-7.4 7.4L7.2 18l6-6-6-6 1.4-1.4Z'),
    expand: solid('M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z'),
    lock: solid('M12 2a5 5 0 0 1 5 5v3h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h1V7a5 5 0 0 1 5-5Zm3 8V7a3 3 0 0 0-6 0v3h6Z'),
    star: solid('m12 3 2.7 5.8 6.3.8-4.6 4.4 1.2 6.3L12 17.2l-5.6 3.1 1.2-6.3L3 9.6l6.3-.8L12 3Z'),
    discord: solid('M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-5 4v-4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z'),
  };
  function icon(name, cls) {
    const s = el('span', 'cgal-ic' + (cls ? ' ' + cls : ''));
    if (ICONS[name]) s.innerHTML = ICONS[name];   // static constant markup only
    return s;
  }
  function kindIcon(kind) { return icon(ICONS[kind] ? kind : 'widget'); }

  // Redraw generated canvas previews to the new size when the window resizes
  // (desktop browser) — the bitmap is fixed at draw time and would otherwise
  // stretch. Bound to the overlay lifecycle so nothing lingers after close.
  let resizeTimer = null;
  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!overlayEl) return;
      overlayEl.querySelectorAll('.cgal-media canvas').forEach((cv) => { if (cv._cgEntry) drawPreview(cv, cv._cgEntry); });
      syncRows();
    }, 150);
  }

  function close() {
    if (previewObserver) { previewObserver.disconnect(); previewObserver = null; }
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onStoreKey, true);
    closeZoom();
    closeInfo();
    if (stopCredits) { stopCredits(); stopCredits = null; }
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    mainEl = null; viewEl = null; pageEl = null; rail = null;
    detailEntry = null; detailCta = null;
    repaintStore = null;
    regrid = null;
    refreshInstalledBadge = null;
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('gallery', false);
    // The visit we just made advanced the marker, clearing (or shrinking) the
    // "new since last visit" set — update the Settings dot to match (#5).
    try { refreshStoreDot(); } catch { /* defined below; hoisted */ }
  }

  // Esc walks back one step: the sheet, the entry's page, then the Store. Taken in
  // the capture phase so nothing under the Store also reacts to it; whatever sits
  // above the Store (a dropdown, the zoom, a dialog) keeps its own Esc.
  function onStoreKey(e) {
    if (e.key !== 'Escape' || !overlayEl || zoomEl) return;
    if (document.querySelector('.cs-wrap.cs-open')) return;
    if (document.querySelectorAll('.preset-modal-overlay').length > 1) return;
    e.preventDefault(); e.stopPropagation();
    if (infoEl) closeInfo();
    else if (detailEntry) closeDetail();
    else close();
  }

  function kindLabel(kind) {
    return t('gallery_kind_' + kind, t('preset_kind_' + kind, kind));
  }
  // The rail names what a view holds, so in the plural.
  function railLabel(kind) { return t('gallery_rail_' + kind, kindLabel(kind)); }

  // ── Anonymous star ratings (proxied: /api/community/ratings|rate) ──────────
  // Aggregates load once per gallery render (batched ids, TTL-cached by the
  // local server) and paint into every .cgal-stars slot in the DOM. Averages
  // show only once an entry reaches the server's minimum vote count, so a
  // single vote can't dress up as consensus.
  let ratingsMap = {};
  let ratingsMin = 5;
  async function loadRatings(entries) {
    const ids = (entries || []).map((e) => e && e.id).filter(Boolean);
    if (!ids.length) return;
    for (let i = 0; i < ids.length; i += 100) {
      const out = await api('/api/community/ratings?ids=' + encodeURIComponent(ids.slice(i, i + 100).join(',')));
      if (!out || !out.ok || !out.ratings) continue;
      ratingsMin = Number(out.minDisplayCount) || ratingsMin;
      Object.assign(ratingsMap, out.ratings);
    }
    // Ordering by rating? The freshly-loaded scores change it — re-sort, then
    // refill the star/install slots the rebuilt cards expose.
    if (sortBy === 'rated' && typeof regrid === 'function') regrid();
    paintStars(); paintInstalls();
  }
  function starsText(r) {
    if (!r || !Number.isFinite(Number(r.avg)) || (Number(r.count) || 0) < ratingsMin) return '';
    return '★ ' + Number(r.avg).toFixed(1) + ' · ' + r.count;
  }
  // The card has room for the score alone; the page says how many voted.
  function starsShort(r) {
    return starsText(r) ? '★ ' + Number(r.avg).toFixed(1) : '';
  }
  function paintStars() {
    if (!overlayEl) return;
    overlayEl.querySelectorAll('.cgal-stars[data-id]').forEach((slot) => {
      const r = ratingsMap[slot.dataset.id];
      slot.textContent = slot.dataset.short ? starsShort(r) : starsText(r);
    });
  }

  // ── Install counts (proxied: /api/community/installs) ─────────────────────
  // Same shape as the ratings aggregates above: batched, TTL-cached by the local
  // server, painted into slots once they land.
  //
  // The number is what dashboards REPORTED, not how many people own the thing:
  // reporting is a setting, a reinstall counts again, and nothing identifies the
  // sender (that is the point — see server/community-installs.js). So it is
  // labelled "installs" and never "owners" or "downloads", and the tooltip says
  // what it actually counts. Below MIN_SHOWN it stays blank rather than telling a
  // creator their work has four installs, which is noise either way.
  const MIN_INSTALLS_SHOWN = 10;
  let installsMap = {};
  async function loadInstalls(entries) {
    const ids = (entries || []).map((e) => e && e.id).filter(Boolean);
    if (!ids.length) return;
    for (let i = 0; i < ids.length; i += 100) {
      const out = await api('/api/community/installs?ids=' + encodeURIComponent(ids.slice(i, i + 100).join(',')));
      if (!out || !out.ok || !out.counts) continue;
      Object.assign(installsMap, out.counts);
    }
    // Ordering by downloads? The freshly-loaded counts change it — re-sort, then
    // refill the install/star slots the rebuilt cards expose.
    if (sortBy === 'installs' && typeof regrid === 'function') regrid();
    paintInstalls(); paintStars();
  }
  // Compact and always at most 4 characters of number: "999", "1.2k", "34k",
  // "1.2M". Without the millions step a seven-figure count printed as "1000k".
  function compactCount(n) {
    if (n < 1000) return String(n);
    const unit = n < 1e6 ? { div: 1e3, suffix: 'k' } : { div: 1e6, suffix: 'M' };
    const v = n / unit.div;
    return (v < 10 ? v.toFixed(1) : String(Math.round(v))) + unit.suffix;
  }
  function installsText(id) {
    const n = Number(installsMap[id]) || 0;
    if (n < MIN_INSTALLS_SHOWN) return '';
    return '↓ ' + compactCount(n);
  }
  function paintInstalls() {
    if (!overlayEl) return;
    overlayEl.querySelectorAll('.cgal-installs[data-id]').forEach((slot) => {
      const text = installsText(slot.dataset.id);
      slot.textContent = text;
      slot.title = text
        ? t('gallery_installs_title', 'Installs reported by dashboards that count them. Not a number of owners.')
        : '';
    });
  }
  // The detail view's interactive vote row: current average + five tap targets.
  // Fetched with mine=1 (the local server attaches the install id) so the
  // user's own vote is highlighted; a tap posts and repaints optimistically.
  // The vote on this entry, as far as this PC can tell (server/rating-votes.js). The
  // average stays out of the way of someone about to vote.
  function ratingLine(state) {
    if (state.state === 'none') return t('gallery_rate_install');
    if (state.state === 'off') return t('gallery_rate_off');
    if (state.state === 'used') return t('gallery_rate_used');
    if (state.state === 'locked') return t('gallery_rate_locked');
    if (state.state === 'voted') {
      if (!state.stars) return t('gallery_rate_voted_any');
      return t(state.stars === 1 ? 'gallery_rate_voted_one' : 'gallery_rate_voted').replace('{n}', state.stars);
    }
    const days = Math.max(1, Math.ceil(((state.ripeAt || 0) - Date.now()) / (24 * 3600 * 1000)));
    return days === 1 ? t('gallery_rate_wait_one') : t('gallery_rate_wait').replace('{n}', days);
  }

  function ratingBoxInto(host, entry) {
    const box = el('div', 'cgal-rate');
    host.appendChild(box);
    const showScore = (extra) => {
      const row = el('div', 'cgal-rate-score');
      if (extra) row.appendChild(extra);
      const avg = starsText(ratingsMap[entry.id]);
      if (avg) row.appendChild(el('span', 'cgal-rate-avg', avg));
      if (row.firstChild) box.appendChild(row);
    };
    const draw = (state) => {
      box.replaceChildren();
      if (state.state === 'open') {
        window.XenonRatingCard.voter(box, {
          tr: t,
          vote: (stars, why) => api('/api/community/rate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entryId: entry.id, stars, why }),
          }),
          voted: async (stars) => {
            if (window.XenonToast) XenonToast.show({ type: 'success', title: t('rate_done'), important: true });
            const fresh = await api('/api/community/ratings?ids=' + encodeURIComponent(entry.id));
            if (fresh && fresh.ok && fresh.ratings) { Object.assign(ratingsMap, fresh.ratings); paintStars(); }
            draw({ state: 'voted', stars });
          },
          failed: (out) => {
            if (window.XenonToast) XenonToast.show({ type: 'error', title: t('gallery_rating_error'), important: true });
            load(out);
          },
        });
        return;
      }
      showScore(state.state === 'voted' && state.stars ? window.XenonRatingCard.given(state.stars) : null);
      box.appendChild(el('p', 'cgal-rate-say', ratingLine(state)));
    };
    const load = () => api('/api/community/rating-state?id=' + encodeURIComponent(entry.id))
      .then((state) => { if (state && state.ok) draw(state); })
      .catch(() => { /* offline: the card's average is still there */ });
    load();
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
              frame.srcdoc = CustomBg.buildSrcdoc(box._cgCode, box._cgAssets, box._cgFps);
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
    // Preview at the background's own frame cap, so the smoothness (and cost)
    // the user judges is what an install would actually run at.
    host._cgFps = env.data.fps;
    previewObserver.observe(host);
  }

  async function resolveCode(entry) {
    if (entry.code) return entry.code;
    const d = await api('/api/community/code?id=' + encodeURIComponent(entry.id));
    return (d && d.ok && typeof d.code === 'string') ? d.code : null;
  }

  // ── Generated preview (fallback when an entry ships no screenshot) ──────────
  // Colours come only from the server-validated preview swatches (hex), used as
  // canvas fills — so a card is never an empty box.
  // What the purchase sheet shows of an entry (js/buy-sheet.js checks it again).
  function saleCard(entry) {
    const shots = entry.shots || (entry.screenshot ? 1 : 0);
    const shot = (ext) => SHOTS_BASE + encodeURIComponent(entry.id) + '.' + ext;
    return { kind: kindLabel(entry.kind), line: descPlain(entry.description || ''), preview: entry.preview || null, art: shots > 0 ? [shot('webp'), shot('png')] : [] };
  }
  function catColors(entry) { const p = entry.preview || {}; return { a: p.accent || '#1ed760', b: p.bg || '#0a0f0d', t: p.text || '#e9f2ee' }; }
  function rgbaOf(c, al) { c = String(c || '#888').replace('#', ''); if (c.length === 3) c = c.split('').map((x) => x + x).join(''); if (c.length > 6) c = c.slice(0, 6); const n = parseInt(c, 16) || 0; return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + (al == null ? 1 : al) + ')'; }
  function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function drawPreview(canvas, entry) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 260, h = canvas.clientHeight || 146;
    if (!w || !h) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const g = canvas.getContext('2d'); if (!g) return; g.scale(dpr, dpr);
    const { a, b, t } = catColors(entry);
    g.fillStyle = b; g.fillRect(0, 0, w, h);
    const rg = g.createRadialGradient(w * 0.72, -h * 0.1, 0, w * 0.72, -h * 0.1, w * 0.9);
    rg.addColorStop(0, rgbaOf(a, 0.2)); rg.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = rg; g.fillRect(0, 0, w, h);
    const k = entry.kind;
    if (k === 'bg' || k === 'ambient') {
      for (let i = 0; i < 4; i++) { g.beginPath(); const y = h * (0.35 + i * 0.16); g.moveTo(0, y); for (let x = 0; x <= w; x += 12) g.lineTo(x, y + Math.sin(x * 0.03 + i * 1.3) * (10 - i * 1.5)); g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.fillStyle = rgbaOf(a, 0.12 + i * 0.05); g.fill(); }
      if (k === 'ambient') { g.fillStyle = rgbaOf(t, 0.9); g.font = '700 ' + Math.round(h * 0.26) + 'px monospace'; g.textAlign = 'center'; g.fillText('21:48', w / 2, h * 0.54); }
    } else if (k === 'widget') {
      const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.26;
      g.lineWidth = r * 0.28; g.strokeStyle = rgbaOf(t, 0.14); g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = a; g.lineCap = 'round'; g.beginPath(); g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 1.35); g.stroke();
      g.fillStyle = rgbaOf(t, 0.9); g.font = '800 ' + Math.round(r * 0.7) + 'px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('72', cx, cy + 1);
    } else if (k === 'deck') {
      const cols = 4, rows = 2, pad = w * 0.08, gap = w * 0.03, kw = (w - pad * 2 - gap * (cols - 1)) / cols, kh = kw * 0.86, oy = (h - (kh * rows + gap * (rows - 1))) / 2; let n = 0;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const x = pad + c * (kw + gap), y = oy + r * (kh + gap), lit = (n % 3 === 0); rr(g, x, y, kw, kh, 6); g.fillStyle = lit ? rgbaOf(a, 0.9) : rgbaOf(t, 0.08); g.fill(); g.fillStyle = lit ? rgbaOf(b, 0.85) : rgbaOf(t, 0.5); g.beginPath(); g.arc(x + kw / 2, y + kh / 2, kw * 0.16, 0, Math.PI * 2); g.fill(); n++; }
    } else { // theme / page / bundle → mini dashboard
      const pad = w * 0.07;
      rr(g, pad, h * 0.1, w - pad * 2, h * 0.11, 5); g.fillStyle = rgbaOf(t, 0.08); g.fill();
      rr(g, pad + 6, h * 0.13, w * 0.16, h * 0.05, 3); g.fillStyle = a; g.fill();
      const areaY = h * 0.26, areaH = h * 0.62, gap = w * 0.03, colW = (w - pad * 2 - gap) / 2;
      rr(g, pad, areaY, colW, areaH, 6); g.fillStyle = rgbaOf(t, 0.06); g.fill();
      rr(g, pad + colW * 0.12, areaY + areaH * 0.5, colW * 0.5, h * 0.04, 3); g.fillStyle = rgbaOf(a, 0.8); g.fill();
      rr(g, pad + colW * 0.12, areaY + areaH * 0.66, colW * 0.7, h * 0.03, 3); g.fillStyle = rgbaOf(t, 0.2); g.fill();
      rr(g, pad + colW + gap, areaY, colW, areaH * 0.46, 6); g.fillStyle = rgbaOf(t, 0.06); g.fill();
      rr(g, pad + colW + gap, areaY + areaH * 0.54, colW, areaH * 0.46, 6); g.fillStyle = rgbaOf(a, 0.14); g.fill();
      rr(g, pad + colW + gap + colW * 0.1, areaY + areaH * 0.68, colW * 0.55, h * 0.035, 3); g.fillStyle = rgbaOf(a, 0.85); g.fill();
      if (k === 'bundle') { const ky = h * 0.8, kw = w * 0.1; for (let i = 0; i < 5; i++) { rr(g, pad + i * (kw + w * 0.02), ky, kw, h * 0.11, 4); g.fillStyle = i % 2 ? a : rgbaOf(t, 0.1); g.fill(); } }
    }
  }

  // ── The picture of an entry (screenshot › live bg preview › generated canvas) ──
  // One picture, always filled. The rest of the shots are on the entry's page.
  function previewCanvas(entry) {
    const cv = document.createElement('canvas'); cv._cgEntry = entry;
    requestAnimationFrame(() => drawPreview(cv, entry));
    return cv;
  }
  function buildMedia(entry) {
    const media = el('div', 'cgal-media');
    // Server-validated hex: what shows behind a picture that does not fill the frame.
    if (entry.preview && entry.preview.bg) media.style.setProperty('--cst-sheet', entry.preview.bg);
    if (entry.shots || entry.screenshot) {
      const pic = document.createElement('img');
      pic.loading = 'lazy'; pic.alt = '';
      let triedPng = false;
      pic.addEventListener('error', () => {
        if (triedPng) { pic.replaceWith(previewCanvas(entry)); return; }
        triedPng = true; pic.src = shotUrl(entry.id, 1, 'png');
      });
      pic.addEventListener('load', () => {
        const wide = pic.naturalWidth / pic.naturalHeight > WIDE_SHOT;
        media.classList.toggle('is-wide', wide);
        media.classList.toggle('from-left', wide && !CENTRED_KINDS.has(entry.kind));
      });
      pic.src = shotUrl(entry.id, 1, 'webp');
      media.appendChild(pic);
    } else if (entry.kind === 'bg' && entry.code) {
      // Live animated bg preview (sandboxed iframe, lazily mounted on screen).
      const prev = el('div', 'cgal-preview');
      media.appendChild(prev);
      armPreview(prev, entry);
    } else {
      media.appendChild(previewCanvas(entry));
    }
    return media;
  }

  // A drop Xenon publishes itself: author "xenon", no outside publisher. Entries
  // reach the catalog through review. This changes the words of the install
  // dialog and nothing else: sandbox and permission approval stay.
  function isOfficial(entry) {
    const author = entry && typeof entry.author === 'string' ? entry.author.trim().toLowerCase() : '';
    return author === 'xenon' && !(entry.publisher && entry.publisher.handle);
  }

  // Publisher / author byline (publisher v2 wins; its link renders only because
  // the server already scheme+host-allowlisted it — github.com https).
  function bylineInto(host, entry) {
    host.appendChild(document.createTextNode(t('gallery_by', 'by') + ' '));
    if (entry.publisher && entry.publisher.handle) {
      if (entry.publisher.url) {
        const a = document.createElement('a');
        a.href = entry.publisher.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = '@' + entry.publisher.handle;
        host.appendChild(a);
      } else { host.appendChild(document.createTextNode('@' + entry.publisher.handle)); }
    } else { host.appendChild(document.createTextNode(entry.author || '—')); }
    if (entry.authorSupporter) { host.appendChild(document.createTextNode(' ')); const st = icon('star', 'cgal-authorstar'); st.title = t('gallery_supporter_badge', 'Xenon supporter'); host.appendChild(st); }
  }

  // The import button — normal + supporter (locked) both funnel through the one
  // import boundary. It also renders the install state: already installed and up
  // to date shows a settled "Installed" chip (no re-import — importing something
  // you already have only risks clobbering your tweaks); an older install turns
  // the CTA into "Update…", which is a normal re-import (full preview + permission
  // re-approval, and for a locked drop, re-unlock with the code).
  function importButton(entry, cls, label, iconName) {
    const state = entryInstallState(entry);
    if (state === 'current') {
      const chip = el('span', (cls ? cls + ' ' : '') + 'cgal-installed');
      chip.appendChild(icon('check'));
      chip.appendChild(el('span', null, t('gallery_installed', 'Installed')));
      return chip;
    }
    const isUpdate = state === 'update';
    const b = el('button', cls + (isUpdate ? ' is-update' : '')); b.type = 'button';
    const glyph = isUpdate ? 'update' : iconName;
    if (glyph) b.appendChild(icon(glyph));
    b.appendChild(el('span', null, isUpdate ? t('gallery_update', 'Update…') : label));
    if (entry.needsNewerApp) b.disabled = true;
    b.addEventListener('click', async () => {
      b.disabled = true;
      await startImport(entry, isUpdate);
      b.disabled = false;
    });
    return b;
  }

  // The one import path behind every Import / Unlock / Update control.
  async function startImport(entry, isUpdate) {
    const code = await resolveCode(entry);
    if (!code) {
      if (window.XenonToast) XenonToast.show({ type: 'error', title: t('gallery_error', 'Could not load this entry.') });
      return;
    }
    // #1 — keep the Store open BEHIND the import dialog so several things can be
    // installed in a row without reopening and losing your place. The import
    // modal shares the Store's .preset-modal-overlay class and is appended after
    // it, so it stacks on top; the Store has no Escape/backdrop handler that the
    // stacked dialog would trip, and it reappears when the dialog closes. On a
    // committed install, the 'xenon-content-installed' listener repaints it so
    // the card flips to "Installed".
    const owner = isUpdate && entry.locked === true ? ownedTargetFor(entry) : null;
    if (owner && window.PresetShare && PresetShare.updateOwned) {
      PresetShare.updateOwned(code, { source: 'catalog', sourceId: owner.entryId, sourceVersion: entry.version || '', perfWarning: entry.perfWarning === true, official: isOfficial(entry), owner });
      return;
    }
    if (window.PresetShare) PresetShare.openImport(code, { source: 'catalog', sourceId: entry.id, sourceVersion: entry.version || '', perfWarning: entry.perfWarning === true, official: isOfficial(entry), trialEligible: trialCovers(entry), supporterDrop: !entry.limited && !sparksOnly(entry) && (entry.locked === true || entry.supportersOnly === true), sparks: entry.limited ? 0 : (entry.sparks || 0), sparksOnly: sparksOnly(entry), sale: saleCard(entry), name: entry.name || '' });
  }

  // "Become a supporter": the way to the membership page for someone without a code.
  function becomeSupporterButton(cls, source) {
    const a = el('a', cls, t('gallery_supporters_join', 'Become a supporter'));
    a.href = supportHref(source || 'store-locked'); a.target = '_blank'; a.rel = 'noopener noreferrer';
    return a;
  }

  // The keys of a locked entry on its page: one green key, the rest quiet. For
  // someone who has not installed it the free week leads when the entry is in it,
  // then the membership, then the way in for people who already hold a code. Once
  // it IS installed the pitch steps back: nobody sells a membership to an owner.
  function appendLockedButtons(cta, entry) {
    // Sold only for Sparks: a membership does not open it, so there is nothing to join.
    if (sparksOnly(entry)) {
      cta.appendChild(importButton(entry, 'cst-key is-wide', unlockLabel(entry), 'lock'));
      return;
    }
    if (supporterSaved) {
      cta.appendChild(importButton(entry, 'cst-key is-wide', unlockLabel(entry, true), 'lock'));
      return;
    }
    if (entryInstallState(entry) !== 'none') {
      cta.appendChild(importButton(entry, 'cst-key is-wide', unlockLabel(entry, true), 'lock'));
      cta.appendChild(becomeSupporterButton('cst-plain'));
      return;
    }
    const trial = !trialUsed && trialCovers(entry);
    cta.appendChild(trial ? tryTrialButton('cst-key is-wide') : becomeSupporterButton('cst-key is-wide'));
    if (trial) cta.appendChild(becomeSupporterButton('cst-plain'));
    cta.appendChild(importButton(entry, 'cst-plain', unlockLabel(entry, true)));
  }

  // ── Fullscreen screenshot zoom (opened from the detail gallery) ─────────────
  function closeZoom() {
    if (!zoomEl) return;
    document.removeEventListener('keydown', zoomEl._onKey);
    zoomEl.remove(); zoomEl = null;
  }
  function openZoom(urls, startIdx) {
    if (!urls || !urls.length) return;
    closeZoom();
    let i = Math.max(0, Math.min(urls.length - 1, startIdx || 0));
    const z = el('div', 'cgal-zoom' + (urls.length < 2 ? ' single' : ''));
    const img = document.createElement('img'); img.className = 'cgal-zoom-img'; img.alt = '';
    const show = () => { img.src = urls[i] || ''; };
    const prev = el('button', 'cgal-zoom-arrow cgal-zoom-prev'); prev.type = 'button'; prev.appendChild(icon('back'));
    const next = el('button', 'cgal-zoom-arrow cgal-zoom-next'); next.type = 'button'; next.appendChild(icon('back'));
    const x = el('button', 'cgal-zoom-x'); x.type = 'button'; x.appendChild(icon('close'));
    prev.addEventListener('click', (e) => { e.stopPropagation(); i = (i - 1 + urls.length) % urls.length; show(); });
    next.addEventListener('click', (e) => { e.stopPropagation(); i = (i + 1) % urls.length; show(); });
    x.addEventListener('click', closeZoom);
    z.addEventListener('click', (e) => { if (e.target === z) closeZoom(); });
    z._onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeZoom(); }
      else if (e.key === 'ArrowLeft') { i = (i - 1 + urls.length) % urls.length; show(); }
      else if (e.key === 'ArrowRight') { i = (i + 1) % urls.length; show(); }
    };
    document.addEventListener('keydown', z._onKey);
    z.appendChild(x); z.appendChild(prev); z.appendChild(img); z.appendChild(next);
    show();
    document.body.appendChild(z); zoomEl = z;
  }

  // ── Large media gallery for the detail view (all shots, zoomable) ───────────
  // Screenshots become a swipeable stage with prev/next, a thumbnail rail and
  // click-to-zoom; a bg entry shows its live sandboxed preview; everything else
  // falls back to the generated canvas — so the stage is never an empty box.
  function buildGallery(entry) {
    const gal = el('div', 'cgal-gal');
    const stage = el('div', 'cgal-gal-stage');
    const shotCount = entry.shots || (entry.screenshot ? 1 : 0);
    const shotUrl = (i, ext) => SHOTS_BASE + encodeURIComponent(entry.id) + (i === 1 ? '' : '-' + i) + '.' + ext;
    if (shotCount > 0) {
      const track = el('div', 'cgal-gal-track');
      const thumbs = el('div', 'cgal-gal-thumbs');
      const count = el('div', 'cgal-gal-count', '1 / ' + shotCount);
      const resolved = [];       // best-known URL per slide (webp, or png after a fallback)
      let idx = 0;
      const goTo = (n) => {
        idx = (n + shotCount) % shotCount;
        track.style.transform = 'translateX(-' + (idx * 100) + '%)';
        thumbs.querySelectorAll('.cgal-gal-thumb').forEach((th, k) => th.classList.toggle('on', k === idx));
        count.textContent = (idx + 1) + ' / ' + shotCount;
      };
      for (let i = 1; i <= shotCount; i++) {
        const slot = i - 1;
        resolved[slot] = shotUrl(i, 'webp');
        const slide = el('div', 'cgal-gal-slide');
        const img = document.createElement('img'); img.loading = 'lazy'; img.alt = '';
        let triedPng = false;
        img.addEventListener('error', () => { if (!triedPng) { triedPng = true; resolved[slot] = shotUrl(i, 'png'); img.src = resolved[slot]; } });
        img.addEventListener('click', () => openZoom(resolved, slot));
        img.src = resolved[slot];
        slide.appendChild(img); track.appendChild(slide);
        const th = el('button', 'cgal-gal-thumb' + (i === 1 ? ' on' : '')); th.type = 'button';
        const tim = document.createElement('img'); tim.loading = 'lazy'; tim.alt = '';
        let tTriedPng = false;
        tim.addEventListener('error', () => { if (!tTriedPng) { tTriedPng = true; tim.src = shotUrl(i, 'png'); } });
        tim.src = shotUrl(i, 'webp');
        th.appendChild(tim); th.addEventListener('click', () => goTo(slot)); thumbs.appendChild(th);
      }
      stage.appendChild(track);
      const zoomBtn = el('button', 'cgal-gal-zoom'); zoomBtn.type = 'button'; zoomBtn.title = t('gallery_zoom', 'Zoom'); zoomBtn.appendChild(icon('expand'));
      zoomBtn.addEventListener('click', () => openZoom(resolved, idx));
      stage.appendChild(zoomBtn);
      if (shotCount > 1) {
        const prev = el('button', 'cgal-gal-arrow cgal-gal-prev'); prev.type = 'button'; prev.appendChild(icon('back'));
        const next = el('button', 'cgal-gal-arrow cgal-gal-next'); next.type = 'button'; next.appendChild(icon('back'));
        prev.addEventListener('click', () => goTo(idx - 1)); next.addEventListener('click', () => goTo(idx + 1));
        stage.appendChild(prev); stage.appendChild(next); stage.appendChild(count);
      }
      gal.appendChild(stage);
      if (shotCount > 1) gal.appendChild(thumbs);
      return gal;
    }
    if (entry.kind === 'bg' && entry.code && window.CustomBg && window.PresetShare) {
      const env = PresetShare.decodePreset(entry.code);
      if (env && env.kind === 'bg' && typeof env.data.code === 'string') {
        const frame = document.createElement('iframe');
        frame.className = 'cgal-gal-frame';
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        const assets = CustomBg.sanitizeBgAssets ? CustomBg.sanitizeBgAssets(env.data.assets) : null;
        frame.srcdoc = CustomBg.buildSrcdoc(env.data.code, assets, env.data.fps);
        stage.appendChild(frame);
        gal.appendChild(stage);
        return gal;
      }
    }
    const cv = document.createElement('canvas'); cv._cgEntry = entry;
    stage.appendChild(cv);
    requestAnimationFrame(() => drawPreview(cv, entry));
    gal.appendChild(stage);
    return gal;
  }

  // ── The entry's page: all its pictures, what it is, the keys ─────────────────
  // It takes the place of the view, inside the Store, and the rail stays. Back
  // returns to the same scroll. Same import boundary: the keys still funnel
  // through PresetShare.openImport.
  function openDetail(entry) {
    if (!overlayEl) return;
    closeInfo();
    if (!detailEntry) viewScroll = mainEl.scrollTop;
    detailEntry = entry;
    drawDetail(entry);
    viewEl.hidden = true; pageEl.hidden = false;
    mainEl.scrollTop = 0;
  }
  function closeDetail() {
    if (!detailEntry) return;
    detailEntry = null; detailCta = null;
    pageEl.hidden = true; pageEl.replaceChildren();
    viewEl.hidden = false;
    mainEl.scrollTop = viewScroll;
    syncRows();
  }

  function limitedMeter(entry) {
    const { total, left } = limitedStock(entry.limited);
    const meter = el('div', 'cst-meter');
    const bar = el('div', 'cst-meter-bar'); const fill = el('div', 'cst-meter-fill');
    fill.style.width = Math.round(((total - left) / total) * 100) + '%'; bar.appendChild(fill); meter.appendChild(bar);
    meter.appendChild(el('span', 'cst-meter-left', limitedLeftText(entry)));
    return meter;
  }
  function limitedLeftText(entry) {
    const { total, left } = limitedStock(entry.limited);
    return t('gallery_limited_left', '{n} of {t} left').replace('{n}', String(left)).replace('{t}', String(total));
  }

  // The keys of the page, on their own so an install can flip them in place.
  function drawDetailCta() {
    const entry = detailEntry;
    if (!entry || !detailCta) return;
    const cta = detailCta;
    cta.replaceChildren();
    if (entry.limited) {
      if (dropUnavailable(entry)) appendUnavailable(cta, entry);
      else { cta.appendChild(limitedMeter(entry)); appendLimitedButtons(cta, entry); }
    } else if (entry.locked || entry.supportersOnly) {
      appendLockedButtons(cta, entry);
    } else {
      cta.appendChild(importButton(entry, 'cst-key is-wide', t('gallery_import', 'Install')));
    }
    if (entry.needsNewerApp) cta.appendChild(el('span', 'cgal-needs', t('gallery_requires_version', 'Requires Xenon') + ' v' + entry.appVersionMin));
  }

  function detailFacts(entry) {
    const facts = el('dl', 'cst-facts');
    const fact = (label, value) => {
      const row = el('div', 'cst-fact');
      row.appendChild(el('dt', null, label)); row.appendChild(value);
      facts.appendChild(row);
    };
    if (entry.version) fact(t('gallery_fact_version', 'Version'), el('dd', null, entry.version));
    const installs = el('dd', 'cgal-installs', installsText(entry.id));
    installs.dataset.id = entry.id;
    fact(t('gallery_fact_installs', 'Installs'), installs);
    if (entry.category) fact(t('gallery_fact_category', 'Category'), el('dd', null, t('gallery_cat_' + entry.category.replace('-', '_'), entry.category)));
    return facts;
  }

  function detailWords(entry) {
    const words = el('div', 'cst-detail-words');
    words.appendChild(el('div', 'cst-kind', kindLabel(entry.kind)));
    words.appendChild(el('h1', 'cst-name', entry.name));
    const by = el('div', 'cst-by'); bylineInto(by, entry); words.appendChild(by);
    if (entry.limited) {
      const tier = el('div', 'cst-tier');
      tier.appendChild(icon('limited')); tier.appendChild(el('span', null, t('gallery_limited_badge', 'Limited')));
      words.appendChild(tier);
    } else if (entry.locked || entry.supportersOnly) {
      const tier = el('div', 'cst-tier');
      lockedTierInto(tier, entry, t('gallery_locked_badge', 'Supporters'), true);
      words.appendChild(tier);
      // The price where the decision is made: next to the key, for whoever would pay it.
      const price = !supporterSaved && !sparksOnly(entry) && entryInstallState(entry) === 'none' ? memberLine() : '';
      if (price) words.appendChild(el('p', 'cst-offer-line', price));
    }
    const until = untilLabel(entry); if (until) words.appendChild(until);
    detailCta = el('div', 'cgal-detail-cta');
    words.appendChild(detailCta);
    drawDetailCta();
    if (entry.description) words.appendChild(descInto(el('div', 'cgal-detail-desc'), entry.description));
    if (entry.perfWarning === true) {
      words.appendChild(el('p', 'cgal-detail-perfnote',
        t('gallery_perf_warning_long', 'This item runs heavier animations or frequent updates. On small devices it can use noticeable CPU or GPU.')));
    }
    // What the current version changed. Shown to everyone, but it earns its
    // place hardest for someone looking at an "Update…" button and deciding
    // whether a permission re-approval is worth it.
    if (entry.changelog) {
      const cl = el('div', 'cgal-detail-changelog');
      cl.appendChild(el('span', 'cgal-changelog-label',
        t('gallery_changelog', 'Novità in v{ver}').replace('{ver}', entry.version || '')));
      cl.appendChild(el('span', 'cgal-changelog-text', entry.changelog));
      words.appendChild(cl);
    }
    words.appendChild(detailFacts(entry));
    // The vote: who may give it is decided by the ticket on this PC, not here, so a
    // locked entry shows it to its owners and "install it first" to everyone else.
    ratingBoxInto(words, entry);
    return words;
  }

  function drawDetail(entry) {
    const page = el('div', 'cst-detail');
    const back = el('button', 'cst-back'); back.type = 'button';
    back.appendChild(icon('back')); back.appendChild(el('span', null, viewName()));
    back.addEventListener('click', closeDetail);
    page.appendChild(back);
    const grid = el('div', 'cst-detail-grid');
    if (entry.preview && hexRgb(entry.preview.bg)) grid.style.setProperty('--cst-paper', entry.preview.bg);
    grid.appendChild(buildGallery(entry));
    grid.appendChild(detailWords(entry));
    page.appendChild(grid);
    const more = el('div', 'cst-detail-more');
    page.appendChild(more);
    pageEl.replaceChildren(page);
    (catalogAll.length ? Promise.resolve(catalogAll) : catalogEntries()).then((all) => {
      if (detailEntry !== entry) return;
      const like = all.filter((e) => e && e.kind === entry.kind && e.id !== entry.id).slice(0, SHELF_MAX);
      if (like.length) more.appendChild(shelf(t('gallery_more_like', 'More like this'), like, { more: entry.kind }));
    }).catch(() => { /* offline: the page stands on its own */ });
  }

  // Supporters, for a PC with no code: real packs on top, what a month costs, what
  // it buys, one green key. A PC that keeps a code never sees it: it has the
  // membership, and the Supporters list is where it goes.
  function closeInfo() { if (infoEl) { infoEl.remove(); infoEl = null; } }
  function infoPictures() {
    const packs = catalogAll
      .filter((e) => !e.limited && !sparksOnly(e) && (e.locked || e.supportersOnly) && (e.shots || e.screenshot))
      .sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')))
      .slice(0, 3);
    if (!packs.length) return null;
    const strip = el('div', 'cst-info-shots');
    packs.forEach((e) => strip.appendChild(buildMedia(e)));
    return strip;
  }
  function openSupporterInfo() {
    if (!overlayEl || supporterSaved) return;
    closeInfo();
    const scrim = el('div', 'cgal-detail-scrim');
    const modal = el('div', 'cst-info');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'cst-info-name');
    const shots = infoPictures();
    if (shots) modal.appendChild(shots);
    const body = el('div', 'cst-info-body');
    const name = el('h2', 'cst-info-name', t('gallery_supporters_section', 'Supporters'));
    name.id = 'cst-info-name';
    body.appendChild(name);
    const line = memberLine();
    if (line) body.appendChild(el('p', 'cst-info-line', line));
    const ul = el('ul', 'cst-info-perks');
    // perk4 is the yearly tier's commissioned theme: it sits after perk3,
    // which sets up "more money buys more time", because the theme is the one
    // thing money buys that is not time. The code note stays last: it is
    // housekeeping, not a reason to support.
    // The Scintille come right after the drops: both are what a month buys.
    ['gallery_sup_perk1', 'support_perk_sparks', 'gallery_sup_perk2', 'gallery_sup_perk3', 'gallery_sup_perk4', 'gallery_sup_code_note'].forEach((k) => {
      const li = document.createElement('li');
      const sparks = k === 'support_perk_sparks' && window.XenonCredits;
      li.appendChild(sparks ? window.XenonCredits.offerMark() : icon('check', 'cst-info-tick'));
      li.appendChild(el('span', null, t(k, '')));
      ul.appendChild(li);
    });
    body.appendChild(ul);
    const keys = el('div', 'cst-info-keys');
    if (!trialUsed && window.TrialPass) {
      keys.appendChild(tryTrialButton('cst-key'));
      keys.appendChild(becomeSupporterButton('cst-plain', 'store-info'));
    } else keys.appendChild(becomeSupporterButton('cst-key', 'store-info'));
    keys.appendChild(haveCodeButton('cst-plain'));
    body.appendChild(keys);
    // Codes arrive by email (supporter hub); Discord and the mail stay as the
    // didn't-get-it fallback, with the address right there.
    const note = el('p', 'cst-info-note');
    const [before, ...after] = t('gallery_sup_register', 'Your personal code arrives by email right after you support. Didn’t get it? Reach us on Discord or at').split('Discord');
    note.appendChild(document.createTextNode(before));
    if (after.length) {
      const disc = el('a', null, 'Discord');
      disc.href = DISCORD_URL; disc.target = '_blank'; disc.rel = 'noopener noreferrer';
      note.appendChild(disc);
      note.appendChild(document.createTextNode(after.join('Discord')));
    }
    note.appendChild(document.createTextNode(' '));
    const mail = el('a', null, SUPPORT_EMAIL);
    mail.href = 'mailto:' + SUPPORT_EMAIL;
    note.appendChild(mail);
    body.appendChild(note);
    modal.appendChild(body);
    const x = el('button', 'cst-close');
    x.type = 'button'; x.title = t('gallery_close', 'Close'); x.setAttribute('aria-label', x.title);
    x.appendChild(icon('close'));
    x.addEventListener('click', closeInfo);
    modal.appendChild(x);
    scrim.appendChild(modal);
    scrim.addEventListener('click', (ev) => { if (ev.target === scrim) closeInfo(); });
    overlayEl.appendChild(scrim);
    infoEl = scrim;
    x.focus({ preventScroll: true });
  }

  // Open the entry's page from a card or the hero, unless the tap landed on an
  // actual control (the hero's key) — that acts directly.
  function wireCardOpen(node, entry) {
    node.classList.add('cgal-clickable');
    node.tabIndex = 0; node.setAttribute('role', 'button');
    node.addEventListener('click', (ev) => { if (ev.target.closest('a, button')) return; openDetail(entry); });
    node.addEventListener('keydown', (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === node) { ev.preventDefault(); openDetail(entry); } });
  }

  // ── The hero: one entry on its own paper ───────────────────────────────────
  // The pack's own colours, when the catalog's pair can be read. They come from the
  // server's hex check and only ever reach a CSS variable.
  function hexRgb(c) {
    let h = String(c || '').replace('#', '');
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    if (!/^[0-9a-f]{6}/i.test(h)) return null;
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function luminance(rgb) {
    const [r, g, b] = rgb.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function readablePair(preview) {
    const paper = hexRgb(preview && preview.bg), ink = hexRgb(preview && preview.text);
    if (!paper || !ink) return false;
    const [hi, lo] = [luminance(paper), luminance(ink)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05) >= HERO_CONTRAST;
  }
  const firstSentence = (text) => {
    const m = /^[\s\S]*?(?:[.!?](?:\s|$)|[。！？])/.exec(text);
    return (m ? m[0] : text).trim();
  };

  // One key: an entry that installs by itself installs from here, any other opens
  // its page, where the choices fit.
  function heroKey(entry) {
    if (!entry.limited && !entry.locked && !entry.supportersOnly) return importButton(entry, 'cst-hero-key', t('gallery_import', 'Install'));
    const b = el('button', 'cst-hero-key', t('gallery_open_item', 'See it'));
    b.type = 'button';
    b.addEventListener('click', () => openDetail(entry));
    return b;
  }

  function heroBanner(entry) {
    const hero = el('div', 'cst-hero');
    if (readablePair(entry.preview)) {
      hero.classList.add('is-paper');
      hero.style.setProperty('--cst-paper', entry.preview.bg);
      hero.style.setProperty('--cst-ink', entry.preview.text);
    }
    const words = el('div', 'cst-hero-words');
    words.appendChild(el('div', 'cst-hero-kind', kindLabel(entry.kind)));
    words.appendChild(el('h1', 'cst-name', entry.name));
    if (entry.description) words.appendChild(el('p', 'cst-hero-line', firstSentence(descPlain(entry.description))));
    const until = untilLabel(entry); if (until) words.appendChild(until);
    if (entry.limited && !dropUnavailable(entry)) words.appendChild(limitedMeter(entry));
    words.appendChild(heroKey(entry));
    hero.appendChild(words);
    hero.appendChild(buildMedia(entry));
    wireCardOpen(hero, entry);
    return hero;
  }

  // ── The spotlight: what leads the Store ─────────────────────────────────────
  // Chosen in the hub admin (entry.featured), not inferred from catalog order:
  // 'main' is the full-width hero, every other featured entry rides in the
  // column beside it, capped so the top of the Store stays one screenful.
  // Entries past the cap are not lost — they keep their normal place in the
  // sections below, exactly as if they had not been featured.
  const SPOT_SIDE_MAX = 3;
  function isFeatured(entry) { return !!entry && (entry.featured === 'main' || entry.featured === 'on'); }
  function spotlightPick(limitedList, supportersList, freePool) {
    const featured = sortList(limitedList.concat(supportersList, freePool).filter(isFeatured));
    if (featured.length) {
      // An explicit main wins outright, including a sold-out drop that the
      // automatic ladder below would refuse to lead with: putting it there is a
      // decision someone made while looking at its remaining copies.
      const main = featured.find((e) => e.featured === 'main') || featured[0];
      return { main, side: featured.filter((e) => e !== main).slice(0, SPOT_SIDE_MAX) };
    }
    // Nothing featured anywhere → the original automatic ladder, unchanged:
    //   1. an AVAILABLE limited drop → 2. a supporter/paid creation
    //   → 3. the featured free creation.
    // A sold-out limited never leads on its own (dead end) — it still shows in
    // its own Limited section below. "Entice, don't frustrate."
    const availLimited = sortList(limitedList).filter((e) => !dropUnavailable(e));
    const main = availLimited[0]
      || sortList(supportersList)[0]
      || (freePool.length ? sortList(freePool)[0] : (limitedList.length ? sortList(limitedList)[0] : null));
    return { main, side: [] };
  }

  // The hero and, beside it, the other featured entries as small cards. Alone it
  // keeps the whole width.
  function spotlightBlock(main, side) {
    const wrap = el('div', 'cst-spot' + (side.length ? '' : ' is-solo'));
    wrap.appendChild(heroBanner(main));
    if (side.length) {
      const col = el('div', 'cst-side');
      side.forEach((entry) => { const c = renderCard(entry); c.classList.add('cst-side-item'); col.appendChild(c); });
      wrap.appendChild(col);
    }
    return wrap;
  }

  // "New" = an entry id this device has never had on screen in the Store.
  // Deliberately id-based, NOT addedAt-vs-last-visit: addedAt is a plain date
  // (midnight), so anything published later on a day you had already browsed
  // could never flag — the empirically-hit "uploaded today, no badge anywhere"
  // hole. Nothing is flagged before the very first browse (no stored set), so
  // the grid never floods with badges the first time someone opens the Store (#5).
  function isNewEntry(entry) {
    return !!storeSeenPrev && !!entry && !!entry.id && !storeSeenPrev.has(entry.id);
  }

  // "Available until {d}" — the scheduling deadline on a supporter/limited
  // entry, the honest urgency line (the server already hides the entry once the
  // date passes; this just says so up front). Rendered in UTC on purpose:
  // activeUntil is authored as an end-of-day UTC stamp, and a local-time render
  // turns "31 July" into "1 August" for anyone east of Greenwich — same rule as
  // the website home. Null for free entries or without a deadline.
  function untilLabel(entry, cls) {
    if (!entry || !entry.activeUntil || !(entry.limited || entry.locked || entry.supportersOnly)) return null;
    const ts = Date.parse(entry.activeUntil);
    // An entry brought back by hand outlives its date: the line would no longer be true.
    if (!Number.isFinite(ts) || ts < Date.now()) return null;
    const l = t('locale', '');
    const loc = /^[a-z]{2}(-[A-Za-z0-9]{2,8})*$/.test(l) ? l : undefined;
    let d;
    try { d = new Date(ts).toLocaleDateString(loc, { day: 'numeric', month: 'long', timeZone: 'UTC' }); }
    catch { d = new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'long', timeZone: 'UTC' }); }
    return el('div', 'cgal-until' + (cls ? ' ' + cls : ''), t('gallery_until', 'Disponibile fino al {d}').replace('{d}', d));
  }

  // What an entry costs or where it stands, in a few words, for the card's line.
  function priceInto(node, entry, quiet) {
    const state = entryInstallState(entry);
    const says = (text) => { node.textContent = text; };
    if (state === 'current') return says(t('gallery_installed', 'Installed'));
    if (state === 'update') return says(t('gallery_update', 'Update…').replace(/\s*(…|\.\.\.)$/, ''));
    if (entry.needsNewerApp) return says(t('gallery_requires_version', 'Requires Xenon') + ' v' + entry.appVersionMin);
    if (entry.limited) {
      if (dropUnavailable(entry)) return says(dropSoldOut(entry) ? t('gallery_limited_soldout', 'Sold out') : t('gallery_limited_closed', 'Claims closed'));
      return says(limitedLeftText(entry));
    }
    if (sparksOnly(entry)) {
      if (window.XenonCredits) node.appendChild(window.XenonCredits.spark({ still: true }));
      node.appendChild(document.createTextNode(String(entry.sparks)));
      return undefined;
    }
    if (entry.locked || entry.supportersOnly) return quiet ? undefined : says(t('gallery_locked_badge', 'Supporters'));
    return says(t('gallery_price_free', 'Free'));
  }

  // One uniform card: the picture, the name, a line of kind and price. No key:
  // the whole card opens the entry's page, where the choice is made. `quiet` drops
  // the price word on a shelf where every card has the same one.
  function renderCard(entry, opts) {
    const card = el('div', 'cst-card' + (dropUnavailable(entry) || entry.needsNewerApp ? ' dim' : ''));
    wireCardOpen(card, entry);
    card.appendChild(buildMedia(entry));
    card.appendChild(el('div', 'cst-card-name', entry.name));
    const line = el('div', 'cst-card-line');
    const left = el('span', 'cst-card-kind');
    left.appendChild(el('span', null, kindLabel(entry.kind)));
    // Async-filled slot (paintStars): empty until the aggregates land, and stays
    // empty below the minimum vote count.
    const stars = el('span', 'cgal-stars', starsShort(ratingsMap[entry.id]));
    stars.dataset.id = entry.id; stars.dataset.short = '1';
    left.appendChild(stars);
    line.appendChild(left);
    const price = el('span', 'cst-card-price');
    priceInto(price, entry, opts && opts.quiet === true);
    line.appendChild(price);
    card.appendChild(line);
    return card;
  }

  // A supporter pack on the Discover page: its own paper and ink, the picture large,
  // the name large, one sentence. Same words a hero has, at a size that fits three
  // across, because these are what the membership opens.
  function renderPoster(entry) {
    const card = el('div', 'cst-poster' + (dropUnavailable(entry) || entry.needsNewerApp ? ' dim' : ''));
    if (readablePair(entry.preview)) {
      card.classList.add('is-paper');
      card.style.setProperty('--cst-paper', entry.preview.bg);
      card.style.setProperty('--cst-ink', entry.preview.text);
    }
    wireCardOpen(card, entry);
    card.appendChild(buildMedia(entry));
    const words = el('div', 'cst-poster-words');
    const line = el('div', 'cst-poster-line');
    line.appendChild(el('span', null, kindLabel(entry.kind)));
    const price = el('span', 'cst-card-price');
    priceInto(price, entry, true);
    if (!price.firstChild && entry.sparks > 0) {
      if (window.XenonCredits) price.appendChild(window.XenonCredits.spark({ still: true }));
      price.appendChild(document.createTextNode(String(entry.sparks)));
    }
    line.appendChild(price);
    words.appendChild(line);
    words.appendChild(el('h3', 'cst-poster-name', entry.name));
    if (entry.description) words.appendChild(el('p', 'cst-poster-text', firstSentence(descPlain(entry.description))));
    card.appendChild(words);
    return card;
  }

  // Available updates for INSTALLED catalog content. Two joins, one verdict:
  //   - SDK packages: entries whose pkgId matches an installed manifest with an
  //     older version (the original join);
  //   - every other kind (themes, decks, pages, icon/sound packs, bundles…):
  //     entries whose id matches a contentInstalls receipt recorded with an
  //     older sourceVersion (receipts carry {sourceId, sourceVersion} since
  //     v4.5.3 — older receipts lack the field and are fail-closed skipped).
  // Best-effort (empty when nothing installed / offline). THE single
  // update-join implementation — Settings' installed-packages manager and the
  // daily check consume it via window.CommunityGallery.findUpdates, so the
  // surfaces can never disagree about whether an update exists. Locked entries
  // are INCLUDED: the update is the import dialog, which unlocks with the saved
  // supporter pass when this PC has one and otherwise asks for the code and
  // saves it, exactly like a first install. "Update" is always a normal
  // re-import: full preview + permission re-approval by construction, never a
  // silent swap.
  // Versions and the owned-item join are ONE implementation, shared with the
  // server's count for the Xenon menu (packages/core/src/store-updates.js):
  // fail-closed on junk, the catalog stamp over the manifest, numbered copies
  // joined by their edition. Missing (a broken install), nothing reads as
  // installed or updatable, and the console says why.
  const storeUpdates = (window.Xenon && window.Xenon.storeUpdates) || null;
  if (!storeUpdates) console.warn('[store] shared/src/store-updates.js is missing: no install state or updates');
  const verLess = (a, b) => !!storeUpdates && storeUpdates.verLess(a, b);

  // What this machine has installed, joined two ways (same joins findUpdates
  // uses): SDK packages by pkgId, everything else by contentInstalls receipt id.
  // Cached per render() so card/detail buttons can read install state
  // synchronously; refreshed whenever the update join runs.
  let installIndex = null;   // { pkg: Map<pkgId,ver>, receipts: Map<entryId,ver> } | null
  // Does this PC keep a supporter code (Settings → Store, or saved from the
  // unlock dialog)? A boolean only: the code never leaves the server. With one
  // saved, the Store stops selling the membership to someone who has it: no
  // "Become a supporter", and one "Unlock" that uses the saved code. Whether the
  // code still works is only known at unlock, against a specific drop, so the
  // Store says the code is SAVED, never that it is valid.
  let supporterSaved = false;
  // True until the server says this install never used the pass trial, so the
  // "Try 7 days free" button never shows on a guess.
  let trialUsed = true;
  async function refreshSupporterSaved() {
    const [r, trial] = await Promise.all([api('/api/community/supporter'), api('/api/community/trial')]);
    supporterSaved = !!(r && r.saved);
    trialUsed = !(trial && trial.ok === true && trial.used === false);
  }
  const trialCovers = (entry) => !!(window.TrialPass && window.TrialPass.covers(entry));
  // Sold for Sparks with no supporter way in (the hub's "Sparks only").
  const sparksOnly = (entry) => !!entry && !entry.limited && entry.sparks > 0 && entry.supportersOnly !== true;
  // "150 Sparks", with the amount in US dollars where there is room (1 Spark = 1 US cent).
  function sparksPriceText(n, withUsd) {
    const words = t('gallery_sparks_price', '{n} Sparks').replace('{n}', String(n));
    return withUsd ? words + ' (' + (n / 100).toFixed(2) + ' USD)' : words;
  }
  // The supporter-tier mark; a Sparks-only drop shows its price instead.
  // A drop also sold for Sparks names that second way in next to the first.
  function lockedTierInto(node, entry, label, withUsd) {
    if (sparksOnly(entry) && window.XenonCredits) {
      node.appendChild(window.XenonCredits.offerMark());
      node.appendChild(el('span', null, sparksPriceText(entry.sparks, withUsd)));
      return;
    }
    node.appendChild(icon('supporters'));
    node.appendChild(el('span', null, label));
    if (!entry.limited && entry.sparks > 0) {
      node.appendChild(el('span', null, t('gallery_or_sparks', 'or {price}').replace('{price}', sparksPriceText(entry.sparks, withUsd))));
    }
  }
  function tryTrialButton(cls) {
    const b = el('button', cls);
    b.type = 'button';
    b.appendChild(el('span', null, t('trial_try_btn', 'Try 7 days free')));
    b.addEventListener('click', () => { if (window.TrialPass) window.TrialPass.openTry(); });
    return b;
  }
  // `wide` is the detail view's button, which has room to name the Sparks price.
  function unlockLabel(entry, wide) {
    if (entry && sparksOnly(entry)) return t('gallery_unlock_sparks', 'Unlock for {n} Sparks').replace('{n}', String(entry.sparks));
    if (supporterSaved) return t('gallery_unlock_saved', 'Unlock');
    if (wide && entry && !entry.limited && entry.sparks > 0) {
      return t('gallery_unlock_code_or_sparks', 'Unlock with a code or {price}').replace('{price}', sparksPriceText(entry.sparks));
    }
    return t('gallery_unlock', 'Unlock with a code');
  }
  async function refreshInstallIndex() {
    let packages = [];
    try { const inst = await api('/sdk/widgets'); packages = (inst && inst.packages) || []; }
    catch { /* SDK off / offline: the package join contributes nothing */ }
    // hubSettings is a shared-script-scope `let` from settings.js: bare name, and
    // guarded, since even typeof throws on it before settings.js has run.
    let installs = [];
    try {
      if (typeof hubSettings !== 'undefined' && hubSettings && Array.isArray(hubSettings.contentInstalls)) installs = hubSettings.contentInstalls;
    } catch { /* settings not loaded yet: the receipt join contributes nothing */ }
    installIndex = storeUpdates ? storeUpdates.buildIndex(packages, installs) : null;
    return installIndex;
  }

  // Install state of a single entry, read from the cached index (null → 'none',
  // the safe default that preserves the plain Import button). Unlike findUpdates,
  // this INCLUDES locked entries: a supporter drop you already unlocked should
  // read as installed too, and offer Update (re-unlock) only when a newer version
  // ships. 'none' = not installed · 'current' = installed & up to date ·
  // 'update' = installed at an older version than the catalog now lists.
  // The catalog stamp over the manifest (store-updates.js says why).
  const installedPkgVersion = (rec) => (storeUpdates ? storeUpdates.installedPkgVersion(rec) : null);

  // What to tell the hub when the owner of an installed entry asks for its update:
  // the id the hub knows this install by (a numbered copy is not the catalog id) and
  // the version that is installed. Null when nothing is installed.
  function ownedTargetFor(entry) {
    if (!entry || !installIndex) return null;
    let have = null;
    let entryId = entry.id;
    if (entry.pkgId && installIndex.pkg.has(entry.pkgId)) have = installedPkgVersion(installIndex.pkg.get(entry.pkgId));
    if (installIndex.receipts.has(entry.id)) { if (have == null) have = installIndex.receipts.get(entry.id); }
    else if (entry.limited && installIndex.dropCopyIds && installIndex.dropCopyIds.has(entry.id)) {
      entryId = installIndex.dropCopyIds.get(entry.id);
      if (have == null) have = installIndex.dropReceipts.get(entry.id);
    }
    return have == null ? null : { entryId, have: String(have || '') };
  }

  function entryInstallState(entry) {
    if (!entry || !installIndex) return 'none';
    let have = null;
    if (entry.pkgId && installIndex.pkg.has(entry.pkgId)) have = installedPkgVersion(installIndex.pkg.get(entry.pkgId));
    else if (installIndex.receipts.has(entry.id)) have = installIndex.receipts.get(entry.id);
    else if (entry.limited && installIndex.dropReceipts && installIndex.dropReceipts.has(entry.id)) have = installIndex.dropReceipts.get(entry.id);
    if (have == null) return 'none';
    if (entry.version && verLess(have, entry.version)) return 'update';
    return 'current';
  }

  async function findUpdates(entries) {
    const idx = await refreshInstallIndex();
    return idx ? storeUpdates.findUpdates(entries, idx) : [];
  }

  function matchesBrowse(entry) {
    if (searchQuery) {
      const hay = [entry.name, entry.author, entry.description,
        entry.publisher && entry.publisher.handle, ...(entry.tags || [])].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(searchQuery.replace(/^#/, ''))) return false;
    }
    return true;
  }
  // Rating score for the "Top rated" sort: the displayed average, or -1 when the
  // entry is unrated or still below the min vote count (so those sink to the
  // bottom instead of tying at 0 with genuinely low-rated ones).
  function ratedScore(e) {
    const r = e && ratingsMap[e.id];
    if (!r || (Number(r.count) || 0) < ratingsMin) return -1;
    return Number(r.avg) || 0;
  }
  function ratedCount(e) { const r = e && ratingsMap[e.id]; return (r && Number(r.count)) || 0; }
  function installCount(e) { return (e && Number(installsMap[e.id])) || 0; }
  function sortList(list) {
    if (sortBy === 'name') return list.slice().sort((a, b) => a.name.localeCompare(b.name));
    // 'new' reads the date, NOT the file position: sorting on `_i` descending
    // assumes new entries are appended at the BOTTOM of catalog.json, but they
    // go on top — so "Newest" listed the oldest first. ISO dates compare
    // correctly as strings; no addedAt sorts last, ties keep catalog order.
    if (sortBy === 'new') return list.slice().sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')) || ((a._i || 0) - (b._i || 0)));
    // Install counts and ratings load asynchronously AFTER the first paint, so at
    // that moment these order by whatever has arrived (often nothing) and ties fall
    // back to catalog order; loadInstalls/loadRatings re-run paintGrid once their
    // data lands, so the order settles without the user touching anything.
    if (sortBy === 'installs') return list.slice().sort((a, b) => (installCount(b) - installCount(a)) || ((a._i || 0) - (b._i || 0)));
    if (sortBy === 'rated') return list.slice().sort((a, b) => (ratedScore(b) - ratedScore(a)) || (ratedCount(b) - ratedCount(a)) || ((a._i || 0) - (b._i || 0)));
    return list.slice().sort((a, b) => (a._i || 0) - (b._i || 0));   // 'feat' = catalog order
  }

  // Shimmer skeleton so the first paint reads as a loading store, not a blank box.
  function skeleton(n) {
    const wrap = el('div', 'cst-grid');
    for (let i = 0; i < n; i++) {
      const c = el('div', 'cst-card cgal-skel');
      c.appendChild(el('div', 'cgal-media cgal-skel-media'));
      c.appendChild(el('div', 'cgal-skel-line w70'));
      c.appendChild(el('div', 'cgal-skel-line w40'));
      wrap.appendChild(c);
    }
    return wrap;
  }

  const catalogEntries = async () => {
    const out = await api('/api/community/catalog');
    return out && out.ok && Array.isArray(out.entries) ? out.entries : [];
  };

  // ── Shelves ────────────────────────────────────────────────────────────────
  // Previous and next keys appear only when the row has more than it shows.
  function shelfKeys(row) {
    const keys = el('div', 'cst-keys');
    const key = (name, dir) => {
      const b = el('button', 'cst-step'); b.type = 'button'; b.appendChild(icon(name));
      b.title = t(dir < 0 ? 'gallery_row_back' : 'gallery_row_next', dir < 0 ? 'Back' : 'Next');
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => {
        const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        row.scrollBy({ left: dir * row.clientWidth, behavior: calm ? 'auto' : 'smooth' });
      });
      keys.appendChild(b);
      return b;
    };
    const prev = key('back', -1), next = key('next', 1);
    row._cstSync = () => {
      const room = row.scrollWidth - row.clientWidth;
      keys.hidden = room <= 1;
      prev.disabled = row.scrollLeft <= 1;
      next.disabled = row.scrollLeft >= room - 1;
    };
    row.addEventListener('scroll', row._cstSync, { passive: true });
    requestAnimationFrame(row._cstSync);
    return keys;
  }
  function syncRows() {
    if (overlayEl) overlayEl.querySelectorAll('.cst-row').forEach((r) => { if (r._cstSync) r._cstSync(); });
  }

  // A named shelf. opts.more is the view "See all" leads to, opts.lead one line
  // under the name, opts.quiet a shelf that is history rather than stock, and
  // opts.grid the layout's form 'grid': every card at once, not a row. opts.card
  // draws each item instead of the plain card. opts.seeAll keeps the way to the
  // whole list on a short shelf that does not hold all of it.
  function shelf(titleText, items, opts) {
    const o = opts || {};
    const wrap = el('section', 'cst-shelf' + (o.history ? ' is-history' : ''));
    const draw = o.card || ((e) => renderCard(e, { quiet: o.quiet }));
    const head = el('div', 'cst-shelf-head');
    head.appendChild(el('h2', null, titleText));
    const row = el('div', o.grid ? 'cst-grid' : 'cst-row');
    items.forEach((e) => row.appendChild(draw(e)));
    if (!o.grid) head.appendChild(shelfKeys(row));
    if (o.more && (o.seeAll || items.length >= SEE_ALL_FROM)) {
      const all = el('button', 'cst-more', t('gallery_seeall', 'See all').replace(/\s*→\s*$/, ''));
      all.type = 'button';
      all.addEventListener('click', () => goView(o.more));
      head.appendChild(all);
    }
    wrap.appendChild(head);
    if (o.lead) wrap.appendChild(el('p', 'cst-shelf-lead', o.lead));
    wrap.appendChild(row);
    return wrap;
  }

  // What a month costs and buys, in one line.
  function memberLine() {
    const plan = window.SparksStore;
    if (!plan) return '';
    return t('gallery_band_line', '{usd} USD a month: every supporter pack, and {n} Sparks each month.')
      .replace('{usd}', String(plan.MEMBER_USD)).replace('{n}', String(plan.MONTHLY));
  }

  // The offer over the posters. A PC that keeps a code has the membership: it is told
  // so in one line, with nothing to buy.
  function supporterBand() {
    const band = el('div', 'cst-offer');
    if (supporterSaved) {
      band.appendChild(el('p', null, t('gallery_supporters_lead_saved', 'Themes and packs reserved for Xenon supporters. Your saved code unlocks them.')));
      return band;
    }
    const line = memberLine();
    if (line) band.appendChild(el('p', null, line));
    const keys = el('div', 'cst-band-keys');
    const how = el('button', 'cst-plain', t('gallery_sup_how', 'How it works'));
    how.type = 'button';
    how.addEventListener('click', openSupporterInfo);
    keys.appendChild(how);
    keys.appendChild(!trialUsed && window.TrialPass ? tryTrialButton('cst-key') : becomeSupporterButton('cst-key', 'store-section'));
    band.appendChild(keys);
    return band;
  }

  // Sparks beside the membership, a sheet of their own: the spark large, what they
  // do, what they cost. It leads to the Sparks view, the one place they are sold.
  function sparksBand() {
    const C = window.XenonCredits;
    if (!window.SparksStore || !C) return null;
    const band = el('button', 'cst-sparks-band');
    band.type = 'button';
    band.appendChild(C.offerMark());
    const words = el('span', 'cst-sparks-words');
    words.appendChild(el('b', null, t('xai_balance_unit', 'Sparks')));
    words.appendChild(el('span', null, t('sparks_shop_sub_bit', "Xenon's credits. With Sparks Bit makes widgets, themes and pages for you: you ask in words, Bit builds it.")));
    band.appendChild(words);
    const packs = el('span', 'cst-sparks-packs');
    C.PACKS.forEach((p) => {
      const pack = el('span', 'cst-sparks-pack');
      const amount = el('b');
      amount.appendChild(C.spark({ still: true }));
      amount.appendChild(document.createTextNode(C.format(p.credits)));
      pack.appendChild(amount);
      pack.appendChild(el('span', null, t('xai_pack_price', '{n} USD').replace('{n}', String(p.usd))));
      packs.appendChild(pack);
    });
    band.appendChild(packs);
    band.appendChild(el('span', 'cst-sparks-go', t('sparks_shop_open', 'See the packs')));
    band.addEventListener('click', () => goView('__sparks'));
    return band;
  }

  // A search that found nothing: what was typed can still become something. The words
  // go into Bit's box as a draft and wait there; only the person sends them, because
  // an answer spends Sparks.
  function askBitBlock() {
    const box = el('div', 'cst-ask');
    const plan = window.SparksStore;
    if (plan && window.BitApp) {
      const face = el('span', 'cst-ask-face');
      face.innerHTML = window.BitApp.icon('idle'); // the engine's own SVG, no catalog text
      box.appendChild(face);
    }
    box.appendChild(el('h3', null, t('gallery_no_results', 'No results')));
    if (!plan) return box;
    box.appendChild(el('p', null, t('gallery_ask_bit_line', 'Not in the Store? Bit can build it for you.')));
    const typed = overlayEl.querySelector('.cst-search');
    const words = typed ? typed.value.trim() : '';
    const ask = el('button', 'cst-key', t('gallery_ask_bit_key', 'Ask Bit'));
    ask.type = 'button';
    ask.addEventListener('click', () => plan.openBit(close, t('gallery_ask_bit_draft', 'Make me this: {q}').replace('{q}', () => words)));
    box.appendChild(ask);
    return box;
  }

  // What the current view is called: the head of a list, and Back on a page.
  function viewName() {
    if (activeTab === 'installed') return t('gallery_tab_installed', 'Installed');
    if (activeTab === 'sparks') return t('xai_balance_unit', 'Sparks');
    if (searchQuery) return t('gallery_results', 'Results');
    const names = {
      '': t('gallery_tab_browse', 'Discover'),
      __new: t('gallery_new_filter', 'New'),
      __added: t('gallery_justadded', 'Just added'),
      __screen: t('gallery_for_screen', 'For the screen'),
      __supporters: t('gallery_supporters_section', 'Supporters'),
      __limited: t('gallery_limited_section', 'Limited edition'),
    };
    return activeKind in names ? names[activeKind] : railLabel(activeKind);
  }

  // No catalog and no saved copy: what happened, and the one thing to do about it.
  function catalogFailed(body) {
    const block = el('div', 'cst-ask');
    block.appendChild(el('p', null, t('gallery_error', 'Could not load the gallery. Check your connection and retry.')));
    const retry = el('button', 'cst-key', t('gallery_retry', 'Try again'));
    retry.type = 'button';
    retry.addEventListener('click', () => render(body));
    block.appendChild(retry);
    return block;
  }

  async function render(body, force, keep) {
    const turn = ++renderTurn;
    // A re-render (↻) replaces every card — release the old ones from the
    // preview observer or refreshed grids pile up detached nodes + bg code.
    if (previewObserver) { previewObserver.disconnect(); previewObserver = null; }
    // #4 — don't flash to skeletons on a ↻ refresh or a repaint. The grid is already
    // on screen, so keep it visible through the fetch and swap it atomically for
    // the fresh one below. A cold open or a tab switch still shows the skeleton so
    // there is never a blank pause with nothing on screen.
    const keepOnScreen = (force === true || keep === true) && !!body.firstChild;
    if (!keepOnScreen) body.replaceChildren(skeleton(10));
    const [out] = await Promise.all([
      api('/api/community/catalog' + (force ? '?refresh=1' : '')),
      refreshSupporterSaved(),
    ]);
    if (!overlayEl || turn !== renderTurn) return;   // closed, or another view asked meanwhile
    if (!out || !out.ok) {
      // Keep the catalog that's already on screen on a failed ↻; only a cold open
      // with nothing to show falls back to the full error message (#7). The server
      // now disk-backs the catalog, so this path is reached only truly offline.
      if (!keepOnScreen) body.replaceChildren(catalogFailed(body));
      return;
    }
    const all = (Array.isArray(out.entries) ? out.entries : []).filter(Boolean);
    const LAYOUT = storefrontLayout(out.layout);
    await hydrateLimitedStatus(all);
    if (!overlayEl || turn !== renderTurn) return;
    all.forEach((e, i) => { e._i = i; });
    catalogAll = all;
    fillRail(all);
    // Everything now on screen counts as seen from the NEXT open onwards;
    // this render keeps flagging against the snapshot taken at open().
    markCatalogSeen(all);
    // Two special tiers get their own treatment; everything else is the browse set.
    const limited = all.filter((e) => e.limited);
    const supporters = all.filter((e) => !e.limited && (e.locked || e.supportersOnly));
    const browse = all.filter((e) => !e.limited && !(e.locked || e.supportersOnly));
    const forScreen = all.filter((e) => Array.isArray(e.tags) && e.tags.includes(ON_SCREEN_TAG));
    if (activeKind === '__screen' && !forScreen.length) activeKind = '';

    // Not drawn in Browse any more (see paintGrid): run for the install index the
    // card lines read, so an owned entry says Installed or Update.
    //
    // The shelves are ordered by what people really install, so a first open waits a
    // moment for the counts. A late answer only fills the numbers: what is already
    // on screen does not move.
    const counts = loadInstalls(all).catch(() => { /* offline: catalog order */ });
    const countsWait = Object.keys(installsMap).length ? null : Promise.race([counts, new Promise((go) => { setTimeout(go, INSTALLS_WAIT_MS); })]);
    await Promise.all([findUpdates(browse), countsWait]);
    if (!overlayEl || turn !== renderTurn) return;

    // The head of a list: its name, and how it is ordered. No category filter:
    // `category` says what a creation is ABOUT, `kind` says what it IS; the
    // category stays as a fact on the entry's page.
    const listHead = el('div', 'cst-listhead');
    const listTitle = el('h2', null);
    listHead.appendChild(listTitle);
    const sortWrap = el('div', 'cgal-select');
    const selSort = document.createElement('select'); selSort.className = 'cgal-select-el'; selSort.setAttribute('data-cs-fixed', '');
    [['feat', t('gallery_sort_feat', 'Featured')], ['new', t('gallery_sort_new', 'Newest')],
     ['installs', t('gallery_sort_installs', 'Most downloaded')], ['rated', t('gallery_sort_rated', 'Top rated')],
     ['name', t('gallery_sort_name', 'Name A–Z')]]
      .forEach(([v, label]) => { const o = document.createElement('option'); o.value = v; o.textContent = label; selSort.appendChild(o); });
    selSort.value = sortBy;
    selSort.addEventListener('change', () => { sortBy = selSort.value; paintGrid(); });
    sortWrap.appendChild(selSort); listHead.appendChild(sortWrap);
    if (window.initCustomSelect) initCustomSelect(selSort);

    const host = el('div', 'cst-host');
    const stale = out.stale ? el('div', 'cgal-status cgal-stale', t('gallery_stale', 'Offline: showing the last saved copy.')) : null;

    function flatInto(frag, list, emptyText, draw) {
      if (!list.length) { frag.appendChild(el('div', 'cgal-status', emptyText || t('gallery_empty', 'Nothing here yet: new community creations will appear as they are published.'))); return; }
      const grid = el('div', 'cst-grid');
      list.slice(0, shown).forEach((e) => grid.appendChild((draw || renderCard)(e)));
      if (draw) { const stage = el('div', 'cst-stage'); stage.appendChild(grid); frag.appendChild(stage); } else frag.appendChild(grid);
      if (list.length > shown) {
        const lm = el('div', 'cgal-loadmore');
        const b = el('button', 'cgal-btn cgal-loadmore-btn', t('gallery_loadmore', 'Show more ({n})').replace('{n}', String(list.length - shown))); b.type = 'button';
        b.addEventListener('click', () => { shown += PAGE; paintGrid(); });
        lm.appendChild(b); frag.appendChild(lm);
      }
    }
    const newestFirst = (list) => list.slice().sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));

    function paintList(frag) {
      if (searchQuery) {
        const found = sortList(all.filter(matchesBrowse));
        if (found.length) return flatInto(frag, found);
        frag.appendChild(askBitBlock());
        return undefined;
      }
      if (activeKind === '__limited') return flatInto(frag, sortList(limited), t('gallery_limited_empty', 'No limited drops right now: check back soon.'), renderPoster);
      if (activeKind === '__supporters') {
        const band = supporterBand(); if (band) frag.appendChild(band);
        flatInto(frag, sortList(supporters), undefined, renderPoster);
        const sparks = sparksBand(); if (sparks) frag.appendChild(sparks);
        return undefined;
      }
      if (activeKind === '__screen') return flatInto(frag, sortList(forScreen));
      if (activeKind === '__new') return flatInto(frag, newestFirst(all.filter(isNewEntry)));
      if (activeKind === '__added') return flatInto(frag, newestFirst(browse));
      return flatInto(frag, sortList(all.filter((e) => e.kind === activeKind)));
    }

    function paintHome(frag) {
      if (!all.length) { frag.appendChild(el('div', 'cgal-status', t('gallery_empty', 'Nothing here yet: new community creations will appear as they are published.'))); return undefined; }
      // What leads the Store: the admin's spotlight when the catalog sets one,
      // else the automatic ladder (see spotlightPick). Every shelf below skips
      // whatever the spotlight shows, as the website and the hub's layout
      // preview do: the same pack twice on one screen reads as filler. Only
      // the Novità shelf repeats cards by design.
      const spot = spotlightPick(limited, supporters, browse);
      const heroEntry = spot.main;
      const spotIds = new Set(spot.side.map((e) => e.id));
      if (heroEntry) spotIds.add(heroEntry.id);

      // Updates are not a shelf: they live on Installed, whose red count (and the
      // Store dot) says one is waiting, and whose Update all handles them in one go.
      //
      // "Novità": everything published since THIS user's last visit, newest
      // first, whatever its tier, minus what this machine already has (a thing
      // you installed is not news to you). It sits below the supporter shelf,
      // never above it: it is placed where the layout's `new` block is, or before
      // the kind shelves when that block is off. Distinct from the `new` block
      // itself, which is catalog recency and the same for everyone.
      const freshAll = newestFirst(all.filter(isNewEntry).filter((e) => entryInstallState(e) === 'none'));
      let freshDone = !freshAll.length;
      const putFresh = () => {
        if (freshDone) return;
        freshDone = true;
        frag.appendChild(shelf(t('gallery_new_filter', 'Novità'), freshAll.slice(0, SHELF_MAX), { more: '__new' }));
      };

      // How the limited tier divides between its own shelf and the Archive.
      // Shared with the website catalog and the hub admin (splitLimited): the
      // three cases had already drifted here, and 'auto-all' with the Archive on
      // rendered the same drop in BOTH sections. Whatever the split, turning the
      // Archive off can never put a drop out of reach. A drop the hub has CLOSED is
      // finished exactly like a sold-out one, so the predicate is dropUnavailable.
      const split = (window.Xenon && window.Xenon.storefront)
        ? window.Xenon.storefront.splitLimited(limited, LAYOUT, dropUnavailable)
        : { shelf: limited, archive: [] };
      const shelfLimited = sortList(split.shelf);
      const archive = sortList(split.archive);

      // ── ONE pass over the admin's order ────────────────────────────────────
      // Every block only decides whether it has anything to say; the order and
      // the shape are data. A block with an empty list renders nothing, so the
      // Store never shows an empty shelf just because it is enabled.
      const cap = (list, b) => (b.max > 0 ? list.slice(0, b.max) : list);
      const notSpot = (e) => !spotIds.has(e.id);
      // "Just added" is decided once, so the shelves by kind do not show the same cards
      // again right under it.
      const newBlock = LAYOUT.find((b) => b.on && b.type === 'new');
      const justAdded = newBlock ? newestFirst(browse.filter(notSpot)).slice(0, newBlock.max > 0 ? newBlock.max : JUST_ADDED_MAX) : [];
      const justAddedIds = new Set(justAdded.map((e) => e.id));
      const byInstalls = (list) => list.slice().sort((a, b) => (installCount(b) - installCount(a)) || (a._i - b._i));
      LAYOUT.forEach((b) => {
        if (!b.on) return;
        const grid = b.form === 'grid';
        if (b.type === 'spotlight') {
          if (heroEntry) frag.appendChild(spotlightBlock(heroEntry, spot.side));
        } else if (b.type === 'limited') {
          const items = cap(shelfLimited.filter(notSpot), b);
          if (items.length) {
            const stage = el('div', 'cst-stage');
            stage.appendChild(shelf(t('gallery_limited_section', 'Limited edition'), items, {
              grid, card: renderPoster, more: '__limited', lead: t('gallery_limited_lead_short', 'A fixed number of copies worldwide: reserved on Discord.'),
            }));
            frag.appendChild(stage);
          }
        } else if (b.type === 'supporters') {
          // Renders whenever the tier EXISTS, even with every entry up in the
          // spotlight: the offer under it is the whole way in.
          const items = cap(sortList(supporters.filter(notSpot)), b);
          if (!supporters.length) return;
          const stage = el('div', 'cst-stage');
          const offer = supporterBand();
          if (items.length) {
            const posters = shelf(t('gallery_supporters_section', 'Supporters'), items, { grid, card: renderPoster, more: '__supporters' });
            if (offer) posters.insertBefore(offer, posters.lastElementChild);
            stage.appendChild(posters);
          } else if (offer) stage.appendChild(offer);
          const sparks = sparksBand();
          if (sparks) stage.appendChild(sparks);
          frag.appendChild(stage);
        } else if (b.type === 'new') {
          putFresh();
          // "Just added": catalog recency, identical on every machine.
          if (justAdded.length) frag.appendChild(shelf(t('gallery_justadded', 'Just added'), justAdded, { more: '__added' }));
        } else if (b.type === 'archive') {
          const items = cap(archive.filter(notSpot), b);
          if (items.length) frag.appendChild(shelf(t('gallery_archive_section', 'Archive'), items, {
            grid, history: true, lead: t('gallery_archive_lead', 'Drops whose copies are all gone. They stay here so the work remains visible, and searchable.'),
          }));
        } else if (b.type === 'kinds') {
          putFresh();
          // A kind with one or two cards would leave most of its row empty: those share
          // one shelf, and the rail still has each kind on its own.
          const fewer = [];
          KIND_ORDER.forEach((k) => {
            const items = byInstalls(browse.filter((e) => e.kind === k && notSpot(e) && !justAddedIds.has(e.id)));
            if (items.length >= KIND_SHELF_MIN) frag.appendChild(shelf(railLabel(k), items.slice(0, SHELF_MAX), { more: k, seeAll: true }));
            else fewer.push(...items);
          });
          if (fewer.length) frag.appendChild(shelf(t('gallery_more_shelf', 'More'), fewer));
        }
      });
      putFresh();
      return undefined;
    }

    function paintGrid() {
      if (previewObserver) { previewObserver.disconnect(); previewObserver = null; }
      const frag = document.createDocumentFragment();
      const home = !activeKind && !searchQuery;
      listHead.hidden = home;
      listTitle.textContent = viewName();
      sortWrap.hidden = activeKind === '__new' || activeKind === '__added';
      if (selSort.value !== sortBy) { selSort.value = sortBy; if (selSort._csSync) selSort._csSync(); }
      if (home) paintHome(frag); else paintList(frag);
      host.replaceChildren(frag);
    }

    const shell = document.createDocumentFragment();
    shell.appendChild(listHead); if (stale) shell.appendChild(stale); shell.appendChild(host);
    body.replaceChildren(shell);
    regrid = paintGrid;   // async ratings/installs can re-sort this grid in place
    paintGrid();
    // Star aggregates: best-effort async fill (a hub hiccup just leaves the
    // slots empty — the gallery never waits on it). paintGrid rebuilds cards
    // from the already-loaded map, so one load per render is enough.
    loadRatings(all).catch(() => { /* offline — slots stay empty */ });
    counts.then(paintInstalls);
  }

  function paintTab(force, keep) {
    viewEl.classList.toggle('is-own', activeTab !== 'browse');
    if (activeTab === 'browse') return render(viewEl, force, keep);
    renderTurn += 1;
    regrid = null;
    // Leaving the catalog: drop the lazy bg-preview observer so the browse grid's
    // sandboxed preview frames stop running behind the view.
    if (previewObserver) { previewObserver.disconnect(); previewObserver = null; }
    if (activeTab === 'sparks') {
      return window.SparksStore.render(viewEl, { catalog: catalogEntries, renderCard, icon, supportHref, close });
    }
    if (window.InstalledManager) return InstalledManager.render(viewEl, force);
    viewEl.replaceChildren(el('div', 'cgal-status', t('gallery_error', 'Could not load the gallery. Check your connection and retry.')));
    return undefined;
  }

  // ── The rail: every view of the Store, always in sight ─────────────────────
  function syncRail() {
    if (!rail) return;
    const here = activeTab === 'installed' ? '__installed' : activeTab === 'sparks' ? '__sparks' : (searchQuery ? null : activeKind);
    overlayEl.querySelectorAll('.cst-railrow').forEach((row) => {
      const on = row.dataset.view === here;
      row.classList.toggle('on', on);
      if (on) row.setAttribute('aria-current', 'page'); else row.removeAttribute('aria-current');
    });
  }
  function goView(id) {
    if (!overlayEl) return;
    closeInfo(); closeDetail();
    const tab = id === '__installed' ? 'installed' : id === '__sparks' ? 'sparks' : 'browse';
    const inPlace = tab === 'browse' && activeTab === 'browse' && !!regrid;
    activeTab = tab;
    if (tab === 'browse') activeKind = id;
    shown = PAGE;
    searchQuery = '';
    if (rail) rail.search.value = '';
    syncRail();
    mainEl.scrollTop = 0;
    if (inPlace) regrid(); else paintTab(false);
  }
  function railRow(id, label, mark, count) {
    const row = el('button', 'cst-railrow'); row.type = 'button'; row.dataset.view = id;
    row.appendChild(mark);
    row.appendChild(el('span', 'cst-railrow-name', label));
    row.appendChild(el('b', 'cst-railrow-count', count || ''));
    row.addEventListener('click', () => goView(id));
    return row;
  }
  const shortCount = (n) => (n > 99 ? '99+' : String(n));
  function fillRail(entries) {
    if (!rail) return;
    const has = (test) => entries.some((e) => e && test(e));
    const fresh = entries.filter((e) => e && isNewEntry(e)).length;
    const rows = [railRow('', t('gallery_tab_browse', 'Discover'), icon('home'))];
    if (fresh) rows.push(railRow('__new', t('gallery_new_filter', 'New'), icon('new'), shortCount(fresh)));
    KIND_ORDER.filter((k) => has((e) => e.kind === k)).forEach((k) => rows.push(railRow(k, railLabel(k), kindIcon(k))));
    if (has((e) => Array.isArray(e.tags) && e.tags.includes(ON_SCREEN_TAG))) rows.push(railRow('__screen', t('gallery_for_screen', 'For the screen'), icon('topbar')));
    if (has((e) => !e.limited && (e.locked || e.supportersOnly))) rows.push(railRow('__supporters', t('gallery_supporters_section', 'Supporters'), icon('supporters')));
    if (has((e) => e.limited)) rows.push(railRow('__limited', t('gallery_limited_section', 'Limited edition'), icon('limited')));
    rail.list.replaceChildren(...rows);
    syncRail();
  }
  function paintSparksRow(row) {
    const state = window.XenonCredits.state;
    row.querySelector('.cst-railrow-count').textContent = state.status === 'ok' ? window.XenonCredits.format(state.balance) : '';
  }
  // Red count of available updates on Installed: you open it to update. Async
  // (findUpdates joins the catalog against the install index); refreshed on open
  // and whenever an install/update lands (via refreshInstalledBadge).
  function paintInstalledRow(row) {
    countUpdates().then((n) => {
      const count = row.querySelector('.cst-railrow-count');
      count.textContent = n > 0 ? shortCount(n) : '';
      count.classList.toggle('is-update', n > 0);
    }).catch(() => { /* best-effort — no count is fine */ });
  }
  function onSearch(input) {
    searchQuery = input.value.trim().toLowerCase(); shown = PAGE;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      closeInfo(); closeDetail();
      const inPlace = activeTab === 'browse' && !!regrid;
      activeTab = 'browse';
      syncRail();
      mainEl.scrollTop = 0;
      if (inPlace) regrid(); else paintTab(false);
    }, 150);
  }
  function buildRail() {
    const aside = el('aside', 'cst-rail');
    const top = el('div', 'cst-rail-top');
    top.appendChild(el('h3', 'cst-rail-title', t('ui_store', 'Store')));
    const refresh = el('button', 'cgal-iconbtn cst-refresh'); refresh.type = 'button'; refresh.title = t('gallery_refresh', 'Refresh'); refresh.appendChild(icon('refresh'));
    refresh.addEventListener('click', () => paintTab(true));
    top.appendChild(refresh);
    aside.appendChild(top);
    const find = el('label', 'cst-find');
    find.appendChild(icon('search'));
    const search = document.createElement('input');
    search.type = 'search'; search.className = 'cst-search';
    search.placeholder = t('ui_search', 'Search');
    search.setAttribute('aria-label', t('gallery_search_ph', 'Search name, author, #tag…'));
    search.addEventListener('input', () => onSearch(search));
    find.appendChild(search);
    aside.appendChild(find);
    const list = el('nav', 'cst-rail-list');
    const own = el('nav', 'cst-rail-list cst-rail-own');
    const installed = railRow('__installed', t('gallery_tab_installed', 'Installed'), icon('check'));
    own.appendChild(installed);
    refreshInstalledBadge = () => paintInstalledRow(installed);
    refreshInstalledBadge();
    if (window.SparksStore && window.XenonCredits) {
      const mark = el('span', 'cgal-ic');
      mark.appendChild(XenonCredits.spark({ still: true }));
      const sparks = railRow('__sparks', t('xai_balance_unit', 'Sparks'), mark);
      own.appendChild(sparks);
      paintSparksRow(sparks);
      stopCredits = XenonCredits.onChange(() => paintSparksRow(sparks));
      XenonCredits.refresh(false);
    }
    aside.appendChild(list);
    aside.appendChild(own);
    // Next to everything people can install, the place to make their own.
    const maker = el('a', 'cst-rail-make', t('ambient_create_maker', 'Create in Xenon Maker'));
    maker.href = MAKER_URL; maker.target = '_blank'; maker.rel = 'noopener noreferrer';
    aside.appendChild(maker);
    rail = { list, own, search };
    return aside;
  }

  // filterKind doubles as a deep-link: a real kind ('widget', 'ambient', …) or a
  // view ('__limited', '__supporters', '__installed', '__sparks').
  function open(filterKind) {
    close();
    // Capture the seen-id set as it was BEFORE this visit — that snapshot is
    // what this render flags as new; render() then persists the full current
    // catalog as seen, so everything clears on the NEXT open (#5).
    storeSeenPrev = readSeenIds();
    // Same freeze the Settings/update overlays use: the Store fills the screen,
    // so stop the dashboard animating (and re-blurring) under it.
    // Shared token is safe — close() above runs synchronously before this refreeze.
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('gallery', true);
    searchQuery = ''; sortBy = 'feat'; shown = PAGE; viewScroll = 0;
    activeTab = (filterKind === '__installed') ? 'installed' : (filterKind === '__sparks' && window.SparksStore) ? 'sparks' : 'browse';
    activeKind = (activeTab === 'browse' && filterKind !== '__sparks' && filterKind) || '';
    if (window.InstalledManager) InstalledManager.reset();
    const bd = el('div', 'preset-modal-overlay cgal-overlay cst-overlay');
    const store = el('div', 'preset-modal cgal-modal cst');
    store.setAttribute('role', 'dialog'); store.setAttribute('aria-modal', 'true');
    store.setAttribute('aria-label', t('ui_store', 'Store'));
    overlayEl = bd;
    store.appendChild(buildRail());
    mainEl = el('div', 'cgal-scroll cst-main');
    viewEl = el('div', 'cst-view');
    pageEl = el('div', 'cst-page'); pageEl.hidden = true;
    mainEl.appendChild(viewEl); mainEl.appendChild(pageEl);
    store.appendChild(mainEl);
    const x = el('button', 'cst-close'); x.type = 'button'; x.title = t('gallery_close', 'Close'); x.appendChild(icon('close'));
    x.addEventListener('click', close);
    store.appendChild(x);
    bd.appendChild(store);
    document.body.appendChild(bd);
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onStoreKey, true);
    // The rail lists the catalog whichever view opens first.
    catalogEntries().then((entries) => { if (overlayEl === bd) fillRail(entries); }).catch(() => { /* render says so */ });
    syncRail();
    // While open, an install committed elsewhere repaints the Store and flips the
    // keys of the entry on screen, without moving the view under them.
    repaintStore = async () => {
      if (!overlayEl || zoomEl || infoEl) return;
      await paintTab(false, true);
      if (detailEntry) { await refreshInstallIndex(); drawDetailCta(); }
    };
    paintTab(false);
  }

  // The Sparks view, from anywhere: every "Buy Sparks" in the app lands here. An
  // open Store switches to it; a closed one opens on it.
  function openSparks() {
    if (overlayEl && window.SparksStore) { goView('__sparks'); return; }
    open('__sparks');
  }

  // Open the Store straight onto one entry's detail view — used by the "new
  // drop" modal so its CTA lands the user on the real purchase/reserve context
  // (same import boundary; openDetail shows it in the freshly-opened Store).
  // The saved-code check runs first: on a cold open the detail would otherwise
  // be drawn before the Store knows about the code, and sell the membership to
  // someone who already holds it.
  async function openEntry(entry) {
    if (!entry) { open(); return; }
    open(entry.limited ? '__limited' : undefined);
    await Promise.all([refreshSupporterSaved(), refreshInstallIndex()]);
    if (!overlayEl) return;   // closed meanwhile
    openDetail(entry);
  }
  // The same from an id: a creation retired since then opens the plain Store.
  async function openEntryById(id) {
    let entry = null;
    try {
      const cat = await apiJson('/api/community/catalog');
      if (cat && cat.ok && Array.isArray(cat.entries)) entry = cat.entries.find((e) => e && e.id === id) || null;
    } catch { /* the plain Store below */ }
    await openEntry(entry);
  }
  // Open the Store on the membership: the Supporters sheet for a PC with no code, the
  // Supporters list for one that keeps a code.
  async function openSupporters() {
    open();
    await refreshSupporterSaved();
    if (!overlayEl) return;
    if (supporterSaved) { goView('__supporters'); return; }
    if (!catalogAll.length) { // the pictures on the sheet are the catalog's
      const all = await catalogEntries().catch(() => []);
      if (!catalogAll.length) catalogAll = all;
    }
    if (overlayEl) openSupporterInfo();
  }
  // "Unlock" from outside the Store (the new-drop card) for a PC that keeps a
  // supporter code: the entry's detail opens with the unlock dialog straight on
  // top, the same dialog its own Unlock button opens.
  async function unlockEntry(entry) {
    await openEntry(entry);
    if (!entry || !overlayEl || entry.needsNewerApp) return;
    const state = entryInstallState(entry);
    if (state !== 'current') await startImport(entry, state === 'update');
  }

  // kindIcon + SHOTS_BASE are shared with the Installed tab
  // (js/installed-manager.js) so both surfaces draw from ONE icon set and ONE
  // sidecar path rule. shotUrl derives from the entry id the server already
  // charset-pinned — never from catalog-supplied text.
  const shotUrl = (entryId, i, ext) => SHOTS_BASE + encodeURIComponent(entryId) + (i === 1 ? '' : '-' + i) + '.' + ext;
  // Count catalog entries this device has never seen in the Store — for the count
  // on the Settings gear and the "Open the Store" buttons. Read-only: it never
  // touches the seen set (browsing the Store is what marks entries seen), and
  // returns 0 when the Store was never opened, so nothing is flagged before the
  // first browse (#5).
  async function newSinceLastVisit() {
    const seen = readSeenIds();
    if (!seen) return 0;   // never browsed the Store yet → nothing to advertise
    try {
      const out = await api('/api/community/catalog');
      if (!out || !out.ok || !Array.isArray(out.entries)) return 0;
      return out.entries.filter((e) => e && e.id && !seen.has(e.id)).length;
    } catch { return 0; }
  }
  // Number of OWNED catalog items with an update available — the red badge on the
  // Store buttons and the Installed tab. Standalone (works while the Store is
  // closed): findUpdates() re-reads the install index and joins it against the
  // catalog exactly like the Store's own "Aggiornamenti" section, so the three
  // never disagree.
  async function countUpdates() {
    try {
      const out = await api('/api/community/catalog');
      if (!out || !out.ok || !Array.isArray(out.entries)) return 0;
      const ups = await findUpdates(out.entries);
      return Array.isArray(ups) ? ups.length : 0;
    } catch { return 0; }
  }
  // Paint (or clear) the badge on the Settings entry points to the Store. UPDATES
  // win — a red count of owned items with a newer version, the actionable "open
  // the Store and update" signal. With none pending it falls back to the accent
  // "N new since your last visit" discovery count (#5). Refreshed at boot, when the
  // Store closes, and whenever an install/update lands.
  function refreshStoreDot() {
    // The Settings entry points to the Store, plus the topbar Settings gear —
    // the gear is what you see WITHOUT opening anything, so the count reaches
    // you on the dashboard itself and clears once the Store is opened.
    const btns = document.querySelectorAll('.settings-nav-store, .settings-store-open, .qbtn-settings');
    if (!btns.length) return;
    Promise.all([countUpdates(), newSinceLastVisit()]).then(([updates, fresh]) => {
      const n = updates > 0 ? updates : fresh;
      const isUpdate = updates > 0;
      btns.forEach((btn) => {
        let dot = btn.querySelector('.cgal-store-dot');
        if (n > 0) {
          if (!dot) { dot = el('span', 'cgal-store-dot'); btn.appendChild(dot); }
          dot.textContent = n > 99 ? '99+' : String(n);
          dot.classList.toggle('is-new', !isUpdate);   // accent for "new", red for updates
          dot.title = isUpdate ? t('gallery_updates', 'Updates') : t('gallery_new_filter', 'New');
        } else if (dot) { dot.remove(); }
      });
    }).catch(() => { /* best-effort — no dot is fine */ });
  }

  // An install committed anywhere (a catalog receipt written in preset-share.js
  // fires 'xenon-content-installed') asks an open Store to re-read its install
  // index, so a card flips to "Installed" without a manual ↻ — the finishing half
  // of keeping the Store open across an install (#1). No-op while closed.
  try {
    window.addEventListener('xenon-content-installed', () => {
      if (repaintStore) repaintStore();
      if (refreshInstalledBadge) refreshInstalledBadge();   // the update count on the Installed tab drops
      refreshStoreDot();                                    // and the Settings dot follows
    });
  } catch { /* no window (non-browser context) — nothing to repaint */ }
  // Seed the Settings "new items" dot a few seconds after boot (the server catalog
  // is SWR-cached, so this is cheap and usually instant).
  try { setTimeout(() => { try { refreshStoreDot(); } catch { /* ignore */ } }, 4000); } catch { /* no timers */ }

  window.CommunityGallery = { open, close, findUpdates, isOfficial, openEntry, openEntryById, openSupporters, openSparks, unlockEntry, kindIcon, shotUrl, refreshStoreDot };
})();
