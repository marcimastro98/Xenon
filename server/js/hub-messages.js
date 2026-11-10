'use strict';
// Hub messages: the app's side of the announcement channel, filed as Bit's
// messages (js/bit-messages.js). It runs on the dashboard and in the alerts window
// of "widgets only", the two places that show them.
//
// The server proxies a static feed (server/community-messages.js) that every
// install receives WHOLE. Targeting happens here, on this machine, against what
// the app already knows about itself: its version, its platform, its language,
// and which catalog entries it has installed. Nothing is sent to receive a
// targeted message, which is the entire reason the channel is shaped this way:
// see the correlation note in server/version-ping.js. If you ever find yourself
// wanting to POST "what I have" to pick messages server-side, that is the thing
// this design exists to avoid. The inbox on this PC keeps what matched and never
// leaves it.
(function () {
  const api = apiJson;               // shared fetch-JSON helper from utils.js
  const t = (k, fb) => { const v = (typeof window.t === 'function') ? window.t(k) : k; return (v === k && fb != null) ? fb : v; };

  // Same local accessor the other settings readers use (installed-manager.js,
  // preset-share.js): `hubSettings` is a global that may not exist yet.
  const HS = () => { try { return (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : {}; } catch { return {}; } };

  const CHECK_EVERY = 3 * 3600 * 1000;   // how often it asks for the feed while open
  const K_MUTED = 'xeneonedge.hubMessagesMuted';  // '1' once the user opts out
  const K_CHECK = 'xeneonedge.hubMessageCheck';   // last-check timestamp

  // Off when the Settings switch says so, or when this device carries the legacy
  // per-device flag from before v4.9.0 (Settings clears that one when you switch
  // announcements back on, so it can never outvote a deliberate "yes").
  const isMuted = () => {
    if (HS().hubMessages === false) return true;
    try { return localStorage.getItem(K_MUTED) === '1'; } catch { return false; }
  };

  // First-class opt-out, honoured forever: a channel the user cannot switch off
  // is a channel they resent. Persisted through the normal settings path so the
  // choice follows the user to every surface; the local flag holds it on this
  // device if the save never reaches the server.
  function mute() {
    try { localStorage.setItem(K_MUTED, '1'); } catch { /* ignore */ }
    try { if (typeof updateHubMessages === 'function') updateHubMessages(false); } catch { /* ignore */ }
    if (window.XenonToast) {
      window.XenonToast.show({ type: 'info', important: true, duration: 5000, title: t('hubmsg_muted_toast', 'Done, no more announcements. You can turn them back on in Settings.') });
    }
  }

  // Catalog entry ids this install has. Receipts live in hub settings and record
  // where each install came from; only catalog installs carry a sourceId, which is
  // the entry id the feed's hasEntry names.
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

  const matchContext = (context) => ({
    version: (context && context.version) || '',
    os: (context && context.os) || '',
    supporter: context ? context.supporter : undefined,
    lang: uiLang(),
    installed: installedEntryIds(),
  });

  // The server checks every field again (server/bit-messages.js).
  function messageFor(m) {
    const expires = Date.parse(m.activeUntil || '');
    return {
      id: 'hub:' + m.id,
      kind: 'hub',
      title: m.title,
      line: window.BitMessages.firstLine(m.body),
      body: m.body,
      where: m.where,
      entryId: m.entryId,
      media: m.media,
      action: m.action,
      poll: m.poll,
      expires: Number.isFinite(expires) ? expires : undefined,
    };
  }

  // ── The check ──────────────────────────────────────────────────────────────
  const STAMP = () => { try { localStorage.setItem(K_CHECK, String(Date.now())); } catch { /* ignore */ } };

  async function checkDaily() {
    try {
      if (isMuted() || !window.BitMessages) return;
      let last = 0; try { last = Number(localStorage.getItem(K_CHECK) || 0); } catch { /* ignore */ }
      if (Date.now() - last < CHECK_EVERY) return;

      const out = await api('/api/community/messages');
      if (!out || !out.ok || !Array.isArray(out.messages)) return;   // offline → retry next look

      const ctx = matchContext(out.context);
      const fresh = out.messages.filter((m) => HubMatch.matches(m, ctx));
      // Everything still in the feed stays; what left it is withdrawn if unread.
      const live = { hub: fresh.map((m) => 'hub:' + m.id) };
      if (await window.BitMessages.file(fresh.map(messageFor), live)) STAMP();
    } catch { /* best-effort: never surface an error for an announcement */ }
  }

  // ── Local testing seams ────────────────────────────────────────────────────
  // Underscore-prefixed like the server modules' _setTransport/_resetCache: the
  // only way to see this channel without publishing to the live site first.
  //
  //   HubMessages._preview({title:'Hi', body:'…'})  → the card, on screen now
  //   HubMessages._simulate({messages:[…]})         → what WOULD be filed
  function _preview(msg) {
    return window.BitMessages ? window.BitMessages.preview(messageFor({ id: 'preview', title: 'Preview', ...msg })) : null;
  }

  function _simulate(feed, ctxOver) {
    const messages = (feed && feed.messages) || [];
    const ctx = { ...matchContext(feed && feed.context), ...(ctxOver || {}) };
    const matched = messages.filter((m) => HubMatch.matches(m, ctx));
    return { ctx: { version: ctx.version, os: ctx.os, lang: ctx.lang, supporter: ctx.supporter, installed: [...ctx.installed] }, matched, skipped: messages.filter((m) => !matched.includes(m)) };
  }

  window.HubMessages = { checkDaily, mute, _preview, _simulate };
  // A look 35 seconds after the page opens, then every half hour while it stays
  // open (a kiosk can stay open for days), and one when it comes back into view.
  // A chain of timeouts, not setInterval. A layer window shows no messages.
  if (window.BitMessages && window.BitMessages.surface !== 'screen' && typeof isLayerPage === 'function' && isLayerPage()) return;
  const look = () => { try { checkDaily(); } catch { /* ignore */ } };
  const loop = () => setTimeout(() => { look(); loop(); }, 30 * 60 * 1000);
  setTimeout(() => { look(); loop(); }, 35000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) look(); });
})();
