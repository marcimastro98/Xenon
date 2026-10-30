'use strict';
// The month's drops, as letters in Bit's mail (js/bit-mail.js). Each PAID
// creation (a Supporters pack or an available Limited edition) published in the
// last 30 days that this user does not already have becomes one letter, once.
// Bit says one sentence about it when the moment is right; nothing covers the
// screen. Publish A and A arrives; publish B and B arrives.
//
// This used to be a full-screen card each time Xenon started. A popup on
// arrival is the pattern people resent most (NN/g, "Popups: 10 Problematic
// Trends", 2019), so the news now waits in the box until it is opened.
//
// The switch is monthlyDrops (Settings → Aggiornamenti, "Drop del mese"),
// default on; off, no letters are written. The old catalogDrops switch and the
// per-device mute belonged to an older window and stay ignored (2026-09-28).
//
// It reuses the ONE import/purchase boundary: every action funnels into the
// Store (CommunityGallery.openEntry / unlockEntry / openSupporters), so nothing
// here can apply or buy anything on its own. Catalog text stays textContent
// (makeEl), and pictures load from the id-derived assets path, never from
// catalog-supplied URLs.
(function () {
  const el = makeEl;                 // shared DOM factory (textContent-safe) from utils.js
  const api = apiJson;               // shared fetch-JSON helper from utils.js
  const t = (k, fb) => { const v = (typeof window.t === 'function') ? window.t(k) : k; return (v === k && fb != null) ? fb : v; };
  // Same shape the server and the hub accept for an id — checked before an id
  // from the catalog is ever interpolated into a URL.
  const ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;

  // Screenshots are served from the assets host (R2), same as the Store gallery
  // and the website catalog. Must stay in step with SHOTS_BASE in
  // community-gallery.js — a stale host here just leaves the letter without a picture.
  const SHOTS_BASE = 'https://assets.xenon-app.com/community/shots/';
  const DAY = 24 * 3600 * 1000;
  const RECENT = 30 * DAY;            // "the month's drops": published in the last 30 days

  // Does this PC keep a supporter code? A supporter is not sold the membership
  // again: the letter offers Unlock, which uses the saved code.
  let passSaved = false;
  async function readPassSaved() {
    const r = await api('/api/community/supporter');
    if (r && typeof r.saved === 'boolean') passSaved = r.saved;
  }

  const HS = () => { try { return (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : {}; } catch { return {}; } };
  const isOn = () => HS().monthlyDrops !== false;

  // A drop worth a letter = an AVAILABLE limited edition, or a supporters-only /
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

  // "Ends in 3 days" from the entry's real activeUntil, never an invented clock.
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

  function summary(entry) {
    const rt = window.Xenon && window.Xenon.richText;
    const own = entry.description && (rt ? rt.plain(entry.description) : entry.description);
    if (own) return own;
    if (entry.limited) return t('drop_limited_sub', 'A limited-edition drop with a fixed number of copies worldwide. Once they’re gone, it retires for good.');
    return passSaved ? t('drop_supporter_sub_saved', 'A new supporter creation is here. Your saved supporter code unlocks it.')
      : t('drop_supporter_sub', 'A new supporter creation is here. Become a supporter to unlock it, and everything supporters get, forever.');
  }

  // The switch is in Settings, and the letter says where.
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

  // ── The letter ─────────────────────────────────────────────────────────────
  function picture(id) {
    const img = document.createElement('img');
    img.className = 'bitmail-pic';
    img.alt = '';
    img.decoding = 'async';
    const base = SHOTS_BASE + encodeURIComponent(id);
    let triedPng = false;
    img.addEventListener('error', () => {
      if (!triedPng) { triedPng = true; img.src = base + '.png'; return; }
      img.remove();
    });
    img.src = base + '.webp';
    return img;
  }

  // Drawn from the live catalog when opened, so the copies left and the end date
  // are today's, and a drop retired since then says so instead of linking nowhere.
  async function drawLetter(letter, node, ctx) {
    const id = letter.data && letter.data.entryId;
    if (!ID_RE.test(String(id || ''))) return;
    node.insertBefore(picture(id), node.firstChild);
    const wait = el('p', 'bitmail-letter-line', letter.line);
    node.appendChild(wait);
    let entry = null;
    try {
      const out = await api('/api/community/catalog');
      if (out && out.ok && Array.isArray(out.entries)) {
        entry = out.entries.find((e) => e && e.id === id) || null;
        if (entry) { await hydrateLimited([entry]); await readPassSaved(); }
      }
    } catch { /* drawn below as unavailable */ }
    if (!node.isConnected) return;
    if (!entry || !isPaidDrop(entry)) { wait.textContent = t('bitmail_drop_gone', 'This creation is no longer offered in the Store.'); return; }
    wait.textContent = summary(entry);
    const facts = [];
    const stock = entry.limited ? limitedStock(entry.limited) : null;
    if (stock) facts.push(t('gallery_limited_left', '{n} of {t} left').replace('{n}', String(stock.left)).replace('{t}', String(stock.total)));
    const ends = endsText(entry);
    if (ends) facts.push(ends);
    for (const f of facts) node.appendChild(el('p', 'bitmail-letter-line', f));

    const actions = el('div', 'bitmail-actions');
    const isLim = !!entry.limited;
    const unlockSaved = !isLim && passSaved;
    const main = el('button', 'bitmail-btn is-main', isLim ? t('gallery_claim_copy', 'Claim your copy')
      : unlockSaved ? t('gallery_unlock_saved', 'Unlock') : t('gallery_supporters_join', 'Become a supporter'));
    main.type = 'button';
    main.addEventListener('click', () => {
      ctx.close();
      const CG = window.CommunityGallery;
      if (!CG) return;
      if (isLim) CG.openEntry(entry);
      else if (unlockSaved && typeof CG.unlockEntry === 'function') CG.unlockEntry(entry);
      else CG.openSupporters();
    });
    const more = el('button', 'bitmail-btn', t('drop_details', 'See details'));
    more.type = 'button';
    more.addEventListener('click', () => { ctx.close(); if (window.CommunityGallery) window.CommunityGallery.openEntry(entry); });
    actions.append(main, more);
    node.appendChild(actions);
    const off = el('button', 'bitmail-link', t('drop_where_off', 'Turn this off in Settings'));
    off.type = 'button';
    off.addEventListener('click', () => { ctx.close(); openSwitch(); });
    node.appendChild(off);
  }

  // ── When to look ───────────────────────────────────────────────────────────
  // Once per SESSION: when the dashboard opens. A reload of the same tab keeps
  // its sessionStorage, so an Edge that reloads after an update does not ask the
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
  // installed. A letter about something they already have is how a channel
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

  function postLetters(drops) {
    const M = window.BitMail;
    if (!M) return;
    // Limited drops first (their copies run out), then the newest.
    const ordered = drops.filter((e) => e.limited).concat(drops.filter((e) => !e.limited));
    for (const e of ordered) {
      const name = String(e.name || e.id);
      M.post({
        id: 'drop:' + e.id,
        kind: 'drop',
        title: name,
        line: e.limited ? t('gallery_limited_section', 'Limited edition') : t('gallery_supporters_section', 'Supporters'),
        note: (e.limited ? t('bitmail_drop_note_limited', '{name} is out, a limited edition.') : t('bitmail_drop_note', '{name} is out, a new supporter creation.')).replace('{name}', name),
        data: { entryId: e.id },
      });
    }
    // Shared with hub announcements, so one naming the same entry is not a repeat.
    window.XenonInterrupts.markSeen(ordered.map((e) => e.id));
  }

  async function checkOnStart() {
    try {
      if (!isOn() || sessionDone()) return;
      const out = await api('/api/community/catalog');
      if (!out || !out.ok || !Array.isArray(out.entries)) return;        // offline → next look
      await hydrateLimited(out.entries);
      const CW = window.CustomWidget;
      if (CW && typeof CW.getPackages === 'function') { try { await CW.getPackages(); } catch { /* ownership by receipt still works */ } }
      const now = Date.now();
      const drops = out.entries
        .filter((e) => isPaidDrop(e) && isRecent(e, now) && !isOwned(e))
        .sort((a, b) => (Date.parse(b.addedAt) || 0) - (Date.parse(a.addedAt) || 0));
      markSession();
      if (drops.length) postLetters(drops);
    } catch { /* best-effort — never surface an error for a promo */ }
  }

  if (window.BitMail) window.BitMail.register('drop', (letter, node, ctx) => { drawLetter(letter, node, ctx); });
  window.CatalogDrop = { checkOnStart, isRecent, isOwned };
  // Twenty seconds after the dashboard opens (after the SDK daily check, so the
  // two catalog reads do not race the first paint), then a retry every half
  // hour and when the dashboard comes back into view, until the session's one
  // check has succeeded. A chain of timeouts, not setInterval.
  // A layer window would file letters nobody reads there.
  if (typeof isLayerPage === 'function' && isLayerPage()) return;
  const look = () => { try { checkOnStart(); } catch { /* ignore */ } };
  const loop = () => setTimeout(() => { if (sessionDone()) return; look(); loop(); }, LOOK_EVERY);
  setTimeout(() => { look(); loop(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !sessionDone()) look(); });
})();
