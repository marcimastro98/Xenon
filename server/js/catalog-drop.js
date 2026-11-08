'use strict';
// The month's drops, as Bit's messages (js/bit-messages.js). Each PAID creation (a
// Supporters pack or an available Limited edition) published in the last 30 days
// that this user does not already have becomes one message, once, and takes its
// turn: at most one a day, when nothing is going on. Publish A and A arrives;
// publish B and B arrives.
//
// This used to be a full-screen card each time Xenon started. A popup on
// arrival is the pattern people resent most (NN/g, "Popups: 10 Problematic
// Trends", 2019), so the news now waits in the corner.
//
// The switch is monthlyDrops (Settings → Aggiornamenti, "Drop del mese"),
// default on; off, nothing is filed. The old catalogDrops switch and the
// per-device mute belonged to an older window and stay ignored (2026-09-28).
//
// It reuses the ONE import/purchase boundary: the button opens the entry in the
// Store, which has the Unlock and Claim buttons, so nothing here can apply or buy
// anything on its own. Pictures load from the id-derived assets path, never from
// catalog-supplied URLs.
(function () {
  const api = apiJson;               // shared fetch-JSON helper from utils.js
  const t = (k, fb) => { const v = (typeof window.t === 'function') ? window.t(k) : k; return (v === k && fb != null) ? fb : v; };
  // Same shape the server and the hub accept for an id: checked before an id from
  // the catalog is ever interpolated into a URL.
  const ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;

  // Screenshots are served from the assets host (R2), same as the Store gallery
  // and the website catalog. Must stay in step with SHOTS_BASE in
  // community-gallery.js: a stale host here just leaves the card without a picture.
  const SHOTS_BASE = 'https://assets.xenon-app.com/community/shots/';
  const DAY = 24 * 3600 * 1000;
  const RECENT = 30 * DAY;            // "the month's drops": published in the last 30 days

  // Does this PC keep a supporter code? A supporter is not sold the membership
  // again: the words say the saved code unlocks it.
  let passSaved = false;
  async function readPassSaved() {
    const r = await api('/api/community/supporter');
    if (r && typeof r.saved === 'boolean') passSaved = r.saved;
  }

  const HS = () => { try { return (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : {}; } catch { return {}; } };
  const isOn = () => HS().monthlyDrops !== false;

  // A drop worth a message = an AVAILABLE limited edition, or a supporters-only /
  // locked creation. Free community items never get one. `active:false` from the
  // live status = the hub has closed the drop: nobody can claim a copy.
  function isPaidDrop(e) {
    if (!e || !e.id) return false;
    // Stock through limitedStock(): `soldOut` is added by the server proxy.
    if (e.limited) { const s = limitedStock(e.limited); return !!s && !s.soldOut && e.limited.active !== false; }
    return !!(e.locked || e.supportersOnly);
  }

  // catalog.json freezes the stock at publish time; the hub is the only thing
  // that knows how many copies are left. Best-effort: no answer keeps the
  // published numbers.
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

  function summary(entry) {
    const rt = window.Xenon && window.Xenon.richText;
    const own = entry.description && (rt ? rt.plain(entry.description) : entry.description);
    if (own) return own;
    if (entry.limited) return t('drop_limited_sub', 'A limited-edition drop with a fixed number of copies worldwide. Once they’re gone, it retires for good.');
    return passSaved ? t('drop_supporter_sub_saved', 'A new supporter creation is here. Your saved supporter code unlocks it.')
      : t('drop_supporter_sub', 'A new supporter creation is here. Become a supporter to unlock it: what you unlock stays yours.');
  }

  // The switch is in Settings, and the card says where.
  function openSwitch() {
    if (typeof window.openSettings !== 'function') return;
    window.openSettings('general');
    requestAnimationFrame(() => {
      const row = document.getElementById('settings-monthly-drops');
      const line = row && row.closest('.settings-toggle-row');
      if (!line) return;
      line.scrollIntoView({ block: 'center' });
      line.classList.remove('settings-search-flash');
      void line.offsetWidth;
      line.classList.add('settings-search-flash');
      setTimeout(() => line.classList.remove('settings-search-flash'), 2600);
    });
  }

  // ── When to look ───────────────────────────────────────────────────────────
  // Once per SESSION: when the page opens. A reload of the same tab keeps its
  // sessionStorage, so an Edge that reloads after an update does not ask the
  // catalog again. A check that could not reach the catalog (offline) tries
  // again later in the same session.
  const K_SESSION = 'xeneonedge.monthlyDropsSession';
  const sessionDone = () => { try { return sessionStorage.getItem(K_SESSION) === '1'; } catch { return false; } };
  const markSession = () => { try { sessionStorage.setItem(K_SESSION, '1'); } catch { /* ignore */ } };
  const LOOK_EVERY = 30 * 60 * 1000;   // retry while the first check has not succeeded

  // Published in the last 30 days and not over.
  function isRecent(e, now) {
    const at = Date.parse(e && e.addedAt ? e.addedAt : '');
    if (!Number.isFinite(at) || now - at > RECENT || at - now > DAY) return false;
    const until = e.activeUntil ? Date.parse(e.activeUntil) : NaN;
    return !(Number.isFinite(until) && until <= now);
  }

  // Already this user's: installed from the Store (its receipt names the entry,
  // or one copy of a numbered drop), or a widget the entry publishes is
  // installed. A message about something they already have is how a channel
  // like this gets switched off.
  function isOwned(e) {
    const receipts = Array.isArray(HS().contentInstalls) ? HS().contentInstalls : [];
    const dropId = e && e.limited && e.limited.dropId ? String(e.limited.dropId) : '';
    if (receipts.some((r) => r && r.source === 'catalog' && r.sourceId
      && (r.sourceId === e.id || (dropId && String(r.sourceId).startsWith(dropId + '-'))))) return true;
    const CW = window.CustomWidget;
    const pkgs = CW && typeof CW.cachedPackages === 'function' ? CW.cachedPackages() : [];
    return !!(e.pkgId && pkgs.some((p) => p && p.id === e.pkgId));
  }

  function messageFor(e) {
    const until = Date.parse(e.activeUntil || '');
    return {
      id: 'drop:' + e.id,
      kind: 'drop',
      title: String(e.name || e.id),
      line: e.limited ? t('gallery_limited_section', 'Limited edition') : t('gallery_supporters_section', 'Supporters'),
      body: summary(e),
      entryId: e.id,
      media: { type: 'image', url: SHOTS_BASE + encodeURIComponent(e.id) + '.webp', alt: '' },
      action: { type: 'store', label: t('bm_store_open', 'Open in the Store') },
      expires: Number.isFinite(until) ? until : undefined,
    };
  }

  async function checkOnStart() {
    try {
      if (!isOn() || sessionDone() || !window.BitMessages) return;
      const out = await api('/api/community/catalog');
      if (!out || !out.ok || !Array.isArray(out.entries)) return;        // offline → next look
      await hydrateLimited(out.entries);
      await readPassSaved();
      const CW = window.CustomWidget;
      if (CW && typeof CW.getPackages === 'function') { try { await CW.getPackages(); } catch { /* ownership by receipt still works */ } }
      const now = Date.now();
      const drops = out.entries
        .filter((e) => ID_RE.test(String(e && e.id)) && isPaidDrop(e) && isRecent(e, now) && !isOwned(e))
        .sort((a, b) => (Date.parse(b.addedAt) || 0) - (Date.parse(a.addedAt) || 0));
      // Limited drops first (their copies run out), then the newest. A drop that
      // sold out or was bought since is taken back if still unread.
      const ordered = drops.filter((e) => e.limited).concat(drops.filter((e) => !e.limited));
      const filed = await window.BitMessages.file(ordered.map(messageFor), { drop: ordered.map((e) => 'drop:' + e.id) });
      if (filed) markSession();
    } catch { /* best-effort: never surface an error for a promo */ }
  }

  window.CatalogDrop = { checkOnStart, isRecent, isOwned, openSwitch };
  // Twenty seconds after the page opens (after the SDK daily check, so the two
  // catalog reads do not race the first paint), then a retry every half hour and
  // when the page comes back into view, until the session's one check has
  // succeeded. A chain of timeouts, not setInterval. A layer window shows no messages.
  if (window.BitMessages && window.BitMessages.surface !== 'screen' && typeof isLayerPage === 'function' && isLayerPage()) return;
  const look = () => { try { checkOnStart(); } catch { /* ignore */ } };
  const loop = () => setTimeout(() => { if (sessionDone()) return; look(); loop(); }, LOOK_EVERY);
  setTimeout(() => { look(); loop(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !sessionDone()) look(); });
})();
