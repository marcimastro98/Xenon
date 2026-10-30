'use strict';
// Hub messages — the dashboard's side of the announcement channel, filed as
// letters in Bit's mail (js/bit-mail.js) instead of opening a modal.
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
// A letter stores only the message id, its title and a summary. Opening it reads
// the feed again, so the picture, the button and a poll come from the validated
// feed (never from localStorage, which anyone can edit), and a message the hub
// has since withdrawn shows as the summary alone. Every string is rendered
// through makeEl (textContent) because it arrives from a document the dashboard
// did not write. A permanent opt-out sits in every letter.
(function () {
  const el = makeEl;                 // shared DOM factory (textContent-safe) from utils.js
  const api = apiJson;               // shared fetch-JSON helper from utils.js
  const t = (k, fb) => { const v = (typeof window.t === 'function') ? window.t(k) : k; return (v === k && fb != null) ? fb : v; };

  // Same local accessor the other settings readers use (installed-manager.js,
  // preset-share.js): `hubSettings` is a global that may not exist yet.
  const HS = () => { try { return (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : {}; } catch { return {}; } };

  const CHECK_EVERY = 3 * 3600 * 1000;   // how often it asks for the feed while open
  const K_MUTED = 'xeneonedge.hubMessagesMuted';  // '1' once the user opts out
  const K_CHECK = 'xeneonedge.hubMessageCheck';   // last-check timestamp
  const LINE_MAX = 240;

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

  // ── Media ──────────────────────────────────────────────────────────────────
  // The host allowlist and the type/extension agreement are settled server-side
  // (community-messages.js); by the time a media block reaches here it is one of
  // exactly two shapes. A fixed aspect box so the letter does not jump when the
  // file lands, and a clip that plays like a GIF — muted, looping, inline, no
  // controls — because it is decoration.
  function mediaNode(media) {
    if (!media || !media.url) return null;
    const frame = el('div', 'bitmail-media');
    let node;
    if (media.type === 'video') {
      // A reader who asked the system for less motion gets the still frame.
      let still = false;
      try { still = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { /* assume motion is fine */ }
      node = document.createElement('video');
      node.src = media.url;
      node.muted = true;
      node.loop = !still;
      node.autoplay = !still;
      node.playsInline = true;
      node.preload = 'metadata';
      node.setAttribute('aria-hidden', 'true');
      if (media.poster) node.poster = media.poster;
      if (!still) {
        try { const p = node.play(); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ }
      }
    } else {
      node = document.createElement('img');
      node.src = media.url;
      node.alt = media.alt || '';
      node.decoding = 'async';
    }
    // A file that never arrives must not leave an empty framed box above the text.
    node.addEventListener('error', () => { frame.remove(); }, { once: true });
    frame.appendChild(node);
    return frame;
  }

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

  // Send one answer. Fire-and-forget on purpose: the vote is worth nothing to
  // the user, so a network failure must not leave them looking at an error for
  // an opinion they already gave, and the thank-you is shown either way.
  function answerPoll(msg, optionId, ctx) {
    try {
      fetch('/api/community/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: msg.id, optionId }),
      }).catch(() => {});
    } catch { /* ignore */ }
    try { localStorage.setItem('xeneonedge.pollAnswered.' + msg.id, '1'); } catch { /* ignore */ }
    ctx.close();
    if (window.XenonToast) {
      window.XenonToast.show({
        type: 'success',
        important: true,               // the answer to the user's own tap
        title: t('hubmsg_poll_thanks', 'Thanks, your answer was counted.'),
        duration: 4000,
      });
    }
  }
  const pollAnswered = (id) => { try { return localStorage.getItem('xeneonedge.pollAnswered.' + id) === '1'; } catch { return false; } };

  // ── The letter ─────────────────────────────────────────────────────────────
  // Draws a message from the feed into an opened letter. `ctx` is Bit's mail's
  // { close, remove }.
  function drawMessage(msg, node, ctx) {
    const media = mediaNode(msg.media);
    if (media) node.insertBefore(media, node.firstChild);
    if (msg.body) node.appendChild(el('p', 'bitmail-letter-line', msg.body));
    const actions = el('div', 'bitmail-actions');
    // A poll: the options ARE the buttons, one tap answers. Asked once.
    if (msg.poll && Array.isArray(msg.poll.options) && !pollAnswered(msg.id)) {
      msg.poll.options.forEach((opt) => {
        const b = el('button', 'bitmail-btn', opt.label);
        b.type = 'button';
        b.addEventListener('click', () => answerPoll(msg, opt.id, ctx));
        actions.appendChild(b);
      });
    } else if (msg.action && msg.action.type !== 'dismiss' && msg.action.label) {
      const go = el('button', 'bitmail-btn is-main', msg.action.label);
      go.type = 'button';
      go.addEventListener('click', () => { ctx.close(); runAction(msg); });
      actions.appendChild(go);
    }
    if (actions.children.length) node.appendChild(actions);
    // First-class opt-out, honoured forever. A channel the user cannot switch
    // off is a channel they resent.
    const off = el('button', 'bitmail-link', t('hubmsg_optout', "Don't show announcements"));
    off.type = 'button';
    off.addEventListener('click', () => {
      mute();
      ctx.close();
      if (window.XenonToast) {
        window.XenonToast.show({ type: 'info', important: true, duration: 5000, title: t('hubmsg_muted_toast', 'Done, no more announcements. You can turn them back on in Settings.') });
      }
    });
    node.appendChild(off);
  }

  const previews = new Map();   // _preview() letters, drawn from memory, never from the feed

  async function drawLetter(letter, node, ctx) {
    const id = letter.data && letter.data.msgId;
    if (typeof id !== 'string') return;
    if (previews.has(letter.id)) { drawMessage(previews.get(letter.id), node, ctx); return; }
    const wait = letter.line ? el('p', 'bitmail-letter-line', letter.line) : null;
    if (wait) node.appendChild(wait);
    let msg = null;
    try {
      const out = await api('/api/community/messages');
      if (out && out.ok && Array.isArray(out.messages)) msg = out.messages.find((m) => m && m.id === id) || null;
    } catch { /* the summary stays */ }
    if (!msg || !node.isConnected) return;   // withdrawn or offline: the summary is the letter
    if (wait) wait.remove();
    drawMessage(msg, node, ctx);
  }

  function letterFor(m) {
    const body = String(m.body || '');
    return {
      id: 'hub:' + m.id,
      kind: 'hub',
      title: m.title,
      line: body.length > LINE_MAX ? body.slice(0, LINE_MAX - 1) + '…' : body,
      note: m.title,
      data: { msgId: m.id },
    };
  }

  // ── The check ──────────────────────────────────────────────────────────────
  const STAMP = () => { try { localStorage.setItem(K_CHECK, String(Date.now())); } catch { /* ignore */ } };

  async function checkDaily() {
    try {
      if (isMuted() || !window.BitMail) return;
      let last = 0; try { last = Number(localStorage.getItem(K_CHECK) || 0); } catch { /* ignore */ }
      if (Date.now() - last < CHECK_EVERY) return;

      const out = await api('/api/community/messages');
      if (!out || !out.ok || !Array.isArray(out.messages)) return;   // offline → retry next look

      const I = window.XenonInterrupts;
      const ctx = {
        version: (out.context && out.context.version) || '',
        os: (out.context && out.context.os) || '',
        lang: uiLang(),
        installed: installedEntryIds(),
      };
      // Anything already announced by ANY channel is skipped: the shared set is
      // why a hub note about a drop cannot repeat the drop's own letter.
      const seen = new Set(I.readSeen());
      const fresh = out.messages.filter((m) => m.level !== 'banner' && HubMatch.matches(m, ctx) && !seen.has(m.id) && !(m.entryId && seen.has(m.entryId)));
      STAMP();
      if (!fresh.length) return;
      // Every message is a letter now, whatever level the feed declared. The
      // box keeps it until it is read, so nothing needs to be shown "in time";
      // Bit's one note a day says it arrived.
      for (const m of fresh) window.BitMail.post(letterFor(m));
      I.markSeen(fresh.map((m) => m.id));
    } catch { /* best-effort — never surface an error for an announcement */ }
  }

  // ── Local testing seams ────────────────────────────────────────────────────
  // Underscore-prefixed like the server modules' _setTransport/_resetCache: the
  // only way to see this channel without publishing to the live site first.
  //
  //   HubMessages._preview({title:'Hi', body:'…'})  → a letter, opened
  //   HubMessages._simulate({messages:[…]})         → what WOULD be filed
  let previewSeq = 0;
  function _preview(msg) {
    if (!window.BitMail) return null;
    const m = Object.assign({ id: 'preview-' + (++previewSeq), title: 'Preview' }, msg || {});
    const l = letterFor(m);
    previews.set(l.id, m);
    window.BitMail.post(l);
    window.BitMail.open(l.id);
    return m;
  }

  function _simulate(feed, ctxOver) {
    const messages = (feed && feed.messages) || [];
    const ctx = Object.assign({
      version: (feed && feed.context && feed.context.version) || '',
      os: (feed && feed.context && feed.context.os) || '',
      lang: uiLang(),
      installed: installedEntryIds(),
    }, ctxOver || {});
    const matched = messages.filter((m) => m.level !== 'banner' && HubMatch.matches(m, ctx));
    return { ctx: { version: ctx.version, os: ctx.os, lang: ctx.lang, installed: [...ctx.installed] }, matched, skipped: messages.filter((m) => !matched.includes(m)) };
  }

  if (window.BitMail) window.BitMail.register('hub', (letter, node, ctx) => { drawLetter(letter, node, ctx); });
  window.HubMessages = { checkDaily, _preview, _simulate };
  // A look 35 seconds after the dashboard opens, then every half hour while it
  // stays open (a kiosk can stay open for days), and one when it comes back into
  // view. A chain of timeouts, not setInterval.
  // A layer window would file letters nobody reads there.
  if (typeof isLayerPage === 'function' && isLayerPage()) return;
  const look = () => { try { checkDaily(); } catch { /* ignore */ } };
  const loop = () => setTimeout(() => { look(); loop(); }, 30 * 60 * 1000);
  setTimeout(() => { look(); loop(); }, 35000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) look(); });
})();
