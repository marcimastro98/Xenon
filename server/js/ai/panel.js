// Opens and closes the chat panel, holds the conversation and clears it, and offers to undo the
// last action.
'use strict';

let aiPanelOpen = false;
let aiConversationHistory = [];
let aiConversationSummary = '';   // rolling summary of older turns folded out of the window
// The tool groups this conversation loaded (server ai-tool-groups.js), sent back
// each turn so a group asked for once stays without being asked for again.
let aiToolGroups = [];
let _aiStickyDocs = null;         // recent non-screenshot attachments, re-sent for a few follow-ups
let _aiStickyTurns = 0;           // remaining turns the sticky docs carry forward
let _aiStickyAttach = [];         // the same attachments whole, for their pictures (ai-pictures.js)
const AI_STICKY_TURNS = 2;        // how many follow-up turns a shared document stays in context

// ── Panel control ────────────────────────────────────────────────

function toggleAiPanel() {
  if (aiPanelOpen) closeAiPanel();
  else openAiPanel();
}

function openAiPanel() {
  const overlay = $('ai-overlay');
  if (!overlay) return;
  // Always open in the CHAT view: clear any lingering voice-mode classes from a
  // previous voice session (otherwise the chat stays hidden behind the empty orb).
  // A real voice session re-adds ai-voice-mode right after, so this is safe.
  document.body.classList.remove('ai-voice-mode', 'ai-voice-ambient', 'voice-listening', 'voice-thinking', 'voice-speaking');
  aiPanelOpen = true;
  overlay.hidden = false;
  document.body.classList.add('ai-open');
  _aiRenderWelcomeIfEmpty();
  const input = $('ai-text-input');
  if (input) setTimeout(() => input.focus(), 60);
}

function closeAiPanel() {
  const overlay = $('ai-overlay');
  if (overlay) overlay.hidden = true;
  aiPanelOpen = false;
  document.body.classList.remove('ai-open');
  // Cancel any pending follow-up listening window
  _aiVoiceSessionActive = false;
  _aiVoiceGen++;            // invalidate any in-flight transcription so it can't reopen the panel / run a command
  if (_aiFollowupTimer) { clearTimeout(_aiFollowupTimer); _aiFollowupTimer = null; }
  // Cancel any server recording, the one still opening too (free ffmpeg, no transcription).
  _aiRecorderCancel++;
  _aiDropRecorder(_aiServerRecordingId);
  _aiServerRecordingId = null;
  aiListening = false;
  _aiCloseMonitorPicker();
  _aiStopSpeaking();
  _aiVoiceModeExit();
  stopAiVoice();
  // Deactivate screen mode when panel closes
  _aiScreenMode = false;
  _aiScreenMonitor = null;
  _aiUpdateScreenBtn();
}

function aiClearHistory() {
  if (window.BitTold) BitTold.forget();
  aiConversationHistory = [];
  aiConversationSummary = '';
  aiToolGroups = [];
  _aiStickyDocs = null; _aiStickyAttach = []; _aiStickyTurns = 0;
  const chat = $('ai-chat');
  if (chat) chat.replaceChildren();
  _aiRenderWelcomeIfEmpty();
  setAiStatus('');
  if (typeof mirrorChatCopies === 'function') mirrorChatCopies(); // clear copies too
}

// After a state-changing turn, surface a one-tap "undo" for the most recent
// reversible action (notes overwrite, bulk clear, a just-created task). The
// server owns the short-term action log; the chip just calls it.
async function _aiMaybeShowUndo() {
  let last;
  try {
    const res = await fetch('/api/ai/actions');
    const data = await res.json();
    last = data && data.last;
  } catch { return; }
  if (!last || !last.id) return;
  _aiAppendUndoChip(last.id, last.label || '');
}

// "Annulla" as a quiet line under the reply, above any follow-ups, with no
// Scintille beside it: it takes the change back, not the cost. The click is
// delegated (below), so a chat copy, which mirrors the log as HTML, works too.
function _aiAppendUndoChip(id, label) {
  const chat = $('ai-chat');
  if (!chat) return;
  const row = document.createElement('div');
  row.className = 'ai-undo-row';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ai-undo-btn';
  btn.dataset.undoId = id;
  btn.textContent = t('ai_undo');
  if (label) btn.title = label;
  row.appendChild(btn);
  const last = chat.lastElementChild;
  if (last && last.classList.contains('ai-choices')) chat.insertBefore(row, last);
  else chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
  if (typeof mirrorChatCopies === 'function') mirrorChatCopies();
}

window.toggleAiPanel       = toggleAiPanel;
window.openAiPanel         = openAiPanel;
window.closeAiPanel        = closeAiPanel;
window.aiClearHistory      = aiClearHistory;
