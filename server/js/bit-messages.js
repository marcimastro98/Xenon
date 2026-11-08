'use strict';
// Bit's messages on this screen. The server keeps the inbox and the one-a-day
// limit (server/bit-messages.js); this asks it what may be shown now, waits for a
// moment nobody is busy, and hands the message to the card (js/bit-message-card.js).
// Filing goes through here too, for every channel: hub-messages.js, catalog-drop.js,
// sparks-mail.js, support-card.js, share-nudge.js.
//
// It runs on the dashboard and on a phone, and in the alerts window of "widgets
// only" (js/screen-alerts.js starts it there). A layer page or a sheet shows
// nothing, but the chat there still reads what Bit said and runs its buttons.
//
// Why a card that waits, and never a dialog on arrival: interruptions cost least at
// a break in the task (Iqbal & Bailey, CHI 2008), and most of what arrives at a bad
// moment is dismissed unread (Mehrotra et al., CHI 2016).
(function () {
  const SCREEN = document.documentElement.hasAttribute('data-screen-alerts');
  const SURFACE = SCREEN ? 'screen' : 'dashboard';
  const FIRST_LOOK_MS = 12000;
  const RETRY_MS = 15000;
  const LOOK_EVERY_MS = 30 * 60 * 1000;   // a new day opens a new message
  const VOICE_CLASSES = ['ai-voice-mode', 'ai-listening'];
  const LINE_MAX = 100;
  const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
  const WAIT_FOR = '.rn-corner, .rn-overlay, .wn-stage, .bm-ask';
  const K_OLD_MAIL = 'xeneonedge.bitMail';
  const K_IMPORTED = 'xeneonedge.bitMessagesImported';

  const kinds = new Map();     // kind -> what it adds to the opened card
  const later = new Set();     // stages sent to the corner this session
  let tr = (key) => (typeof window.t === 'function' ? window.t(key) : key);
  let ready = () => true;
  let started = false;
  let up = null;               // { id, remove }
  let retry = 0;
  let loop = 0;
  let previewSeq = 0;

  const base = () => (typeof SERVER === 'string' ? SERVER : '');

  async function post(path, body) {
    try {
      const res = await fetch(base() + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  async function view() {
    try {
      const res = await fetch(`${base()}/bit/messages?surface=${SURFACE}`, { cache: 'no-store' });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  // ── What a button does on this screen ──────────────────────────
  async function sheet(req) {
    const out = await post('/screen-menu', { sheet: req });
    if (out && out.where === 'screen') return;
    window.location.href = (window.__xenonSignal || String)('xenon-app:open-dashboard?open=dashboard');
  }

  const ON_SCREEN = {
    store: (msg) => sheet({ open: 'store', entry: msg.entryId }),
    sparks: () => sheet({ open: 'sparks' }),
    url: (msg) => post('/actions/run', { type: 'openUrl', url: msg.action.url }),
  };

  // Every Store button funnels into the Store's own detail view, never an import.
  const ON_DASHBOARD = {
    store: (msg) => window.CommunityGallery && window.CommunityGallery.openEntryById(msg.entryId),
    sparks: () => window.XenonCredits && window.XenonCredits.openShop(),
    share: () => window.ShareCard && window.ShareCard.open({ source: 'setup' }),
    url: (msg) => window.open(msg.action.url, '_blank', 'noopener,noreferrer'),
  };

  function run(msg) {
    const go = msg.action && (SCREEN ? ON_SCREEN : ON_DASHBOARD)[msg.action.type];
    if (go) go(msg);
  }

  function offSwitch(msg) {
    if (msg.kind !== 'hub' && msg.kind !== 'drop') return null;
    if (SCREEN) return { label: tr('drop_where_off'), run: () => sheet({ open: 'settings', cat: 'general' }) };
    if (msg.kind === 'hub' && window.HubMessages) return { label: tr('hubmsg_optout'), run: window.HubMessages.mute };
    if (msg.kind === 'drop' && window.CatalogDrop) return { label: tr('drop_where_off'), run: window.CatalogDrop.openSwitch };
    return null;
  }

  // ── When ───────────────────────────────────────────────────────
  function typing() {
    const a = document.activeElement;
    if (!a) return false;
    if (a.isContentEditable || a.tagName === 'TEXTAREA') return true;
    return a.tagName === 'INPUT' && TEXT_INPUTS.has(String(a.type).toLowerCase());
  }

  // Not now: the arbiter's busy (a game, a scene, the lock screen, any dialog), a
  // voice session, a caret in a text field, the news of an update on screen, or a
  // question waiting for its answer.
  function quiet() {
    const I = window.XenonInterrupts;
    if (I && I.busy()) return true;
    if (VOICE_CLASSES.some((k) => document.body.classList.contains(k))) return true;
    if (document.querySelector(WAIT_FOR)) return true;
    return typing() || document.hidden;
  }

  const canShow = () => ready() && !quiet();

  function stop() {
    clearTimeout(retry);
    clearTimeout(loop);
    retry = 0;
    loop = 0;
    started = false;
    if (up) up.remove();
    up = null;
  }

  // ── Showing one ────────────────────────────────────────────────
  function finish(msg, answer) {
    up = null;
    if (msg.preview) return;
    post('/bit/messages/read', { id: msg.id, answer }).then(check);
  }

  // Read at once, but the thank-you stays up until it has been seen.
  function answerPoll(msg, option) {
    up.pinned = true;
    if (msg.preview) return;
    post('/api/community/poll', { messageId: msg.id.replace(/^hub:/, ''), optionId: option.id });
    post('/bit/messages/read', { id: msg.id, answer: option.id });
  }

  function hands(msg) {
    const kind = kinds.get(msg.kind);
    return {
      tr,
      bit: window.XenonReleaseNotes.bit,
      read: () => finish(msg),
      run: () => { finish(msg); run(msg); },
      answer: (option) => answerPoll(msg, option),
      done: () => { up = null; check(); },
      later: () => { later.add(msg.id); up = null; present(msg); },
      off: offSwitch(msg),
      extra: kind && kind.extra,
    };
  }

  function showStage(msg) {
    const h = hands(msg);
    up = { id: msg.id, remove: window.XenonBitCard.stage(msg, h) };
  }

  // A vote asked for: its own card, and it is sent only after the wait to undo it.
  function rateHands(msg) {
    return {
      tr,
      vote: (stars, why) => (msg.preview
        ? Promise.resolve({ ok: true })
        : post('/api/community/rate', { entryId: msg.entryId, stars, why })),
      pin: () => { if (up) up.pinned = true; },
      close: () => {
        if (!msg.preview) post('/api/community/rating-close', { entryId: msg.entryId });
        finish(msg);
      },
      done: () => finish(msg),
    };
  }

  function present(msg) {
    if (msg.kind === 'rate') {
      up = { id: msg.id, remove: window.XenonRatingCard.card(msg, rateHands(msg)) };
      return;
    }
    const big = msg.where === 'stage';
    if (big && !SCREEN && !later.has(msg.id)) { showStage(msg); return; }
    const h = hands(msg);
    // In "widgets only" the stage starts from the corner, and opens when asked.
    if (big) h.openStage = () => { up.remove(); showStage(msg); };
    up = { id: msg.id, remove: window.XenonBitCard.card(msg, h) };
  }

  async function check() {
    if (!started) return;
    clearTimeout(retry);
    retry = 0;
    const data = await view();
    if (!started || !data) return;
    const next = data.next;
    if (up && up.pinned) return;
    if (up && (!next || next.id !== up.id)) { up.remove(); up = null; }
    if (up || !next) return;
    if (!canShow()) { retry = setTimeout(check, RETRY_MS); return; }
    if (!next.shownAt) post('/bit/messages/shown', { id: next.id });
    present(next);
  }

  function lookLater() {
    loop = setTimeout(() => { check(); lookLater(); }, LOOK_EVERY_MS);
  }

  function start(opts) {
    if (started) return;
    if (opts && opts.tr) tr = opts.tr;
    if (opts && opts.ready) ready = opts.ready;
    started = true;
    lookLater();
    setTimeout(check, FIRST_LOOK_MS);
  }

  // ── The old mail ───────────────────────────────────────────────
  function fromLetter(letter) {
    const entryId = letter.data && letter.data.entryId;
    const msg = { id: letter.id, kind: letter.kind, at: letter.at, title: letter.title, line: letter.line };
    if (entryId) Object.assign(msg, { entryId, action: { type: 'store', label: tr('bm_store_open') } });
    return msg;
  }

  // Once, on each device that had a mailbox: its letters go to the chat, read.
  async function importOldMail() {
    let box = null;
    try {
      if (localStorage.getItem(K_IMPORTED) === '1') return;
      box = JSON.parse(localStorage.getItem(K_OLD_MAIL) || 'null');
    } catch { return; }
    const letters = box && Array.isArray(box.letters) ? box.letters.map(fromLetter) : [];
    const I = window.XenonInterrupts;
    const out = await post('/bit/messages/import', { letters, gone: box && box.gone, seen: I ? I.readSeen() : [] });
    if (!out) return;   // the server is restarting: next load
    try {
      localStorage.setItem(K_IMPORTED, '1');
      localStorage.removeItem(K_OLD_MAIL);
    } catch { /* imported ids are skipped by the server anyway */ }
  }

  // ── For the channels and the chat ──────────────────────────────
  // The card's one line from a longer text: its first sentence, or its start.
  function firstLine(text) {
    const words = String(text || '').trim();
    const sentence = /^.{12,}?[.!?](?=\s|$)/.exec(words);
    const line = sentence ? sentence[0] : words;
    if (line.length <= LINE_MAX) return line;
    return `${line.slice(0, LINE_MAX).replace(/\s+\S*$/, '')}…`;
  }

  const file = async (messages, live) => !!(await post('/bit/messages/file', { messages, live }));
  const told = async () => { const data = await view(); return data && Array.isArray(data.messages) ? data.messages : []; };
  const kind = (name, parts) => { kinds.set(name, parts); };

  // On screen right now, not through the inbox: HubMessages._preview and app-shots.
  function preview(raw) {
    if (up) up.remove();
    const msg = { kind: 'hub', title: 'Preview', ...raw, id: `preview-${++previewSeq}`, preview: true };
    present(msg);
    up.pinned = true;
    return msg;
  }

  window.BitMessages = Object.freeze({ start, stop, check, file, told, kind, run, preview, firstLine, openSheet: sheet, surface: SURFACE });

  if (SCREEN || (typeof isLayerPage === 'function' && isLayerPage())) return;
  window.addEventListener('load', () => {
    importOldMail();
    start();
    if (window.XenonInterrupts) window.XenonInterrupts.registerOverlay('.bm-stage');
  }, { once: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
})();
