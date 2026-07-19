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
  const K_SEEN = 'xeneonedge.catalogSeen';       // JSON array of drop ids already announced
  const K_MUTED = 'xeneonedge.catalogDropsMuted'; // '1' once the user opts out
  const K_CHECK = 'xeneonedge.catalogDropCheck';  // last-check timestamp (daily throttle)
  const SEEN_CAP = 250;

  function readSeen() {
    try { const a = JSON.parse(localStorage.getItem(K_SEEN) || '[]'); return Array.isArray(a) ? a : []; }
    catch { return []; }
  }
  function markSeen(ids) {
    if (!ids || !ids.length) return;
    const set = readSeen();
    for (const id of ids) if (id && !set.includes(id)) set.push(id);
    // Keep the most recent ids only — an unbounded list would grow forever.
    try { localStorage.setItem(K_SEEN, JSON.stringify(set.slice(-SEEN_CAP))); } catch { /* storage full/blocked */ }
  }
  const isMuted = () => { try { return localStorage.getItem(K_MUTED) === '1'; } catch { return false; } };
  const mute = () => { try { localStorage.setItem(K_MUTED, '1'); } catch { /* ignore */ } };

  // A drop worth nudging about = an AVAILABLE limited edition, or a
  // supporters-only / locked creation. Free community items never trigger this.
  function isPaidDrop(e) {
    if (!e || !e.id) return false;
    if (e.limited) return !e.limited.soldOut;
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

  // Don't interrupt the user mid-flow: hold while a game/lockscreen/ambient is
  // active or another overlay is already up. `.upd-overlay` is the What's-New /
  // update-available modal, which ALWAYS takes precedence — the drop waits for it
  // to close and appears afterwards (see presentWhenIdle).
  function busy() {
    const c = document.body.classList;
    if (c.contains('game-mode') || c.contains('lock-screen-active') || c.contains('ambient-scene-open')
      || c.contains('ambient-canvas-open') || c.contains('ambient-idle')) return true;
    return !!document.querySelector('.upd-overlay, .preset-modal-overlay, .cgal-overlay, .xdrop-overlay');
  }

  // ── Preview media: a real screenshot when the drop has one, else a premium
  // gradient built from the server-validated preview swatches (never an empty box).
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
      img.className = 'xdrop-shot'; img.loading = 'lazy'; img.alt = '';
      const base = SHOTS_BASE + encodeURIComponent(entry.id);
      let triedPng = false;
      img.addEventListener('error', () => {
        if (!triedPng) { triedPng = true; img.src = base + '.png'; return; }
        img.remove(); grad();
      });
      img.src = base + '.webp';
      media.appendChild(img);
    } else { grad(); }
    media.appendChild(el('div', 'xdrop-media-veil'));
    return media;
  }

  let overlay = null;
  let onKey = null;
  // Drops still waiting their turn. A limited edition and a supporter pack are
  // two different offers, and announcing only the first meant the second was
  // marked as "already announced" and never seen by anyone. They queue instead:
  // the next one opens when the current is DISMISSED, never when the user
  // followed it into the Store, and never after "don't show me new drops".
  let queued = [];
  let dropSeq = 0;   // per-instance ambientFreeze tokens (see close())

  function showNextQueued() {
    if (isMuted()) { queued = []; return; }
    const next = queued.shift();
    if (next) setTimeout(() => show(next), 320);   // after the close animation
  }

  function close(muted) {
    if (!overlay) return;
    if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
    overlay.classList.add('closing');
    const node = overlay; overlay = null;
    // Thaw when the node actually leaves the DOM. The token is per-instance:
    // show() can reopen a new drop before this 200ms timer fires, and a shared
    // token would let the OLD overlay's timer thaw the freshly opened one.
    setTimeout(() => {
      node.remove();
      if (node._freezeToken && typeof window.ambientFreeze === 'function') window.ambientFreeze(node._freezeToken, false);
    }, 200);
    if (muted && window.XenonToast) {
      window.XenonToast.show({ type: 'info', title: t('drop_muted_toast', 'Got it — we won’t show new drops again. Find them anytime in the Store.'), duration: 5000 });
    }
  }

  // Build + present the modal for one drop (the most prominent of the batch).
  function show(entry) {
    if (!entry || !window.CommunityGallery) return;
    close();
    const variant = variantOf(entry);
    const isLim = variant === 'limited';

    const bd = el('div', 'xdrop-overlay');
    bd._freezeToken = 'catalog-drop:' + (++dropSeq);
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze(bd._freezeToken, true);
    const card = el('div', 'xdrop-card ' + (isLim ? 'is-limited' : 'is-sup'));

    // Close (X)
    const x = el('button', 'xdrop-x'); x.type = 'button'; x.setAttribute('aria-label', t('gallery_close', 'Close'));
    x.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    card.appendChild(x);

    // Media + headline pill
    const media = buildMedia(entry);
    const pill = el('span', 'xdrop-pill', t('drop_headline', 'Just landed in the Store'));
    media.appendChild(pill);
    card.appendChild(media);

    // Body
    const body = el('div', 'xdrop-body');
    const kicker = el('div', 'xdrop-kicker');
    kicker.innerHTML = isLim
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.2l1.9 5.6a2 2 0 0 0 1.3 1.3l5.6 1.9-5.6 1.9a2 2 0 0 0-1.3 1.3L12 19.8l-1.9-5.6a2 2 0 0 0-1.3-1.3L3.2 11l5.6-1.9a2 2 0 0 0 1.3-1.3z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.4l-1.5-1.3C5.7 14.9 3 12.4 3 9.3A4.3 4.3 0 0 1 7.3 5c1.5 0 3 .8 3.7 2 .7-1.2 2.2-2 3.7-2A4.3 4.3 0 0 1 21 9.3c0 3.1-2.7 5.6-7.5 9.8z"/></svg>';
    kicker.appendChild(el('span', null, isLim ? t('gallery_limited_section', 'Limited edition') : t('gallery_supporters_section', 'Supporters')));
    body.appendChild(kicker);

    body.appendChild(el('h2', 'xdrop-title', entry.name || ''));
    const sub = entry.description
      || (isLim ? t('drop_limited_sub', 'A limited-edition drop with a fixed number of copies worldwide. Once they’re gone, it retires for good.')
                : t('drop_supporter_sub', 'A new supporter creation is here. Become a supporter to unlock it — and everything supporters get, forever.'));
    body.appendChild(el('p', 'xdrop-sub', sub));

    // Limited → real scarcity meter (no invented countdown; only true left/total).
    if (isLim) {
      const lim = entry.limited;
      const total = Math.max(1, Number(lim.total) || 0), left = Math.max(0, Number(lim.left) || 0);
      const meter = el('div', 'xdrop-meter');
      const bar = el('div', 'xdrop-bar'); const fill = el('div', 'xdrop-barfill');
      fill.style.width = Math.round(((total - left) / total) * 100) + '%'; bar.appendChild(fill);
      meter.appendChild(bar);
      meter.appendChild(el('span', 'xdrop-left', t('gallery_limited_left', '{n} of {t} left').replace('{n}', String(lim.left)).replace('{t}', String(lim.total))));
      body.appendChild(meter);
    }

    // Actions
    const actions = el('div', 'xdrop-actions');
    // Say what the button does. It opens the entry in the Store, where the claim
    // lives; "Reserve on Discord" promised a jump to Discord that never happened,
    // and on a drop with no Discord post of its own the promise was doubly wrong.
    const primary = el('button', 'xdrop-btn xdrop-primary', isLim ? t('gallery_claim_copy', 'Claim your copy') : t('gallery_supporters_join', 'Become a supporter'));
    primary.type = 'button';
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

    // Footer: honest opt-out + "maybe later"
    const foot = el('div', 'xdrop-foot');
    const lab = el('label', 'xdrop-dontshow');
    const cb = document.createElement('input'); cb.type = 'checkbox';
    const box = el('span', 'xdrop-box');
    box.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 6"/></svg>';
    lab.appendChild(cb); lab.appendChild(box); lab.appendChild(el('span', null, t('drop_mute', 'Don’t show me new drops')));
    const later = el('button', 'xdrop-later', t('drop_later', 'Maybe later')); later.type = 'button';
    foot.appendChild(lab); foot.appendChild(later);
    body.appendChild(foot);

    const dismiss = () => { const m = cb.checked; if (m) mute(); close(m); showNextQueued(); };
    x.addEventListener('click', dismiss);
    later.addEventListener('click', dismiss);
    bd.addEventListener('click', (ev) => { if (ev.target === bd) dismiss(); });
    onKey = (ev) => { if (ev.key === 'Escape') dismiss(); };
    document.addEventListener('keydown', onKey);

    card.appendChild(body);
    bd.appendChild(card);
    document.body.appendChild(bd);
    overlay = bd;
  }

  // Wait for any higher-priority overlay to close (notably What's New, which must
  // be seen first), then announce the batch with ONE modal. The daily window is
  // stamped only once we actually show — so if the user leaves What's New open and
  // walks away, we simply retry on the next load instead of burning the day.
  const STAMP = () => { try { localStorage.setItem(K_CHECK, String(Date.now())); } catch { /* ignore */ } };
  function presentWhenIdle(fresh, tries) {
    tries = tries || 0;
    if (isMuted()) return;                    // muted from another surface meanwhile
    if (!busy()) {
      STAMP();
      // One of each kind, limited first: it is the one with copies running out,
      // so it is the one that cannot wait for tomorrow. The supporter pack opens
      // behind it if the user dismisses rather than following the first in.
      const lead = fresh.find((e) => e.limited) || fresh[0];
      const other = fresh.find((e) => e.id !== lead.id && variantOf(e) !== variantOf(lead));
      queued = other ? [other] : [];
      show(lead);
      // Mark ONLY what was actually announced (shown or queued). Stamping the
      // whole batch silently buried a second drop of the SAME variant forever:
      // it never queued, yet its id landed in the seen list and every future
      // checkDaily filtered it out. Left unstamped, it becomes tomorrow's lead.
      markSeen([lead.id].concat(queued.map((e) => e.id)));
      return;
    }
    if (tries > 200) return;                  // ~5 min of polling, then retry next load
    setTimeout(() => presentWhenIdle(fresh, tries + 1), 1500);
  }

  // Once-a-day check, client-driven (no server timer): fetch the catalog (absorbed
  // by the server's TTL cache) and find PAID drops the user hasn't been shown.
  async function checkDaily() {
    try {
      if (isMuted()) return;
      let last = 0; try { last = Number(localStorage.getItem(K_CHECK) || 0); } catch { /* ignore */ }
      if (Date.now() - last < DAY) return;
      const out = await api('/api/community/catalog');
      if (!out || !out.ok || !Array.isArray(out.entries)) return;   // offline → retry next load
      await hydrateLimited(out.entries);
      const seen = readSeen();
      const fresh = out.entries.filter((e) => isPaidDrop(e) && !seen.includes(e.id));
      if (!fresh.length) { STAMP(); return; }   // nothing new → don't refetch again today
      presentWhenIdle(fresh);                    // waits its turn behind What's New
    } catch { /* best-effort — never surface an error for a promo nudge */ }
  }

  window.CatalogDrop = { checkDaily, show, close };
  // Staggered a little after the SDK daily check so the two catalog reads don't
  // race the first paint (both hit the same TTL-cached endpoint anyway).
  setTimeout(() => { try { checkDaily(); } catch { /* ignore */ } }, 20000);
})();
