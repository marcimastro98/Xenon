// Starts and stops a turn of the chat, and picks up an answer that came late or a turn that was
// lost.
'use strict';

// ── Sending messages ─────────────────────────────────────────────

function aiSendText() {
  const input = $('ai-text-input');
  if (!input) return;
  const text = input.value.trim();
  // A pasted or attached image with no caption is a valid message on its own —
  // aiSendMessage() renders the attachment-only bubble and sends it.
  if (!text && _aiPendingImages.length === 0) return;
  input.value = '';
  if (window.BitComposer) BitComposer.sync();
  aiSendMessage(text, false); // text input: no TTS
}

// The text turn the chat is waiting on, for the stop button: its id, which the
// server ends at its next tool or round (ai-turns.js), and the request to drop.
let _aiRunningTurn = null;

function aiTurnRunning() { return !!_aiRunningTurn; }

function _aiSetTurnRunning(turn) {
  _aiRunningTurn = turn;
  document.body.classList.toggle('ai-turn-running', !!turn);
  const label = t(turn ? 'bit_stop' : 'tip_send');
  document.querySelectorAll('.ai-send-btn').forEach((b) => { b.title = label; b.setAttribute('aria-label', label); });
}

// The send button is the stop button while a reply is on its way.
function aiSendOrStop() {
  if (_aiRunningTurn) aiStopTurn();
  else aiSendText();
}

function aiStopTurn() {
  const turn = _aiRunningTurn;
  if (!turn || turn.stopped) return;
  turn.stopped = true;
  fetch('/api/ai/turn/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: turn.id }),
  }).catch(() => { /* the turn still ends; its answer is dropped below */ });
  turn.ctrl.abort();
}

function aiHandleKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    aiSendText();
  }
}

// Ask a question programmatically (e.g. from a Deck key). Posts it as a normal
// text chat message — the question and the written answer appear in the chat,
// no voice. In v3.0 the text chat lives in the media tile's Chat tab (the voice
// overlay holds only the orb), so reveal that tab rather than the empty overlay.
function aiAsk(text) {
  if (typeof openMediaChat === 'function') openMediaChat();
  else openAiPanel(); // fallback for layouts without the media Chat tab
  const msg = String(text == null ? '' : text).trim();
  if (msg) aiSendMessage(msg, false); // text/chat mode, no TTS
}

// Stopped: the chat is free at once, with a line saying so. What the turn made
// before it stopped, and the balance after the round it was in, arrive when the
// server has finished that round.
function _aiAfterStop(turnId) {
  setAiStatus('');
  const chat = $('ai-chat');
  if (chat) {
    const note = document.createElement('div');
    note.className = 'ai-note';
    note.textContent = t('bit_stopped');
    chat.appendChild(note);
    requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
    if (typeof mirrorChatCopies === 'function') mirrorChatCopies();
  }
  // The model sees that its last turn was cut, instead of two user turns in a row.
  aiConversationHistory.push({ role: 'model', parts: [{ text: '[The user stopped this reply.]' }] });
  if (!window.AiTurnWait) return;
  window.AiTurnWait.recover(turnId, (data) => {
    if (!data) return;
    if (window.XenonCredits && Number.isFinite(data.credits)) XenonCredits.set(data.credits);
    if (Array.isArray(data.clientActions) && data.clientActions.length) _aiRunMadeActions(data.clientActions);
  });
}

// create_preset may run again in one reply after its critique: only its last
// code opens, so the user never gets a stack of earlier drafts.
function _aiActionsToRun(actions) {
  const list = (Array.isArray(actions) ? actions : []).filter((a) => a && typeof a.action === 'string');
  const isDraft = (a) => !!(a.action === 'marketplace_open_import' && a.args && a.args.created);
  const lastCreated = list.map(isDraft).lastIndexOf(true);
  return list.filter((a, i) => !isDraft(a) || i === lastCreated);
}

// What a turn made, run without the rest of a reply (an answer picked up late,
// or a turn that failed after making something).
function _aiRunMadeActions(actions) {
  for (const action of _aiActionsToRun(actions)) {
    if (action.action === 'show_monitor_picker') continue; // a question nobody is waiting on any more
    _aiExecuteClientAction(action.action, action.args || {});
  }
}

// A long turn that ends while the chat is out of sight says so with a toast:
// the wait told the user they could close the chat.
function _aiToastIfUnseen(startedAt) {
  const AW = window.AiTurnWait;
  if (!AW || Date.now() - startedAt < AW.LONG_SECS * 1000) return;
  const status = $('ai-status');
  const seen = document.visibilityState === 'visible' && aiPanelOpen && !!status && status.getClientRects().length > 0;
  if (!seen && window.XenonToast) window.XenonToast.show({ type: 'success', title: t('ai_wait_ready') });
}

// A reply the chat itself never received: shown, its actions run, and kept in
// the conversation like any other.
function _aiApplyLateAnswer(data, ok) {
  if (!data) return;
  if (window.XenonCredits && Number.isFinite(data.credits)) XenonCredits.set(data.credits);
  const made = Array.isArray(data.clientActions) && data.clientActions.length > 0;
  if (made) _aiRunMadeActions(data.clientActions);
  if (!ok) {
    if (made) _aiAppendBubble('assistant', t('ai_partial_done'));
    const err = new Error(data.error || t('ai_http_error'));
    if (data.detail) err.detail = String(data.detail);
    _aiAppendBubble('assistant', _aiFormatApiError(err));
    _aiFollowNoCode(err);
    if (_aiOutOfSparks(err)) _aiAppendBuyRow('');
    return;
  }
  if (data.newContent) aiConversationHistory.push(data.newContent);
  else if (data.text) aiConversationHistory.push({ role: 'model', parts: [{ text: data.text }] });
  if (data.text) _aiAppendBubble('assistant', data.text);
  _aiNoteToolsOff(data.toolsOff);
}

// The connection dropped mid-turn: keep the wait on screen and take the answer
// from the server when it is ready.
function _aiAwaitLostTurn(turnId, startedAt) {
  setAiStatus('working', { stage: 'thinking', secs: Math.round((Date.now() - startedAt) / 1000) });
  window.AiTurnWait.recover(turnId, (data, ok) => {
    document.body.classList.remove('ai-active');
    setAiStatus('');
    if (data) _aiApplyLateAnswer(data, ok);
    else _aiAppendBubble('assistant', t('ai_wait_lost'));
    _aiToastIfUnseen(startedAt);
  }, (st) => setAiStatus('working', st));
}

// On load: a turn the previous page was waiting on is picked up, so a reload
// in the middle of a creation still delivers it.
function _aiResumePendingTurn() {
  const AW = window.AiTurnWait;
  const saved = AW && AW.pending();
  if (!saved) return;
  document.body.classList.add('ai-active');
  AW.recover(saved.id, (data, ok) => {
    document.body.classList.remove('ai-active');
    setAiStatus('');
    if (data) { _aiApplyLateAnswer(data, ok); _aiToastIfUnseen(saved.at); }
  }, (st) => setAiStatus('working', st));
}

window.aiSendText          = aiSendText;
window.aiAsk               = aiAsk;
window.aiHandleKeydown     = aiHandleKeydown;
