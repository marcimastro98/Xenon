'use strict';
// The 7-day supporter-pass trial on this screen. The server side (trial-pass.js)
// keeps the code and the hub's last word; this file acts on it:
//
//   - while the trial runs: one reminder a day in its last two days;
//   - when it ends: takes off what the trial installed (receipts marked `trial`,
//     see preset-share.js), keeps the tiles where they were, puts the theme from
//     before the trial back, and says what was used and how to keep it;
//   - after a conversion: unmarks what is still installed and offers to put
//     back what was taken off.
//
// Several screens can notice the end at once; the server lets only the first
// one claim the clean-up (POST /api/community/trial/tried with end: true). A
// screen that finds trial content left after a claim (it closed mid-way)
// finishes the job. Everything shown is built with textContent.
(function () {
  const DAY = 24 * 3600 * 1000;
  // The hub's rule (trial-redeem.js trialCovers): a drop joins the trial after
  // its first 30 days, unless the catalog says 'now' or 'never'. A Sparks-only
  // drop is never in it. The catalog date is a hint for the button; the hub decides.
  const FRESH_MS = 30 * DAY;
  const NEVER_IN_TRIAL = new Set(['feature-devclean']);
  const REMIND_WITHIN_MS = 2 * DAY;

  // Pure: may the trial open this catalog entry?
  function covers(entry, now) {
    if (!entry || entry.limited || !(entry.locked || entry.supportersOnly)) return false;
    if (NEVER_IN_TRIAL.has(entry.id) || entry.trial === 'never') return false;
    if (entry.sparks > 0 && !entry.supportersOnly) return false;
    if (entry.trial === 'now' || String(entry.id || '').startsWith('feature-')) return true;
    const added = Date.parse(String(entry.addedAt || ''));
    return Number.isFinite(added) && (now || Date.now()) - added >= FRESH_MS;
  }

  // Pure: what the trial installed, for the server's record and the end card.
  // `assign` is sdkWidgets.assign (tile → package), so a conversion can tell
  // which tiles wait for which widget.
  function triedFrom(records, assign) {
    const map = assign && typeof assign === 'object' ? assign : {};
    const out = [];
    for (const rec of records || []) {
      if (!rec || rec.trial !== true || !rec.sourceId) continue;
      if (out.some((t) => t.entryId === rec.sourceId)) continue;
      const widgetIds = (rec.resources && Array.isArray(rec.resources.widgetIds)) ? rec.resources.widgetIds.slice() : [];
      const tiles = Object.keys(map).filter((k) => widgetIds.includes(map[k]));
      out.push({ entryId: rec.sourceId, name: rec.name || '', kind: rec.kind || '', widgetIds, tiles });
    }
    return out;
  }

  // Pure: the theme that was on before the first trial install.
  function restoreThemeFor(records) {
    const first = (records || [])
      .filter((r) => r && r.trial === true && r.prevThemeId)
      .sort((a, b) => (a.installedAt || 0) - (b.installedAt || 0))[0];
    return first ? first.prevThemeId : '';
  }

  // Pure: the tile state for a widget the trial took off, or null.
  // `supporter`: a pass is saved here, so the tile offers to put it back.
  function endedTile(status, pkgId, supporter) {
    if (!status || !pkgId || !(status.state === 'ended' || status.state === 'converted')) return null;
    const hit = (status.tried || []).find((t) => Array.isArray(t.widgetIds) && t.widgetIds.includes(pkgId));
    if (!hit) return null;
    return { entryId: hit.entryId, name: hit.name, canPutBack: status.state === 'converted' || !!supporter };
  }

  // Pure: the receipts with the trial mark taken off (after a conversion).
  function unmarked(records) {
    return (records || []).map((r) => {
      if (!r || r.trial !== true) return r;
      const { trial, prevThemeId, ...rest } = r;
      return rest;
    });
  }

  // Built-in features are not Store entries, so they have no Store pictures:
  // the website's own picture of each stands in.
  const FEATURE_PICTURES = {
    'feature-lyrics': 'https://xenon-app.com/images/home/lyrics-widget.webp',
  };

  // Pure: what the end card pictures, one per tried entry, with the Store's
  // picture count (0 = the kind's icon instead) or a feature's own picture.
  // Seeing what you had is what makes keeping it worth paying for (endowment
  // effect), so names alone are the fallback, not the card.
  function endCardItems(tried, entries) {
    const byId = new Map((Array.isArray(entries) ? entries : []).filter((e) => e && e.id).map((e) => [e.id, e]));
    const out = [];
    for (const x of Array.isArray(tried) ? tried : []) {
      if (!x || !x.name || !x.entryId || out.some((o) => o.entryId === x.entryId)) continue;
      const entry = byId.get(x.entryId);
      out.push({
        entryId: x.entryId, name: x.name, kind: (entry && entry.kind) || x.kind || '',
        shots: (entry && Number(entry.shots)) || 0, picture: FEATURE_PICTURES[x.entryId] || '',
      });
    }
    return out;
  }

  const HUB_TRIAL_URL = 'https://xenon-supporter-hub.xenonedge.workers.dev/trial';
  // Pure: the hub's trial page in the app's language. The hub speaks the site's
  // 7 languages and falls back on its own for the others.
  function trialPageUrl(code) {
    const base = String(code || '').toLowerCase().slice(0, 2);
    return /^[a-z]{2}$/.test(base) ? HUB_TRIAL_URL + '?lang=' + base : HUB_TRIAL_URL;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { covers, triedFrom, restoreThemeFor, endedTile, unmarked, endCardItems, trialPageUrl };
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const BMC_MEMBERSHIP = 'https://www.buymeacoffee.com/marcimastro98/membership';
  const K_REMIND_DAY = 'xeneonedge.trialRemindDay';
  const K_END_SHOWN = 'xeneonedge.trialEndShown';
  const K_WELCOME_SHOWN = 'xeneonedge.trialWelcomeShown';
  const ACTIVE_RECHECK_MS = 6 * 3600 * 1000;
  const PAUSED_RECHECK_MS = 3600 * 1000;
  const BOOT_DELAY_MS = 8000;

  const t = (k, fb) => { const v = (typeof window.t === 'function') ? window.t(k) : k; return (v === k && fb != null) ? fb : v; };
  const HS = () => { try { return (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : {}; } catch { return {}; } };
  const origin = () => (typeof SERVER === 'string' ? SERVER : '');
  const hydrated = () => { try { return typeof _hubHydratedFromServer !== 'undefined' && _hubHydratedFromServer === true; } catch { return false; } };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window: shown again next time */ } },
  };

  let status = null;
  let supporterSaved = false;
  let timer = null;
  let busy = false;

  async function call(path, body) {
    try {
      const res = await fetch(origin() + path, body === undefined ? undefined : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return await res.json();
    } catch { return null; }
  }

  function dateText(ms) {
    // `lang` is settings.js's shared-scope UI language.
    const code = (typeof lang === 'string') ? lang : '';
    try { return new Date(ms).toLocaleDateString(code || undefined, { day: 'numeric', month: 'long' }); }
    catch { return new Date(ms).toLocaleDateString(); }
  }

  function openLink(url) { try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* popup blocked */ } }
  function supportUrl(source) {
    const c = window.Xenon && window.Xenon.constants;
    return (c && typeof c.supportUrl === 'function') ? c.supportUrl(source) : BMC_MEMBERSHIP;
  }
  const openTry = () => openLink(trialPageUrl(typeof lang === 'string' ? lang : ''));
  const openSupport = (source) => openLink(supportUrl(source || 'trial-end'));
  function openCodeField() {
    if (typeof window.openSettings === 'function') window.openSettings('sdk');
    const field = document.getElementById('settings-supporter-code');
    if (field && !field.hidden) { try { field.focus(); } catch { /* not focusable yet */ } }
  }

  // The Store entry for `entryId`, opened on its unlock dialog: with a saved pass
  // the field can stay empty, and the reinstalled widget lands on its old tiles.
  async function putBack(entryId) {
    const out = await call('/api/community/catalog');
    const entry = out && Array.isArray(out.entries) ? out.entries.find((e) => e && e.id === entryId) : null;
    if (!window.CommunityGallery) return;
    if (entry) window.CommunityGallery.unlockEntry(entry);
    else window.CommunityGallery.open();
  }

  const trialReceipts = () => (Array.isArray(HS().contentInstalls) ? HS().contentInstalls : []).filter((r) => r && r.trial === true);

  function schedule(ms) {
    if (timer) clearTimeout(timer);
    timer = ms > 0 ? setTimeout(() => { timer = null; refresh(); }, Math.min(ms, 2147483000)) : null;
  }

  function repaintTiles() {
    if (window.CustomWidget && typeof window.CustomWidget.refreshPackages === 'function') window.CustomWidget.refreshPackages();
    if (window.CustomWidget && typeof window.CustomWidget.renderWidgets === 'function') window.CustomWidget.renderWidgets();
  }

  function remindIfClose() {
    const left = status.endsAt - Date.now();
    if (!(left > 0 && left <= REMIND_WITHIN_MS)) return;
    const today = new Date().toDateString();
    if (store.get(K_REMIND_DAY) === today) return;
    store.set(K_REMIND_DAY, today);
    if (window.XenonToast) {
      window.XenonToast.show({
        type: 'info',
        title: t('trial_remind_title', 'Your pass trial ends on {date}').replace('{date}', dateText(status.endsAt)),
        message: t('trial_remind_body', 'What you installed with it comes off then. Supporters keep it.'),
        duration: 8000,
      });
    }
  }

  // ── End of the trial ────────────────────────────────────────────────
  async function takeOff(records) {
    const restoreThemeId = restoreThemeFor(records);
    // Newest first, so the theme from before the trial is what stays on.
    const order = records.slice().sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0));
    for (const rec of order) {
      try {
        await window.PresetShare.uninstallContent(rec, { skipConfirm: true, keepTiles: true, restoreThemeId });
      } catch (e) { console.warn('trial: could not take off', rec.name || rec.id, e); }
    }
    repaintTiles();
  }

  async function finishTrial() {
    const records = trialReceipts();
    if (records.length && window.PresetShare && typeof window.PresetShare.uninstallContent === 'function') {
      const leftover = status.endDone === true;
      if (!leftover) {
        const known = new Set((status.tried || []).map((x) => x.entryId));
        const tried = (status.tried || []).concat(triedFrom(records, (HS().sdkWidgets || {}).assign).filter((x) => !known.has(x.entryId)));
        const claim = await call('/api/community/trial/tried', { tried, end: true });
        if (!claim || claim.ok !== true) return;      // offline: try again on the next look
        status = claim;
        if (!claim.claimed) return;                   // another screen is taking it off
      }
      await takeOff(records);
    }
    // A pass is saved here (typed during the trial, or a conversion the hub has
    // not linked yet): offer to put things back with it instead of the pitch.
    // The saved code alone proves nothing, so the content still came off and
    // goes back only through a redeem the hub accepts.
    if (supporterSaved) showWelcome(Array.isArray(HS().contentInstalls) ? HS().contentInstalls : []);
    else await showEndCard();
  }

  // The Store picture of a tried entry, or its kind's icon when there is none
  // (or it fails to load), so the grid never shows a hole.
  function picture(item) {
    const gallery = window.CommunityGallery;
    const box = document.createElement('span');
    box.className = 'trial-end-pic';
    const glyph = () => {
      box.replaceChildren();
      box.classList.add('is-glyph');
      if (gallery && typeof gallery.kindIcon === 'function') box.appendChild(gallery.kindIcon(item.kind));
    };
    const shots = item.shots && gallery && typeof gallery.shotUrl === 'function';
    if (!shots && !item.picture) { glyph(); return box; }
    const img = document.createElement('img');
    img.alt = ''; img.decoding = 'async';
    let triedPng = !shots;
    img.addEventListener('error', () => {
      if (!triedPng) { triedPng = true; img.src = gallery.shotUrl(item.entryId, 1, 'png'); return; }
      glyph();
    });
    img.src = shots ? gallery.shotUrl(item.entryId, 1, 'webp') : item.picture;
    box.appendChild(img);
    return box;
  }

  // What was used, in pictures, and one way to keep it. The code and "not now"
  // stay reachable as quiet links, so the card asks for one decision.
  async function showEndCard() {
    const key = String(status.endsAt || '');
    if (store.get(K_END_SHOWN) === key || !window.PresetShare || typeof window.PresetShare.buildModal !== 'function') return;
    store.set(K_END_SHOWN, key);
    const catalog = (status.tried || []).length ? await call('/api/community/catalog') : null;
    const items = endCardItems(status.tried, catalog && catalog.entries);
    const { body, close } = window.PresetShare.buildModal(t('trial_end_title', 'Your 7-day trial has ended'));
    const el = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls; if (text != null) n.textContent = text; return n; };
    const p = (cls, text) => body.appendChild(el('p', cls, text));
    if (items.length) {
      p('preset-modal-desc', t('trial_end_used', 'In these 7 days you used:'));
      const grid = el('ul', 'trial-end-gets');
      for (const item of items) {
        const li = el('li', '');
        li.appendChild(picture(item));
        li.appendChild(el('span', 'trial-end-name', item.name));
        grid.appendChild(li);
      }
      body.appendChild(grid);
      p('preset-modal-desc', t('trial_end_back', 'They are off this PC now, and your tiles kept their place. Become a supporter and they come back right there, along with every supporter drop.'));
    } else {
      p('preset-modal-desc', t('trial_end_none', 'Thanks for trying the supporter pass. Supporters get every supporter drop, Lyrics included.'));
    }
    if (window.XenonCredits) body.appendChild(window.XenonCredits.offerLine(t('support_sparks_also', "Every month you also get 300 Sparks, Xenon's credits."), 'preset-modal-desc'));
    const keep = el('button', 'settings-btn primary trial-end-keep', items.length
      ? t('trial_keep', 'Keep them, 5 USD a month')
      : t('trial_support', 'Become a supporter'));
    keep.type = 'button';
    keep.addEventListener('click', () => { openSupport('trial-end'); close(); });
    body.appendChild(keep);
    p('preset-modal-desc trial-end-price', items.length
      ? t('trial_end_cancel', 'On Buy Me a Coffee. You can cancel anytime.')
      : t('trial_end_price', 'Memberships start at 5 USD a month on Buy Me a Coffee, and you can cancel anytime.'));
    const links = el('div', 'trial-end-links');
    const link = (label, onClick) => {
      const b = el('button', 'trial-end-link', label);
      b.type = 'button';
      b.addEventListener('click', onClick);
      links.appendChild(b);
    };
    link(t('trial_have_code', 'I have a code'), () => { close(); openCodeField(); });
    link(t('trial_not_now', 'Not now'), close);
    body.appendChild(links);
  }

  // ── After a conversion ──────────────────────────────────────────────
  function keepAfterConversion() {
    const records = Array.isArray(HS().contentInstalls) ? HS().contentInstalls : [];
    if (records.some((r) => r && r.trial === true) && typeof normalizeSettings === 'function') {
      hubSettings = normalizeSettings(Object.assign({}, HS(), { contentInstalls: unmarked(records) }));
      if (typeof saveHubSettings === 'function') saveHubSettings();
    }
    showWelcome(records);
  }

  // "Put it back" for each tried entry that is not on this PC any more.
  function showWelcome(records) {
    const installedIds = new Set(records.map((r) => r && r.sourceId).filter(Boolean));
    const missing = (status.tried || []).filter((x) => !installedIds.has(x.entryId));
    if (!missing.length) return;
    const key = String(status.endsAt || '');
    if (store.get(K_WELCOME_SHOWN) === key || !window.PresetShare || typeof window.PresetShare.buildModal !== 'function') return;
    store.set(K_WELCOME_SHOWN, key);
    const { body, close } = window.PresetShare.buildModal(t('trial_welcome_title', 'Thank you for supporting Xenon'));
    const lead = document.createElement('p');
    lead.className = 'preset-modal-desc';
    lead.textContent = t('trial_welcome_lead', 'Your supporter code is saved on this PC. Put back what you tried:');
    body.appendChild(lead);
    for (const item of missing) {
      const line = document.createElement('div');
      line.className = 'preset-unlock-saved trial-welcome-row';
      const name = document.createElement('span');
      name.textContent = item.name || item.entryId;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'settings-btn primary preset-unlock-forget';
      b.textContent = t('trial_put_back', 'Put it back');
      b.addEventListener('click', () => { close(); putBack(item.entryId); });
      line.appendChild(name); line.appendChild(b);
      body.appendChild(line);
    }
  }

  // ── State ───────────────────────────────────────────────────────────
  async function apply(next) {
    if (!next || next.ok !== true) return;
    status = next;
    try { window.dispatchEvent(new CustomEvent('xenon-trial-changed', { detail: { state: status.state } })); } catch { /* old engine */ }
    if (status.state === 'active') {
      remindIfClose();
      schedule(Math.min(ACTIVE_RECHECK_MS, status.endsAt - Date.now() + 15000));
      return;
    }
    if (status.state === 'unverified') { schedule(PAUSED_RECHECK_MS); return; }
    if (status.state === 'none') { await tidyOrphans(); return; }
    // Ended: look once a day, so a conversion on another device is noticed here.
    schedule(status.state === 'ended' ? DAY : 0);
    if (status.state !== 'ended' && status.state !== 'converted') return;
    // Receipts must be the server's, not a pre-hydrate local copy, before
    // anything is taken off or unmarked.
    if (!hydrated()) { setTimeout(() => apply(status), 3000); return; }
    if (busy) return;
    busy = true;
    try {
      if (status.state === 'ended') await finishTrial();
      // Converted is the hub's word, and the code it handed over is what makes
      // the content the user's: until that pass is saved here, change nothing.
      else if (supporterSaved) keepAfterConversion();
    } finally { busy = false; }
    repaintTiles();
  }

  // Content marked as trial with no trial on this install: the trial file was
  // deleted (or lost). It is still trial content, so it comes off. Asked again
  // right before, so a trial that started on another screen meanwhile is never
  // mistaken for a missing one.
  async function tidyOrphans() {
    if (!trialReceipts().length) return;
    if (!hydrated()) { setTimeout(() => apply(status), 3000); return; }
    if (busy) return;
    busy = true;
    try {
      const now = await call('/api/community/trial');
      if (!now || now.ok !== true || now.state !== 'none') return;
      const records = trialReceipts();
      if (!records.length || !window.PresetShare || typeof window.PresetShare.uninstallContent !== 'function') return;
      await takeOff(records);
      await showEndCard();
    } finally { busy = false; }
  }

  // The hub's latest word (the server asks it at most every 10 minutes).
  async function refresh() {
    const [next, sup] = await Promise.all([call('/api/community/trial/check', {}), call('/api/community/supporter')]);
    supporterSaved = !!(sup && sup.saved);
    await apply(next);
    return status;
  }

  async function boot() {
    const first = await call('/api/community/trial');
    if (!first || first.ok !== true) return;
    status = first;
    if (first.state === 'none') { await apply(first); return; }
    await refresh();
  }

  window.addEventListener('pagehide', () => schedule(0));
  setTimeout(boot, BOOT_DELAY_MS);

  window.TrialPass = {
    covers, dateText, openTry, openSupport, openCodeField, putBack, refresh,
    status: () => status,
    endedWidget: (pkgId) => endedTile(status, pkgId, supporterSaved),
  };
})();
