'use strict';
// What Bit said on its own stays in the chat: once a message has been read it
// shows there as something Bit said, with its picture and its button, and the
// person can answer it. Drawing it costs no model call; Bit knows about it through
// the conversation memory, so the next reply can talk about it.
//
// Every string comes from the inbox (server/bit-messages.js), which rebuilt it field
// by field, and goes in as text. The button's click is delegated, because the chat
// copies in duplicated tiles are innerHTML clones.
(function () {
  const KEEP = 5;
  const NOTE_MAX = 220;
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
      .filter((m) => m.readAt && m.readAt > since && !drawn.has(m.id))
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

  document.addEventListener('click', (e) => {
    const go = e.target.closest && e.target.closest('[data-bit-told-go]');
    const msg = go && drawn.get(go.dataset.bitToldGo);
    if (msg) window.BitMessages.run(msg);
  });

  window.addEventListener('load', () => setTimeout(sync, FIRST_LOOK_MS), { once: true });

  window.BitTold = Object.freeze({ sync, forget });
})();
