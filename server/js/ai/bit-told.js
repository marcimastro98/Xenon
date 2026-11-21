'use strict';
// What Bit said on its own stays in the chat: once a message has been read it
// shows there as something Bit said, with its picture and its button, and the
// person can answer it. Drawing it costs no model call; Bit knows about it through
// the conversation memory, so the next reply can talk about it.
//
// Bit also says, unasked, when a widget it just made does not fit its tile (watchFit).
//
// Every string comes from the inbox (server/ai/bit-messages.js), which rebuilt it field
// by field, or from the app's own words, and goes in as text. The button's click is delegated, because the chat
// copies in duplicated tiles are innerHTML clones.
(function () {
  const KEEP = 5;
  const NOTE_MAX = 220;
  const MEMO_MAX = 700;        // a fit note's class names and sizes
  const FIT_WAIT_MS = 10 * 60 * 1000;   // the person may approve its permissions first
  const MEMORY_MAX = 2000;     // what the server keeps of the conversation memory
  const FIRST_LOOK_MS = 1500;  // after sheet-chat.js has put a saved talk back
  const K_CLEARED = 'xeneonedge.bitToldCleared';

  const drawn = new Map();     // id -> message
  let first = true;

  function clearedAt() {
    try { return Number(localStorage.getItem(K_CLEARED)) || 0; } catch { return 0; }
  }

  // "New chat" means a clean one, also after the next reload.
  function forget() {
    try { localStorage.setItem(K_CLEARED, String(Date.now())); } catch { /* until the next reload */ }
  }

  // A word on the Scintille ("sparks:low:2026-11") speaks only while it still holds:
  // after a top-up, "running low" over a balance of 700 reads as a fault, and Bit
  // would take it for the present too.
  function stillTrue(msg) {
    if (msg.kind !== 'sparks') return true;
    const C = window.XenonCredits;
    const level = C && typeof C.level === 'function' ? C.level() : '';
    return String(msg.id).startsWith('sparks:' + level + ':');
  }

  // The ask's text leads into a list only the card has.
  const wordsOf = (msg) => (msg.kind === 'support' ? msg.line : msg.body || msg.line) || '';

  function answerOf(msg) {
    const options = msg.poll && msg.poll.options;
    const picked = options && options.find((o) => o.id === msg.answer);
    return picked ? picked.label : '';
  }

  function part(tag, cls, text) {
    const node = document.createElement(tag);
    node.className = cls;
    node.textContent = text;
    return node;
  }

  function bubbleOf(msg) {
    const row = document.createElement('div');
    row.className = 'ai-msg ai-msg-assistant';
    row.dataset.bitTold = msg.id;
    if (window.BitChat) row.insertAdjacentHTML('afterbegin', window.BitChat.avatarHtml());
    const bubble = document.createElement('span');
    bubble.className = 'ai-msg-bubble ai-told';
    const frame = window.XenonBitCard.mediaFrame(msg.media, 'ai-told-media');
    if (frame) bubble.append(frame);
    bubble.append(part('span', 'ai-told-title', msg.title));
    const words = wordsOf(msg);
    if (words) bubble.append(part('span', 'ai-msg-text', words));
    const answer = answerOf(msg);
    if (answer) bubble.append(part('span', 'ai-told-answer', window.t('bm_noted').replace('{answer}', answer)));
    if (msg.action) {
      const go = part('button', 'ai-told-go', msg.action.label);
      go.type = 'button';
      go.dataset.bitToldGo = msg.id;
      bubble.append(go);
    }
    row.append(bubble);
    return row;
  }

  function noteOf(msg) {
    if (msg.memo) return msg.memo.slice(0, MEMO_MAX);
    const said = `Bit showed the user this on its own: "${msg.title}". ${wordsOf(msg)}`.slice(0, NOTE_MAX);
    const entry = msg.entryId ? ` Store entry id: ${msg.entryId}.` : '';
    const answer = answerOf(msg) ? ` The user answered: ${answerOf(msg)}.` : '';
    return said + entry + answer;
  }

  function remember(msg) {
    const note = noteOf(msg);
    if (aiConversationSummary.includes(note)) return;
    aiConversationSummary = `${note} ${aiConversationSummary}`.trim().slice(0, MEMORY_MAX);
  }

  async function sync() {
    const chat = document.getElementById('ai-chat');
    if (!chat || !window.BitMessages) return;
    const told = await window.BitMessages.told();
    const since = clearedAt();
    const fresh = told
      .filter((m) => m.readAt && m.readAt > since && !drawn.has(m.id) && stillTrue(m))
      .sort((a, b) => a.readAt - b.readAt)
      .slice(-KEEP);
    // Read before this page opened: above what is already in the chat.
    const before = first ? chat.firstChild : chat.querySelector('[data-bit-welcome]');
    const live = !first;
    first = false;
    if (!fresh.length) return;
    for (const msg of fresh) {
      drawn.set(msg.id, msg);
      chat.insertBefore(bubbleOf(msg), before);
      remember(msg);
    }
    if (live) requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
    if (typeof mirrorChatCopies === 'function') mirrorChatCopies();
  }

  // A widget Bit just made or changed, measured on its tile a few seconds later: when part of it
  // does not fit, Bit says so with one button that asks for the fix. The class names and sizes go
  // into the conversation memory, so the fix knows what to change; nothing is spent until the tap.
  const FIT_HOW = {
    past: (i) => `${i.px}px past the ${i.by === 'tile' ? "tile's" : "clipping box's"} ${i.side} edge`,
    cut: (i) => `its own box cuts ${i.px}px of its text`,
    spill: (i) => `its text runs ${i.px}px out of its box (${i.side})`,
  };

  function watchFit(id) {
    const CW = window.CustomWidget;
    if (typeof CW?.whenFit !== 'function') return;
    CW.whenFit(id, (fit) => { if (fit?.items.length) say(fitMessage(id, fit)); }, FIT_WAIT_MS);
  }

  function fitMessage(id, fit) {
    const CW = window.CustomWidget;
    const pkgs = typeof CW?.cachedPackages === 'function' ? CW.cachedPackages() || [] : [];
    const pkg = pkgs.find((p) => p?.id === id);
    const name = pkg?.name || id;
    const parts = fit.items.map((i) => `${i.sel}${i.in ? ' in ' + i.in : ''} ${i.nth}/${i.of}${i.count > 1 ? ` (${i.count} alike)` : ''}: ${FIT_HOW[i.kind](i)}`);
    return {
      id: `fit:${id}:${Date.now()}`,
      kind: 'fit',
      title: name,
      body: window.t(fit.items.some((i) => i.by === 'tile') ? 'bm_fit_edge' : 'bm_fit_text'),
      action: { label: window.t('bm_fit_fix') },
      ask: window.t('bm_fit_ask').replace('{name}', name),
      memo: `Xenon measured the widget "${id}" Bit just made on its ${fit.w}x${fit.h} tile, and it does not fit: ${parts.join('; ')}. To fix it, change only those parts and call create_widget with the same id.`,
    };
  }

  function say(msg) {
    const chat = document.getElementById('ai-chat');
    if (!chat) return;
    drawn.set(msg.id, msg);
    chat.append(bubbleOf(msg));
    remember(msg);
    requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
    if (typeof mirrorChatCopies === 'function') mirrorChatCopies();
  }

  document.addEventListener('click', (e) => {
    const go = e.target.closest && e.target.closest('[data-bit-told-go]');
    const msg = go && drawn.get(go.dataset.bitToldGo);
    if (!msg) return;
    if (!msg.ask) { window.BitMessages.run(msg); return; }
    drawn.delete(msg.id);   // one fix asked per note
    go.disabled = true;
    aiSendMessage(msg.ask, false);
  });

  window.addEventListener('load', () => setTimeout(sync, FIRST_LOOK_MS), { once: true });

  window.BitTold = Object.freeze({ sync, forget, watchFit });
})();
