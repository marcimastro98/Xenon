'use strict';
// Catalog "new drop" nudge — a single, dismissible modal that appears when a
// PAID tier (a Supporters creation or an available Limited edition) has landed
// in the Store since the user last saw one. It exists to gently invite a
// purchase/donation, never to nag: it runs at most once a day, announces a whole
// batch of new drops with ONE modal, and offers a first-class "don't show me new
// drops again" opt-out that is honoured forever.
//
// It reuses the ONE import/purchase boundary: every CTA funnels into the Store
// (CommunityGallery.openEntry / openSupporters), so nothing here can apply or buy
// anything on its own. All catalog-supplied text stays textContent (makeEl), and
// screenshots load from the id-derived project-site path — never from
// catalog-supplied URLs.
(function () {
  const el = makeEl;                 // shared DOM factory (textContent-safe) from utils.js
  const api = apiJson;               // shared fetch-JSON helper from utils.js
  const t = (k, fb) => { const v = (typeof window.t === 'function') ? window.t(k) : k; return (v === k && fb != null) ? fb : v; };
  // Same shape the server and the hub accept for an id — checked before a dropId
  // from the catalog is ever interpolated into a URL.
  const ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;

  // Screenshots are served from the assets host (R2), same as the Store gallery
  // and the website catalog; the URL is derived from the (server-charset-pinned)
  // entry id, never from catalog text. Must stay in step with SHOTS_BASE in
  // community-gallery.js — a stale host here just shows the gradient fallback.
  const SHOTS_BASE = 'https://assets.xenon-app.com/community/shots/';
  const DAY = 24 * 3600 * 1000;

  // ── Local, per-device UX state (mirrors the daily SDK-update check pattern) ──
  const K_MUTED = 'xeneonedge.catalogDropsMuted'; // '1' once the user opts out
  const K_CHECK = 'xeneonedge.catalogDropCheck';  // last-check timestamp (daily throttle)

  // The announced-id set moved to js/interrupt-queue.js (same storage key, so
  // existing history carries over): a hub announcement can name the same entry
  // this modal already showed, and only a shared set can catch that.
  const readSeen = () => window.XenonInterrupts.readSeen();
  const markSeen = (ids) => window.XenonInterrupts.markSeen(ids);
  // Settings → Aggiornamenti owns this now (v4.9.0). Before that it was a
  // localStorage flag only: per device, and with no way back once pressed. The
  // legacy key still mutes, and Settings clears it when you switch drops back on.
  const HS = () => { try { return (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : {}; } catch { return {}; } };
  const isMuted = () => {
    if (HS().catalogDrops === false) return true;
    try { return localStorage.getItem(K_MUTED) === '1'; } catch { return false; }
  };
  const mute = () => {
    try { localStorage.setItem(K_MUTED, '1'); } catch { /* ignore */ }
    try { if (typeof updateCatalogDrops === 'function') updateCatalogDrops(false); } catch { /* ignore */ }
  };

  // A drop worth nudging about = an AVAILABLE limited edition, or a
  // supporters-only / locked creation. Free community items never trigger this.
  // `active:false` from the live status = the hub has closed the drop: copies may
  // still be on the counter, but nobody can claim one. Announcing that is the
  // same dead end as announcing a sold-out drop, so it doesn't. Absent (the
  // hub never answered) means open — the published numbers stand, as before.
  function isPaidDrop(e) {
    if (!e || !e.id) return false;
    // Stock through limitedStock(): `soldOut` is added by the server proxy, so a
    // catalog read that skipped it (the website demo) had every drop reading as
    // available — including one whose copies were all claimed.
    if (e.limited) { const s = limitedStock(e.limited); return !!s && !s.soldOut && e.limited.active !== false; }
    return !!(e.locked || e.supportersOnly);
  }

  // catalog.json freezes the stock at publish time, so the scarcity meter read
  // "50 of 50 left" while copies were already gone, and a drop that sold out
  // would still have been announced as available. The hub is the only thing that
  // knows; the Store asks it the same way. Best-effort: no answer leaves the
  // published numbers, which is what this did before.
  async function hydrateLimited(entries) {
    try {
      const ids = [...new Set((entries || [])
        .filter((e) => e && e.limited && e.limited.fulfillment === 'hub' && ID_RE.test(String(e.limited.dropId || '')))
        .map((e) => e.limited.dropId))];
      if (!ids.length) return;
      const out = await api('/api/community/limited-status?ids=' + encodeURIComponent(ids.join(',')));
      if (!out || !out.ok || !out.drops) return;
      entries.forEach((e) => {
        const live = e && e.limited && out.drops[e.limited.dropId];
        if (live) Object.assign(e.limited, live);
      });
    } catch { /* keep the published numbers */ }
  }
  const variantOf = (e) => (e.limited ? 'limited' : 'supporter');

  // Never interrupt mid-flow: the hold-while-busy test and the waiting poller live
  // in js/interrupt-queue.js (see presentWhenIdle). `.upd-overlay` — What's New /
  // update-available — still takes precedence there, so a drop keeps appearing
  // only after it closes.

  // ── Preview media: a real screenshot when the drop has one, else a gradient
  // built from the server-validated preview swatches (never an empty box).
  function buildMedia(entry) {
    const media = el('div', 'xdrop-media');
    const p = entry.preview || {};
    const grad = () => {
      const a = p.accent || (entry.limited ? '#8b7bff' : '#ffb454');
      const bg = p.bg || '#0b0f13';
      media.style.background = 'radial-gradient(120% 120% at 80% 0%, ' + a + '55, transparent 60%), linear-gradient(160deg, ' + bg + ', #05070a)';
      media.classList.add('is-grad');
    };
    const shots = entry.shots || (entry.screenshot ? 1 : 0);
    if (shots > 0) {
      const img = document.createElement('img');
      img.className = 'xdrop-shot'; img.alt = ''; img.decoding = 'async';
      const base = SHOTS_BASE + encodeURIComponent(entry.id);
      let triedPng = false;
      img.addEventListener('error', () => {
        if (!triedPng) { triedPng = true; img.src = base + '.png'; return; }
        img.remove(); grad();
      });
      img.src = base + '.webp';
      media.appendChild(img);
    } else { grad(); }
    return media;
  }

  // The entry's own accent, as "r, g, b", so the card's light is the pack's
  // light. Only a validated #rrggbb is read; anything else keeps the tier colour.
  function accentRgb(entry) {
    const a = entry && entry.preview && entry.preview.accent;
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(a || ''));
    return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)).join(', ') : null;
  }

  // "Ends in 3 days" from the entry's real activeUntil, never an invented clock.
  // Days above two days, hours above two hours, minutes below that.
  function endsText(entry) {
    const ts = entry && entry.activeUntil ? Date.parse(entry.activeUntil) : NaN;
    if (!Number.isFinite(ts)) return '';
    const ms = ts - Date.now();
    if (ms <= 0) return '';
    let lang = 'en';
    try { lang = String(((typeof window.currentLang === 'function') ? window.currentLang() : window.LANG) || document.documentElement.lang || 'en').slice(0, 2).toLowerCase(); } catch { /* en */ }
    let rel;
    try {
      const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'always' });
      const h = ms / 3600000;
      rel = h >= 48 ? rtf.format(Math.floor(h / 24), 'day')
        : h >= 2 ? rtf.format(Math.floor(h), 'hour')
          : rtf.format(Math.max(1, Math.floor(ms / 60000)), 'minute');
    } catch { return ''; }
    return t('drop_ends', 'Ends {rel}').replace('{rel}', rel);
  }

  const kindLabel = (e) => t('preset_kind_' + (e && e.kind), '') || '';

  let overlay = null;
  let onKey = null;
  let ticker = null;
  let dropSeq = 0;   // per-instance ambientFreeze tokens (see close())

  function close(muted) {
    if (!overlay) return;
    if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
    if (ticker) { clearInterval(ticker); ticker = null; }
    overlay.classList.add('closing');
    const node = overlay; overlay = null;
    // Thaw when the node actually leaves the DOM. The token is per-instance:
    // show() can reopen a new drop before this 220ms timer fires, and a shared
    // token would let the OLD overlay's timer thaw the freshly opened one.
    setTimeout(() => {
      node.remove();
      if (node._freezeToken && typeof window.ambientFreeze === 'function') window.ambientFreeze(node._freezeToken, false);
    }, 220);
    if (muted && window.XenonToast) {
      window.XenonToast.show({ type: 'info', title: t('drop_muted_toast', 'Got it — we won’t show new drops again. Find them anytime in the Store.'), duration: 5000 });
    }
  }

  const X_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  // The two crests: a gem for a limited edition, a crown for supporters.
  const CREST = {
    limited: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 3h10l4 5.5L12 21 3 8.5 7 3Zm1.1 2L6 8h3.4l1.2-3H8.1Zm4.4 0-1.2 3h3.4l-1.2-3h-1Zm3.4 0 1.2 3H18l-2.1-3h0ZM6.3 10l4.3 6.2L9.2 10H6.3Zm4.9 0 .8 6.9.8-6.9h-1.6Zm3.6 0-1.4 6.2L17.7 10h-2.9Z"/></svg>',
    supporter: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 7.5 7.6 11 12 4l4.4 7L21 7.5 19.2 18H4.8L3 7.5Zm2 12h14v1.8H5V19.5Z"/></svg>',
  };

  // Shared shell: the dimmed room, the burst of light behind the card, the close
  // button and the frozen dashboard underneath.
  function shell(cls, rgb) {
    const bd = el('div', 'xdrop-overlay');
    bd._freezeToken = 'catalog-drop:' + (++dropSeq);
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze(bd._freezeToken, true);
    bd.appendChild(el('div', 'xdrop-burst'));
    const card = el('div', 'xdrop-card ' + cls);
    if (rgb) card.style.setProperty('--xa', rgb);
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    const x = el('button', 'xdrop-x'); x.type = 'button'; x.setAttribute('aria-label', t('gallery_close', 'Close'));
    x.innerHTML = X_SVG;
    card.appendChild(x);
    bd.appendChild(card);
    return { bd, card, x };
  }

  function footer(body) {
    const foot = el('div', 'xdrop-foot');
    const lab = el('label', 'xdrop-dontshow');
    const cb = document.createElement('input'); cb.type = 'checkbox';
    const box = el('span', 'xdrop-box');
    box.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 6"/></svg>';
    lab.appendChild(cb); lab.appendChild(box); lab.appendChild(el('span', null, t('drop_mute', 'Don’t show me new drops')));
    const later = el('button', 'xdrop-later', t('drop_later', 'Maybe later')); later.type = 'button';
    foot.appendChild(lab); foot.appendChild(later);
    body.appendChild(foot);
    return { cb, later };
  }

  function wire(parts, bd, cb, later, focusEl) {
    const dismiss = () => { const m = cb.checked; if (m) mute(); close(m); };
    parts.x.addEventListener('click', dismiss);
    later.addEventListener('click', dismiss);
    bd.addEventListener('click', (ev) => { if (ev.target === bd) dismiss(); });
    onKey = (ev) => { if (ev.key === 'Escape') dismiss(); };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(bd);
    overlay = bd;
    if (focusEl) setTimeout(() => { try { focusEl.focus({ preventScroll: true }); } catch { /* ignore */ } }, 60);
  }

  // Scarcity, only from real numbers: "12 of 50 left" and a meter of what is gone.
  function meter(stock) {
    const m = el('div', 'xdrop-meter');
    const bar = el('div', 'xdrop-bar'); const fill = el('div', 'xdrop-barfill');
    fill.style.setProperty('--gone', Math.round(((stock.total - stock.left) / stock.total) * 100) + '%');
    bar.appendChild(fill); m.appendChild(bar);
    m.appendChild(el('span', 'xdrop-left', t('gallery_limited_left', '{n} of {t} left').replace('{n}', String(stock.left)).replace('{t}', String(stock.total))));
    return m;
  }

  // One drop: the shop card. The picture of the pack is the hero; a crest names
  // the tier; the facts under the name are only ones the catalog states (kind,
  // copies left, end date); one lit button does the one thing that matters.
  function show(entry) {
    if (!entry || !window.CommunityGallery) return;
    close();
    const isLim = variantOf(entry) === 'limited';
    const parts = shell(isLim ? 'is-limited' : 'is-sup', accentRgb(entry));
    const { bd, card } = parts;

    const art = el('div', 'xdrop-art');
    art.appendChild(buildMedia(entry));
    art.appendChild(el('div', 'xdrop-shine'));
    const crest = el('div', 'xdrop-crest');
    crest.innerHTML = CREST[isLim ? 'limited' : 'supporter'];
    crest.appendChild(el('span', null, isLim ? t('gallery_limited_section', 'Limited edition') : t('gallery_supporters_section', 'Supporters')));
    art.appendChild(crest);
    card.appendChild(art);

    const body = el('div', 'xdrop-body');
    body.appendChild(el('div', 'xdrop-kicker', t('drop_headline', 'Just landed in the Store')));
    body.appendChild(el('h2', 'xdrop-title', entry.name || ''));

    const facts = el('div', 'xdrop-facts');
    const kind = kindLabel(entry);
    if (kind) facts.appendChild(el('span', 'xdrop-fact', kind));
    if (entry.author) facts.appendChild(el('span', 'xdrop-fact', t('gallery_by', 'by') + ' ' + entry.author));
    const ends = el('span', 'xdrop-fact is-time', endsText(entry));
    if (ends.textContent) facts.appendChild(ends);
    if (facts.children.length) body.appendChild(facts);

    const sub = entry.description
      || (isLim ? t('drop_limited_sub', 'A limited-edition drop with a fixed number of copies worldwide. Once they’re gone, it retires for good.')
        : t('drop_supporter_sub', 'A new supporter creation is here. Become a supporter to unlock it — and everything supporters get, forever.'));
    body.appendChild(el('p', 'xdrop-sub', sub));

    const stock = isLim ? limitedStock(entry.limited) : null;
    if (stock) body.appendChild(meter(stock));

    const actions = el('div', 'xdrop-actions');
    // It opens the entry in the Store, where the claim or the unlock lives.
    const primary = el('button', 'xdrop-btn xdrop-primary');
    primary.type = 'button';
    primary.appendChild(el('span', 'xdrop-btn-label', isLim ? t('gallery_claim_copy', 'Claim your copy') : t('gallery_supporters_join', 'Become a supporter')));
    primary.addEventListener('click', () => {
      close();
      if (isLim) window.CommunityGallery.openEntry(entry);
      else window.CommunityGallery.openSupporters();
    });
    const secondary = el('button', 'xdrop-btn xdrop-ghost', t('drop_details', 'See details'));
    secondary.type = 'button';
    secondary.addEventListener('click', () => { close(); window.CommunityGallery.openEntry(entry); });
    actions.appendChild(primary); actions.appendChild(secondary);
    body.appendChild(actions);

    const { cb, later } = footer(body);
    card.appendChild(body);
    // The end date moves while the card is open, so it is kept honest.
    if (ends.textContent) ticker = setInterval(() => { ends.textContent = endsText(entry); }, 60000);
    wire(parts, bd, cb, later, primary);
  }

  // Several drops at once → ONE card holding a row of offer tiles, like a shop's
  // offers of the day: picture, crest, name, copies left. Each tile opens its
  // entry; one button opens the Store. Never a modal per item.
  function showBatch(drops) {
    if (!Array.isArray(drops) || !drops.length || !window.CommunityGallery) return;
    close();
    const parts = shell('is-batch', null);
    const { bd, card } = parts;

    const body = el('div', 'xdrop-body');
    body.appendChild(el('div', 'xdrop-kicker', t('drop_headline', 'Just landed in the Store')));
    body.appendChild(el('h2', 'xdrop-title', t('gallery_new_filter', 'Novità')));
    body.appendChild(el('p', 'xdrop-sub',
      t('drop_batch_sub', '{n} nuove creazioni sono arrivate nello Store: toccane una per vederla da vicino.').replace('{n}', String(drops.length))));

    const list = el('div', 'xdrop-tiles');
    for (const entry of drops) {
      const isLim = variantOf(entry) === 'limited';
      const tile = el('button', 'xdrop-tile ' + (isLim ? 'is-limited' : 'is-sup'));
      tile.type = 'button';
      const rgb = accentRgb(entry);
      if (rgb) tile.style.setProperty('--xa', rgb);
      const art = el('div', 'xdrop-tile-art');
      art.appendChild(buildMedia(entry));
      const crest = el('span', 'xdrop-tile-crest');
      crest.innerHTML = CREST[isLim ? 'limited' : 'supporter'];
      crest.appendChild(el('span', null, isLim ? t('gallery_limited_badge', 'Limited') : t('gallery_locked_badge', 'Supporters')));
      art.appendChild(crest);
      tile.appendChild(art);
      const mid = el('span', 'xdrop-tile-mid');
      mid.appendChild(el('span', 'xdrop-tile-name', entry.name || ''));
      const st = isLim ? limitedStock(entry.limited) : null;
      const line = st && !st.soldOut
        ? t('gallery_limited_left', '{n} of {t} left').replace('{n}', String(st.left)).replace('{t}', String(st.total))
        : (endsText(entry) || kindLabel(entry));
      if (line) mid.appendChild(el('span', 'xdrop-tile-line', line));
      tile.appendChild(mid);
      tile.addEventListener('click', () => { close(); window.CommunityGallery.openEntry(entry); });
      list.appendChild(tile);
    }
    body.appendChild(list);

    const actions = el('div', 'xdrop-actions');
    const primary = el('button', 'xdrop-btn xdrop-primary');
    primary.type = 'button';
    primary.appendChild(el('span', 'xdrop-btn-label', t('settings_store_open', 'Apri lo Store')));
    primary.addEventListener('click', () => { close(); window.CommunityGallery.open(); });
    actions.appendChild(primary);
    body.appendChild(actions);

    const { cb, later } = footer(body);
    card.appendChild(body);
    wire(parts, bd, cb, later, primary);
  }

  // ── When to look, and when to show ─────────────────────────────────────────
  // The modal still appears at most once a day. What changed is how often it
  // LOOKS: it used to check once, twenty seconds after the page loaded, and never
  // again, so a dashboard left open for days (the kiosk on an Edge is exactly
  // that) never heard of a drop published after it opened, and a check that met
  // game mode or the Ambient screen for five minutes gave up until a reload. Now
  // it looks every few hours while open and when the dashboard comes back into
  // view, and a wait that expired simply tries again on the next look.
  const CHECK_EVERY = 3 * 3600 * 1000;               // how often it asks the catalog
  const LOOK_EVERY = 30 * 60 * 1000;                 // how often it considers asking
  const WAIT_MAX = 6 * 60 * 1000;                    // the queue gives up after ~5 min
  const K_SHOWN = 'xeneonedge.catalogDropShown';     // last time the modal appeared
  const readTs = (k) => { try { return Number(localStorage.getItem(k) || 0); } catch { return 0; } };
  const stampTs = (k) => { try { localStorage.setItem(k, String(Date.now())); } catch { /* ignore */ } };
  let waitingSince = 0;

  // Wait for any higher-priority overlay to close (notably What's New, which must
  // be seen first), then announce the batch with ONE modal. The day is spent only
  // once something is actually on screen.
  function presentWhenIdle(fresh) {
    const P = window.XenonInterrupts.PRIORITY;
    // A limited edition outranks a supporter pack in the shared queue: its copies run out.
    const priority = fresh.some((e) => e.limited) ? P.limited : P.drop;
    waitingSince = Date.now();
    window.XenonInterrupts.whenIdle(() => {
      waitingSince = 0;
      if (isMuted()) return;                  // muted from another surface while waiting
      stampTs(K_SHOWN); stampTs(K_CHECK);
      // ONE announcement, whatever landed. Limited drops lead: their copies run
      // out. Everything announced is marked seen: the batch showed each by name.
      const ordered = fresh.filter((e) => e.limited).concat(fresh.filter((e) => !e.limited));
      if (ordered.length === 1) show(ordered[0]);
      else showBatch(ordered);
      markSeen(ordered.map((e) => e.id));
    }, { priority });
  }

  async function checkDaily() {
    try {
      if (isMuted()) return;
      const now = Date.now();
      if (now - readTs(K_SHOWN) < DAY) return;          // one modal a day, as always
      if (now - readTs(K_CHECK) < CHECK_EVERY) return;  // asked recently
      if (waitingSince && now - waitingSince < WAIT_MAX) return;   // already queued
      const out = await api('/api/community/catalog');
      if (!out || !out.ok || !Array.isArray(out.entries)) return;   // offline → next look
      await hydrateLimited(out.entries);
      const seen = readSeen();
      const fresh = out.entries.filter((e) => isPaidDrop(e) && !seen.includes(e.id));
      if (!fresh.length) { stampTs(K_CHECK); return; }  // nothing new → ask again in a few hours
      presentWhenIdle(fresh);                            // waits its turn behind What's New
    } catch { /* best-effort — never surface an error for a promo nudge */ }
  }

  window.CatalogDrop = { checkDaily, show, showBatch, close };
  // Staggered a little after the SDK daily check so the two catalog reads don't
  // race the first paint (both hit the same TTL-cached endpoint anyway). Then a
  // look every half hour (each look is a timestamp comparison until a real ask is
  // due), and one when the dashboard comes back into view. A chain of timeouts,
  // not setInterval, so nothing here competes with the interrupt queue's ticker.
  const look = () => { try { checkDaily(); } catch { /* ignore */ } };
  const loop = () => setTimeout(() => { look(); loop(); }, LOOK_EVERY);
  setTimeout(() => { look(); loop(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) look(); });
})();
