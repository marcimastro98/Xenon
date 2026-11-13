// Which player the media tile follows, the tile's tabs, and whether its chat tab can answer.
'use strict';

const MEDIA_SOURCE_STORAGE_KEY = 'xeneonedge.mediaSource.v1';

function normalizeMediaSource(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240);
}

function mediaSourceRequestUrl() {
  return `${SERVER}/media?source=${encodeURIComponent(preferredMediaSource)}`;
}

function mediaSessionLabel(session) {
  // Resolve browser sessions to their real service (Twitch/YouTube/…) so the
  // source picker agrees with the badge; track=false to avoid pinning the live
  // badge's remembered stream to a transient picker row.
  const refined = refineBrowserApp(session, false);
  const app = localizeAppName(refined) || refined || session.source || t('media');
  const title = cleanTitle(session.title);
  const detail = title || session.artist || session.album || session.playbackStatus || '';
  return detail ? `${app} - ${detail}` : app;
}

function isActiveMediaSession(session) {
  if (!session) return false;
  if (session.activePlayback === true) return true;
  return String(session.playbackStatus || '').toLowerCase() === 'playing' &&
    !!(session.title || session.artist || session.app);
}

function syncMediaSourceSelectLabel(select) {
  const wrap = select ? select.previousElementSibling : null;
  const label = wrap && wrap.classList.contains('cs-wrap') ? wrap.querySelector('.cs-label') : null;
  const option = select ? Array.from(select.options).find(item => item.value === select.value) : null;
  if (label && option) label.textContent = option.textContent.trim();
}

async function postPreferredMediaSource(source) {
  try {
    await fetch(SERVER + '/media/source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
      keepalive: true,
    });
  } catch { }
}

function syncLockMediaPlaybackIcon(playing) {
  const lockPlayIcon = $('lock-media-play');
  const lockPauseIcon = $('lock-media-pause');
  if (lockPlayIcon) {
    lockPlayIcon.hidden = false;
    lockPlayIcon.style.display = playing ? 'none' : '';
  }
  if (lockPauseIcon) {
    lockPauseIcon.hidden = false;
    lockPauseIcon.style.display = playing ? '' : 'none';
  }
}

function preferredMediaView() {
  return typeof getDashboardMediaView === 'function' ? getDashboardMediaView() : 'media';
}

// ── Media tile tabs: Riproduzione | Chat (AI) ────────────────────
let _mediaTabUserPicked = false;

// Tabs are now provided by the generic tab-group (Playback + Chat live in the
// seeded `media-group`). Kept as a harmless shim for any legacy caller.
function setMediaTab() { /* no-op — see dashboard-tabgroups.js */ }

// Relocate the AI text chat (chat log + status + attachment preview + input row)
// out of the voice overlay and into the media tile's Chat tab. The overlay keeps
// the voice orb. Reuses all existing AI logic (ids preserved).
function initMediaChat() {
  const pane = document.getElementById('media-pane-chat');
  if (!pane) return;
  ['ai-chat', 'ai-status', 'ai-attach-preview'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.parentElement !== pane) pane.appendChild(el);
  });
  // Exclude mirror copies ([data-chatf="mirror-input"]) so we always move the real
  // primary input row even if a stale mirror was somehow added to the pane first.
  const inputRow = document.querySelector('.ai-input-row:not([data-chatf])');
  if (inputRow && inputRow.parentElement !== pane) pane.appendChild(inputRow);
  if (window.BitChat) BitChat.mountHeads();
  if (typeof _aiRenderWelcomeIfEmpty === 'function') _aiRenderWelcomeIfEmpty();
  updateMediaChatKeyState();
  applyMediaChatVisibility();
  // Default to Chat when nothing is playing (fills the otherwise-empty media tile).
  if (!(typeof hubSettings === 'object' && hubSettings && hubSettings.aiChatHidden)) {
    const playing = typeof hasActiveMedia === 'function' && hasActiveMedia();
    setMediaTab(playing ? 'play' : 'chat', false);
  }
}

// Auto-switch tabs with media state until the user manually picks a tab:
// playing → Playback, idle → the other tab, the Agenda (the Chat on a layout
// from before 5.0.0, which keeps it there).
function mediaAutoTab() {
  if (window._mediaTabUserPicked) return; // user manually chose a tab — don't fight them
  if (typeof getDashboardLayout !== 'function' || !window.DashboardTabGroups) return;
  const layout = getDashboardLayout();
  const g = layout.groups && layout.groups['media-group'];
  if (!g || !g.autoTabByMedia) return;
  const playing = typeof hasActiveMedia === 'function' && hasActiveMedia();
  const want = playing ? 'media' : (g.members.includes('chat') ? 'chat' : 'agenda');
  if (g.members.includes(want) && g.active !== want) window.DashboardTabGroups.setGroupActive('media-group', want, false);
}

function _aiHasKey() {
  if (typeof hubSettings !== 'object' || !hubSettings) return false;
  // Provider-aware readiness (mirrors ai.js _aiProviderReady): local always ok;
  // ChatGPT/Claude use the server-only *Set flags; Gemini uses its browser key.
  const p = hubSettings.aiProvider;
  if (p === 'ollama' || p === 'localapi') return true;
  if (p === 'claudecode' || p === 'codex') return true;   // the program's own sign-in
  if (p === 'xenon') return !window.XenonCredits || XenonCredits.canAnswer();
  if (p === 'openai') return !!hubSettings.openaiApiKeySet;
  if (p === 'anthropic') return !!hubSettings.anthropicApiKeySet;
  return geminiKeyReady(hubSettings);
}

// The Sparks were read after the chat was drawn: on Bit they decide whether it can
// answer, so the notice follows them. Only on a change, as this function syncs them.
let _chatCouldAnswer = null;
function followXenonCredits() {
  const can = _aiHasKey();
  if (can === _chatCouldAnswer) return;
  _chatCouldAnswer = can;
  updateMediaChatKeyState();
}

// Show the "AI unavailable" notice + hide the chat log/input when no API key is set.
// The notice exists in every chat instance (primary + copies), so toggle them all.
function updateMediaChatKeyState() {
  const hasKey = _aiHasKey();
  document.querySelectorAll('[data-chatf="nokey"]').forEach(n => { n.hidden = hasKey; });
  const chat = document.getElementById('ai-chat');
  const inputRow = document.querySelector('.ai-input-row');
  if (chat) chat.hidden = !hasKey;
  if (inputRow) inputRow.hidden = !hasKey;
  // A provider that just became ready (a key saved, Bit picked) opens on the
  // welcome, not on an empty log; it only fills a chat that is still empty.
  if (hasKey && typeof _aiRenderWelcomeIfEmpty === 'function') _aiRenderWelcomeIfEmpty();
  mirrorChatCopies();
  // The AI settings may have changed: the credits chips follow, and a supporter
  // whose assistant cannot answer gets Xenon AI.
  if (window.XenonCredits) XenonCredits.sync();
}

// ── Chat duplication (mirror) ────────────────────────────────────
// The Xenon AI session is a singleton: initMediaChat() moves #ai-chat / #ai-status /
// #ai-attach-preview / .ai-input-row (and the voice orb logic) into the PRIMARY chat
// pane. A duplicated chat copy can't hold those, so each copy gets a read-only mirror
// of the message log + a thin text input that forwards to the same shared session via
// aiSendMessage(). Idempotent and cheap when no copies exist (the loop is empty).
function mirrorChatCopies() {
  const srcChat = document.getElementById('ai-chat');
  const primaryPane = srcChat ? srcChat.closest('[data-chatf="pane"]') : null;
  // If the primary chat hasn't been relocated into a pane yet (initMediaChat() hasn't
  // run), primaryPane is null. Returning early prevents syncChatCopyPane() from
  // treating the primary pane as a copy and inserting mirror elements before the real
  // chat elements — which would break the visual order.
  if (!primaryPane) return;
  if (window.BitChat) BitChat.mountHeads(); // a copy made since gets its own live Bit
  document.querySelectorAll('[data-chatf="pane"]').forEach(pane => {
    if (pane === primaryPane) return; // primary keeps the live session
    syncChatCopyPane(pane);
  });
  // Fill any strip this pass created: the pending attachments are a singleton, so
  // one render pass paints the primary and every copy with the same list.
  if (typeof _aiUpdateAttachPreview === 'function') _aiUpdateAttachPreview();
  // A copy's log has its own height, so Bit's welcome is fitted in each one.
  if (window.BitWelcome) BitWelcome.fit();
}
