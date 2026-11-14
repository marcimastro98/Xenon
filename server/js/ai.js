'use strict';

// Debug logging is OFF by default to avoid a network round-trip on every event.
// Enable from the console with `_aiDebug = true` (or `localStorage.aiDebug = '1'`)
// when you need the server-side [CLIENT] trace.
let _aiDebug = (() => { try { return localStorage.getItem('aiDebug') === '1'; } catch { return false; } })();

let _aiCurrentAudio = null;

async function _aiUndo(id) {
  const btns = () => document.querySelectorAll('.ai-undo-btn[data-undo-id="' + CSS.escape(id) + '"]');
  btns().forEach((b) => { b.disabled = true; });
  try {
    const res = await fetch('/api/ai/actions/undo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (!(data && data.ok)) throw new Error((data && data.error) || 'undo_failed');
    if (data.refresh) _aiExecuteClientAction(data.refresh, {});
    btns().forEach((b) => { b.textContent = t('ai_undo_done'); b.classList.add('ai-undo-done'); });
  } catch (err) {
    _aiLog('Undo failed: ' + err.message);
    btns().forEach((b) => { b.disabled = false; });
    _aiNotice(t('ai_undo_failed'));
  }
  if (typeof mirrorChatCopies === 'function') mirrorChatCopies();
}

document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('.ai-undo-btn[data-undo-id]');
  if (btn && !btn.disabled && !btn.classList.contains('ai-undo-done')) _aiUndo(btn.dataset.undoId);
});

// What Bit said on its own (js/bit-told.js) does not make a chat a conversation.
const _aiTalkNodes = (chat) => chat.querySelectorAll(':scope > :not([data-bit-told])');

// An empty chat shows Bit's welcome with three things to ask (js/bit-welcome.js).
// Nothing to answer with: the chat tile shows its own card (media.js), so the
// log stays empty here.
function _aiRenderWelcomeIfEmpty() {
  const chat = $('ai-chat');
  if (!chat || _aiTalkNodes(chat).length > 0 || !window.BitWelcome || !_aiProviderReady()) return;
  chat.appendChild(BitWelcome.build());
  if (typeof mirrorChatCopies === 'function') mirrorChatCopies();
  BitWelcome.fit();
}

// The welcome belongs to an empty chat: the first message retires it.
function _aiDropWelcome() {
  const box = document.querySelector('#ai-chat [data-bit-welcome]');
  if (box) box.remove();
}

function _aiRetry(text) {
  const chat = $('ai-chat');
  const asked = chat ? [...chat.querySelectorAll('.ai-msg-user')].pop() : null;
  if (asked) { while (asked.nextSibling) asked.nextSibling.remove(); asked.remove(); }
  const last = aiConversationHistory[aiConversationHistory.length - 1];
  if (last && last.role === 'user') aiConversationHistory.pop();
  aiSendMessage(text, false);
}

document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('.ai-retry-btn[data-retry]');
  if (btn && !aiTurnRunning()) _aiRetry(btn.dataset.retry);
});

// Offered answers belong to the question just asked: any new message retires them.
function _aiClearChoices() {
  const rows = document.querySelectorAll('.ai-choices');
  if (!rows.length) return;
  rows.forEach((r) => r.remove());
  if (typeof mirrorChatCopies === 'function') mirrorChatCopies();
}

document.addEventListener('click', _aiHandleChoiceClick);

// Register paste listener once at module load
document.addEventListener('paste', _aiHandlePaste);

document.addEventListener('click', _aiHandleCopyClick);

// ── Initialisation ────────────────────────────────────────────────

function initAi() {
  // Voice sessions start via button tap; a turn the last page was waiting on
  // is picked up here.
  _aiResumePendingTurn();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(initAi, 1800));
} else {
  setTimeout(initAi, 1800);
}
