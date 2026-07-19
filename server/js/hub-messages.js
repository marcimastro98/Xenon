'use strict';
// Hub messages — the dashboard's side of the announcement channel.
//
// The server proxies a static feed (server/community-messages.js) that every
// install receives WHOLE. Targeting happens here, on this machine, against what
// the dashboard already knows about itself: its version, its platform, its
// language, and which catalog entries it has installed. Nothing is sent to
// receive a targeted message, which is the entire reason the channel is shaped
// this way — see the correlation note in server/version-ping.js. If you ever
// find yourself wanting to POST "what I have" to pick messages server-side, that
// is the thing this design exists to avoid.
//
// Presentation follows catalog-drop.js, which is the house pattern for a
// non-nagging surface: once a day at most, permanent opt-out honoured forever,
// never over another overlay, and every string rendered through makeEl
// (textContent) because this text arrives from a document the dashboard did not
// write. Only `level: 'modal'` takes an interruption slot; a toast does not.
(function () {
  const el = makeEl;                 // shared DOM factory (textContent-safe) from utils.js
  const api = apiJson;               // shared fetch-JSON helper from utils.js
  const t = (k, fb) => { const v = (typeof window.t === 'function') ? window.t(k) : k; return (v === k && fb != null) ? fb : v; };

  // Same local accessor the other settings readers use (installed-manager.js,
  // preset-share.js): `hubSettings` is a global that may not exist yet.
  const HS = () => { try { return (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : {}; } catch { return {}; } };

  const DAY = 24 * 3600 * 1000;
  const K_MUTED = 'xeneonedge.hubMessagesMuted';  // '1' once the user opts out
  const K_CHECK = 'xeneonedge.hubMessageCheck';   // last-check timestamp (daily throttle)

  // Off when the Settings switch says so, or when this device carries the legacy
  // per-device flag from before v4.9.0 (Settings clears that one when you switch
  // announcements back on, so it can never outvote a deliberate "yes").
  const isMuted = () => {
    if (HS().hubMessages === false) return true;
    try { return localStorage.getItem(K_MUTED) === '1'; } catch { return false; }
  };
  // Persist through the normal settings path so the choice follows the user to
  // every surface. The local flag is also written as a fallback: if the save
  // never reaches the server, the mute must still hold on this device.
  const mute = () => {
    try { localStorage.setItem(K_MUTED, '1'); } catch { /* ignore */ }
    try { if (typeof updateHubMessages === 'function') updateHubMessages(false); } catch { /* ignore */ }
  };

  // Catalog entry ids this dashboard has installed. Receipts live in hub
  // settings and record where each install came from; only catalog installs
  // carry a sourceId, which is the entry id the feed's hasEntry names.
  function installedEntryIds() {
    try {
      const raw = HS().contentInstalls;
      const list = (window.ContentInstalls && typeof ContentInstalls.normalizeContentInstalls === 'function')
        ? ContentInstalls.normalizeContentInstalls(raw)
        : (Array.isArray(raw) ? raw : []);
      const out = new Set();
      for (const rec of list) {
        if (rec && rec.source === 'catalog' && typeof rec.sourceId === 'string' && rec.sourceId) out.add(rec.sourceId);
      }
      return out;
    } catch { return new Set(); }
  }

  function uiLang() {
    try {
      const v = (typeof window.currentLang === 'function') ? window.currentLang() : (window.LANG || '');
      return String(v || document.documentElement.lang || 'en').slice(0, 2).toLowerCase();
    } catch { return 'en'; }
  }

  // ── Presentation ───────────────────────────────────────────────────────────
  let overlay = null;
  let onKey = null;
  let msgSeq = 0;   // per-instance ambientFreeze tokens, as in catalog-drop.js

  async function runAction(msg) {
    const a = msg.action;
    if (!a || a.type === 'dismiss') return;
    if (a.type === 'store') {
      // Always through the Store, never applying anything directly — the one
      // import boundary. openEntry wants the catalog entry itself, so resolve
      // the id against the (TTL-cached) catalog; if it has since been retired,
      // open the Store rather than doing nothing.
      if (!window.CommunityGallery) return;
      let entry = null;
      try {
        const cat = await api('/api/community/catalog');
        if (cat && cat.ok && Array.isArray(cat.entries)) {
          entry = cat.entries.find((e) => e && e.id === msg.entryId) || null;
        }
      } catch { /* fall through to the plain Store */ }
      CommunityGallery.openEntry(entry);
      return;
    }
    if (a.type === 'url' && a.url) {
      // Host-allowlisted server-side; opened in the user's browser, never in a tile.
      try { window.open(a.url, '_blank', 'noopener,noreferrer'); } catch { /* popup blocked */ }
    }
  }

  function close(muted) {
    if (!overlay) return;
    if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
    overlay.classList.add('closing');
    const node = overlay; overlay = null;
    setTimeout(() => {
      node.remove();
      if (node._freezeToken && typeof window.ambientFreeze === 'function') window.ambientFreeze(node._freezeToken, false);
    }, 200);
    if (muted && window.XenonToast) {
      window.XenonToast.show({
        type: 'info',
        title: t('hubmsg_muted_toast', 'Done, no more announcements. You can turn them back on in Settings.'),
        duration: 5000,
      });
    }
  }

  function showModal(msg) {
    close();
    const bd = el('div', 'hubmsg-overlay');
    bd._freezeToken = 'hub-message:' + (++msgSeq);
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze(bd._freezeToken, true);

    const card = el('div', 'hubmsg-card');
    const x = el('button', 'hubmsg-close');
    x.type = 'button';
    x.setAttribute('aria-label', t('close', 'Close'));
    x.textContent = '×';
    x.addEventListener('click', () => close());
    card.appendChild(x);

    if (msg.kicker) card.appendChild(el('div', 'hubmsg-kicker', msg.kicker));
    card.appendChild(el('h2', 'hubmsg-title', msg.title));
    if (msg.body) card.appendChild(el('p', 'hubmsg-body', msg.body));

    // A poll replaces the action row: the options ARE the buttons. One tap
    // answers and closes — there is no confirm step, because a second tap to
    // confirm an opinion is friction nobody accepts, and no cancel, because the
    // X and Escape already do that without voting.
    if (msg.poll) {
      const opts = el('div', 'hubmsg-poll');
      msg.poll.options.forEach((opt) => {
        const b = el('button', 'hubmsg-btn ghost', opt.label);
        b.type = 'button';
        b.addEventListener('click', () => { answerPoll(msg, opt.id); });
        opts.appendChild(b);
      });
      card.appendChild(opts);
      // Still offer the permanent opt-out below, same as any other message.
      const offPoll = el('button', 'hubmsg-optout', t('hubmsg_optout', "Don't show announcements"));
      offPoll.type = 'button';
      offPoll.addEventListener('click', () => { mute(); close(true); });
      card.appendChild(offPoll);
      bd.appendChild(card);
      bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
      onKey = (e) => { if (e.key === 'Escape') close(); };
      document.addEventListener('keydown', onKey);
      document.body.appendChild(bd);
      overlay = bd;
      return;
    }

    const actions = el('div', 'hubmsg-actions');
    if (msg.action && msg.action.type !== 'dismiss') {
      const go = el('button', 'hubmsg-btn primary', msg.action.label);
      go.type = 'button';
      go.addEventListener('click', () => { runAction(msg); close(); });
      actions.appendChild(go);
    }
    const later = el('button', 'hubmsg-btn ghost', t('hubmsg_dismiss', 'Close'));
    later.type = 'button';
    later.addEventListener('click', () => close());
    actions.appendChild(later);
    card.appendChild(actions);

    // First-class opt-out, honoured forever — the same promise catalog-drop.js
    // makes. A channel the user cannot switch off is a channel they resent.
    const off = el('button', 'hubmsg-optout', t('hubmsg_optout', "Don't show announcements"));
    off.type = 'button';
    off.addEventListener('click', () => { mute(); close(true); });
    card.appendChild(off);

    bd.appendChild(card);
    bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
    onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(bd);
    overlay = bd;
  }

  // Send one answer, then close. Fire-and-forget on purpose: the vote is worth
  // nothing to the user, so a network failure must not leave them looking at a
  // spinner or an error for an opinion they already gave, and the thank-you is
  // shown either way.
  //
  // Answering records the message as seen straight away rather than relying on
  // the one written when it was displayed. There is only ever one write of that
  // set, so this is belt and braces for the case where the display-time write was
  // lost (storage full or blocked, which markSeen swallows by design) — without
  // it the same poll could be re-shown tomorrow and answered twice.
  function answerPoll(msg, optionId) {
    try { window.XenonInterrupts.markSeen([msg.id]); } catch { /* ignore */ }
    try {
      fetch('/api/community/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: msg.id, optionId }),
      }).catch(() => {});
    } catch { /* ignore */ }
    close();
    if (window.XenonToast) {
      window.XenonToast.show({
        type: 'success',
        title: t('hubmsg_poll_thanks', 'Thanks, your answer was counted.'),
        duration: 4000,
      });
    }
  }

  function showToast(msg) {
    if (!window.XenonToast) return;
    window.XenonToast.show({
      type: 'info',
      kicker: msg.kicker || 'Xenon',
      title: msg.title,
      message: msg.body || '',
      duration: 9000,
      onClick: (msg.action && msg.action.type !== 'dismiss') ? () => runAction(msg) : undefined,
    });
  }

  // ── Daily check ────────────────────────────────────────────────────────────
  const STAMP = () => { try { localStorage.setItem(K_CHECK, String(Date.now())); } catch { /* ignore */ } };

  // A poll is always a modal, whatever the feed declared: its options are
  // buttons, and a toast has nowhere to put them — the question would appear with
  // no way to answer it. Every place that asks "is this a modal?" has to agree,
  // or the choice of which message gets the day's slot depends on feed order.
  const isModalLevel = (m) => m.level === 'modal' || !!m.poll;

  function present(msg) {
    const I = window.XenonInterrupts;
    if (isModalLevel(msg)) {
      I.whenIdle(() => {
        if (isMuted()) return;                  // muted from another surface while waiting
        // Claim the day's interruption slot HERE, not before queueing: another
        // channel may have taken it during the wait, and a slot burned on a modal
        // that never appeared is a slot the user never got to see used.
        if (!I.claimDaily('hub-messages')) return;
        showModal(msg);
        // Marked seen only once it is actually on screen. Recording it at queue
        // time loses the announcement for good when the wait expires (game mode
        // for five minutes is enough) — the same failure catalog-drop.js documents
        // at its own markSeen call.
        I.markSeen([msg.id]);
      }, { priority: I.PRIORITY.message });
      return;
    }
    // Toasts do not interrupt: they stack in the corner and expire on their own,
    // so they are on screen the moment this returns.
    showToast(msg);
    I.markSeen([msg.id]);
  }

  async function checkDaily() {
    try {
      if (isMuted()) return;
      let last = 0; try { last = Number(localStorage.getItem(K_CHECK) || 0); } catch { /* ignore */ }
      if (Date.now() - last < DAY) return;

      const out = await api('/api/community/messages');
      if (!out || !out.ok || !Array.isArray(out.messages)) return;   // offline → retry next load

      const I = window.XenonInterrupts;
      const ctx = {
        version: (out.context && out.context.version) || '',
        os: (out.context && out.context.os) || '',
        lang: uiLang(),
        installed: installedEntryIds(),
      };

      // Anything already announced by ANY channel is skipped: the shared set is
      // why a hub note about a drop cannot repeat what the drop modal showed.
      // Read once into a Set — hasSeen re-parses the stored list on every call,
      // and this asks twice per message.
      const seen = new Set(I.readSeen());
      const fresh = out.messages.filter((m) => HubMatch.matches(m, ctx) && !seen.has(m.id) && !(m.entryId && seen.has(m.entryId)));
      if (!fresh.length) { STAMP(); return; }   // nothing for us → don't refetch today

      STAMP();
      // At most ONE modal, and it goes first so the day's interruption is spent
      // on the loudest thing there is. Any other modal-shaped message waits for
      // another day rather than degrading to a toast: it was declared important,
      // and a poll has nowhere to put its buttons in a toast anyway.
      const modal = fresh.find(isModalLevel);
      if (modal) present(modal);
      for (const m of fresh) {
        if (m === modal || m.level === 'banner' || isModalLevel(m)) continue;
        present(m);
      }
    } catch { /* best-effort — never surface an error for an announcement */ }
  }

  // ── Local testing seams ────────────────────────────────────────────────────
  // Underscore-prefixed like the server modules' _setTransport/_resetCache: not
  // part of the feature, just the only way to see this channel without
  // publishing to the live site first. Both take data you typed yourself, so
  // they bypass the feed and its validation on purpose — what they exercise is
  // the matching and the rendering, which is the part with the bugs.
  //
  //   HubMessages._preview({level:'modal', title:'Hi', body:'…'})
  //   HubMessages._simulate({messages:[…]})   → what WOULD be shown, and shows it
  function _preview(msg) {
    const m = Object.assign({ id: 'preview', level: 'modal', title: 'Preview' }, msg || {});
    if (m.level === 'modal' || m.poll) showModal(m); else showToast(m);
    return m;
  }

  // Runs the real selection path (match → dedup → present) against a feed you
  // supply, ignoring the once-a-day throttle so it can be run repeatedly.
  // Returns what matched, so a filter can be checked without waiting to see it.
  function _simulate(feed, ctxOver) {
    const messages = (feed && feed.messages) || [];
    const ctx = Object.assign({
      version: (feed && feed.context && feed.context.version) || '',
      os: (feed && feed.context && feed.context.os) || '',
      lang: uiLang(),
      installed: installedEntryIds(),
    }, ctxOver || {});
    const matched = messages.filter((m) => HubMatch.matches(m, ctx));
    const modal = matched.find((m) => m.level === 'modal' || m.poll);
    if (modal) _preview(modal);
    matched.forEach((m) => { if (m !== modal && m.level !== 'banner') showToast(m); });
    return { ctx: { version: ctx.version, os: ctx.os, lang: ctx.lang, installed: [...ctx.installed] }, matched, skipped: messages.filter((m) => !matched.includes(m)) };
  }

  window.HubMessages = { checkDaily, close, _preview, _simulate };
  // After catalog-drop's own check, so the paid-drop modal gets first claim on
  // the day's interruption slot: a limited edition running out of copies is more
  // time-critical than an announcement.
  setTimeout(() => { try { checkDaily(); } catch { /* ignore */ } }, 35000);
})();
