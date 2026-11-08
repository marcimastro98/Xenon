'use strict';

// The chat alone in the Xenon menu's window (`/?panel=sheet&open=chat`). It is the
// dashboard's chat, not a copy: the pane leaves its hidden tile for a full-window
// sheet, as on a phone (js/bit-chat-full.js), so Settings and the Store open over
// it and Bit's voice overlay opens over those; when voice ends the chat is there.
// A menu section and back reload the page, so the talk is kept for this window.
(function (root) {
  const STORE_KEY = 'xenon.sheetChat';
  const KEEP_TURNS = 40;
  const RECORD_LINE = /^\[Xenon record[^\n]*\n*/;
  // What ai.js stores in place of a turn with no text of its own.
  const NO_TEXT = ['[richiesta vocale]', '[immagine allegata]', '[The user stopped this reply.]'];

  function textOf(turn) {
    if (!turn || !Array.isArray(turn.parts)) return '';
    return turn.parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  }

  // Only the words: pictures and files are too large to keep, and a tool call
  // from a past turn means nothing to the next one.
  function keep(history, summary) {
    const turns = (Array.isArray(history) ? history : [])
      .map((turn) => ({ role: turn && turn.role, parts: [{ text: textOf(turn) }] }))
      .filter((turn) => (turn.role === 'user' || turn.role === 'model') && turn.parts[0].text);
    return { history: turns.slice(-KEEP_TURNS), summary: typeof summary === 'string' ? summary : '' };
  }

  function parse(raw) {
    try {
      const saved = JSON.parse(raw);
      return saved && typeof saved === 'object' ? keep(saved.history, saved.summary) : keep();
    } catch {
      return keep();
    }
  }

  function bubbles(history) {
    return history
      .map((turn) => ({ role: turn.role === 'user' ? 'user' : 'assistant', text: textOf(turn).replace(RECORD_LINE, '').trim() }))
      .filter((b) => b.text && !NO_TEXT.includes(b.text));
  }

  const api = { keep, parse, bubbles };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  const here = new URLSearchParams(root.location.search);
  if (here.get('panel') !== 'sheet' || here.get('open') !== 'chat') return;

  const input = () => document.getElementById('ai-text-input');

  // A Deck key's question comes through the server (screen-menu.js): this window
  // shares no storage with the driver that took the key, and it never rides in the address.
  async function askWaiting() {
    try {
      const res = await fetch('/screen-menu', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"takeAsk":true}' });
      const data = res.ok ? await res.json() : null;
      if (data && data.ask && typeof root.aiAsk === 'function') root.aiAsk(data.ask);
    } catch (e) { /* the server is restarting: the chat is open, the question is lost with it */ }
  }

  function focus() {
    const field = input();
    if (field && !field.disabled) field.focus({ preventScroll: true });
  }

  function restore() {
    let saved = keep();
    try { saved = parse(sessionStorage.getItem(STORE_KEY)); } catch { /* a new chat */ }
    if (!saved.history.length) return;
    aiConversationHistory = saved.history;
    aiConversationSummary = saved.summary;
    const chat = document.getElementById('ai-chat');
    if (chat) chat.replaceChildren();
    bubbles(saved.history).forEach((b) => _aiAppendBubble(b.role, b.text));
  }

  function save() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(keep(aiConversationHistory, aiConversationSummary)));
    } catch { /* the next visit starts a new chat */ }
  }

  // A voice session starts by clearing the talk, before its first wait: here it
  // goes on from what was being said.
  function talk() {
    const history = aiConversationHistory;
    const summary = aiConversationSummary;
    root._aiHandleWake();
    aiConversationHistory = history;
    aiConversationSummary = summary;
  }

  // The dashboard's voice button is on its top bar, which a sheet does not have.
  function talkButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bit-chat-talk';
    button.title = t('ai_voice_session');
    const mic = document.querySelector('#ai-dictate-btn svg');
    if (mic) button.appendChild(mic.cloneNode(true));
    const label = document.createElement('span');
    label.dataset.i18n = 'ai_talk';
    label.textContent = t('ai_talk');
    button.appendChild(label);
    button.addEventListener('click', talk);
    return button;
  }

  // Here the arrow leads back to the menu, not to a dashboard.
  function pointBack(arrow) {
    arrow.dataset.i18nTitle = 'xmenu_title';
    arrow.dataset.i18nAriaLabel = 'xmenu_title';
    arrow.title = t('xmenu_title');
    arrow.setAttribute('aria-label', t('xmenu_title'));
    arrow.addEventListener('click', () => root.XenonSheet.back());
  }

  function mount() {
    const pane = document.getElementById('media-pane-chat');
    if (!pane) return;
    const sheet = document.createElement('div');
    sheet.className = 'bit-sheet';
    sheet.setAttribute('aria-label', t('bit_chat_label'));
    document.body.appendChild(sheet);
    moveNode(sheet, pane);
    const arrow = pane.querySelector('[data-bit-back]');
    if (arrow) pointBack(arrow);
    const model = pane.querySelector('[data-bit-model]');
    if (model) model.parentNode.insertBefore(talkButton(), model.nextSibling);
    restore();
    root.SheetChat = Object.freeze({ focus, askWaiting });
  }

  root.addEventListener('load', mount, { once: true });
  root.addEventListener('pagehide', save);
})(typeof window !== 'undefined' ? window : globalThis);
