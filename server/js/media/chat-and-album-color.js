// The chat tab of the media tile, with its own copy of the chat box and a small preview of what is
// playing, and the accent color taken from the album cover.
'use strict';

function syncChatCopyPane(pane) {
  const srcChat = document.getElementById('ai-chat');
  const srcStatus = document.getElementById('ai-status');
  const srcInputRow = document.querySelector('.ai-input-row');
  const hasKey = _aiHasKey();

  let log = pane.querySelector('[data-chatf="mirror-log"]');
  if (!log) {
    log = document.createElement('div');
    log.className = 'ai-chat';
    log.setAttribute('data-chatf', 'mirror-log');
    log.setAttribute('aria-live', 'polite');
    log.setAttribute('aria-label', 'Conversazione AI');
    pane.appendChild(log);
  }
  if (srcChat) log.innerHTML = srcChat.innerHTML; // display-only copy of the bubbles
  log.hidden = !hasKey;

  let st = pane.querySelector('[data-chatf="mirror-status"]');
  if (!st) {
    st = document.createElement('div');
    st.setAttribute('data-chatf', 'mirror-status');
    pane.appendChild(st);
  }
  if (srcStatus) { st.className = srcStatus.className; st.innerHTML = srcStatus.innerHTML; }

  // Pending-attachment strip. Unlike the log it is NOT an innerHTML copy: ai.js
  // renders every .ai-attach-preview from the shared _aiPendingImages, so the
  // thumbnails and their remove buttons stay live in a copy. Without it a paste
  // into this pane would add an attachment the user could never see or remove.
  let prev = pane.querySelector('[data-chatf="mirror-preview"]');
  if (!prev) {
    prev = document.createElement('div');
    prev.className = 'ai-attach-preview';
    prev.setAttribute('data-chatf', 'mirror-preview');
    prev.setAttribute('aria-label', 'Allegati in attesa');
    prev.hidden = true;
    pane.appendChild(prev);
  }

  let row = pane.querySelector('[data-chatf="mirror-input"]');
  if (!row) { row = buildChatCopyInput(); pane.appendChild(row); }
  row.hidden = srcInputRow ? srcInputRow.hidden : !hasKey;
  // Keep the strip directly above the composer even if the row predates it.
  if (prev.nextElementSibling !== row) pane.insertBefore(prev, row);

  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

// A copy's input row: just a text field + send button. Voice, attach, screen capture
// and reset stay singleton on the primary; sending forwards to the shared session.
function buildChatCopyInput() {
  const row = document.createElement('div');
  row.className = 'ai-input-row';
  row.setAttribute('data-chatf', 'mirror-input');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ai-text-input';
  input.maxLength = 500;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('data-i18n-placeholder', 'ai_placeholder');
  input.placeholder = (typeof t === 'function' ? t('ai_placeholder') : 'Chiedi a Xenon…');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatFromCopy(input); }
  });
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'ai-send-btn';
  send.title = (typeof t === 'function' ? t('tip_send') : 'Invia');
  send.innerHTML = '<svg class="ai-send-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>'
    + '<svg class="ai-stop-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>';
  // While a reply is on its way the button is the shared turn's stop (ai.js).
  send.addEventListener('click', () => {
    if (typeof aiTurnRunning === 'function' && aiTurnRunning()) aiStopTurn();
    else sendChatFromCopy(input);
  });
  row.append(input, send);
  return row;
}

function sendChatFromCopy(input) {
  const text = (input.value || '').trim();
  // Mirrors the primary composer: a pasted image with no caption is sendable.
  // _aiPendingImages is a top-level binding in ai.js — both files are classic
  // scripts, so it resolves through the shared global scope at call time.
  const pending = typeof _aiPendingImages !== 'undefined' ? _aiPendingImages.length : 0;
  if (!text && pending === 0) return;
  input.value = '';
  if (window.BitComposer) BitComposer.sync();
  if (typeof aiSendMessage === 'function') aiSendMessage(text, false); // shared session, no TTS
}

// Chat visibility is now governed by the layout (the chat atom / its group), not
// a Media-tile tab. Kept as a no-op for any legacy caller.
function applyMediaChatVisibility() { /* no-op — chat is its own atom now */ }

// Mini now-playing preview shown at the top of the Chat tab while music plays,
// plus the blurred album cover behind the chat. Shown whenever there is active
// media (the chat is its own atom now, so it is no longer gated on a tab class).
function updateMediaChatPreview() {
  const playing = typeof hasActiveMedia === 'function' && hasActiveMedia();
  const thumb = (mediaData && mediaData.thumbnail) || _lastThumb || '';
  const showBg = playing && !!thumb;
  const titleText = (mediaData && cleanTitle(mediaData.title)) || t('media_unknown_title');
  const artistText = (mediaData && (mediaData.artist || mediaData.album)) || '';
  const isPlaying = mediaData && mediaData.playbackStatus === 'Playing';
  // Update the now-playing preview + blurred cover in every chat instance (primary + copies).
  document.querySelectorAll('[data-dashboard-widget="chat"]').forEach(panel => {
    const chatBg = panel.querySelector('[data-chatf="bg"]');
    if (chatBg) chatBg.style.backgroundImage = showBg ? `url("${thumb}")` : '';
    panel.classList.toggle('has-cover', showBg);
    const np = panel.querySelector('[data-chatf="np"]');
    if (!np) return;
    np.hidden = !playing;
    if (!playing) return;
    const cover = panel.querySelector('[data-chatf="np-cover"]');
    const title = panel.querySelector('[data-chatf="np-title"]');
    const artist = panel.querySelector('[data-chatf="np-artist"]');
    if (cover) {
      cover.style.backgroundImage = thumb ? `url("${thumb}")` : '';
      cover.classList.toggle('has-image', !!thumb);
    }
    if (title) title.textContent = titleText;
    if (artist) artist.textContent = artistText;
    const p = panel.querySelector('[data-chatf="np-play"]');
    const pa = panel.querySelector('[data-chatf="np-pause"]');
    if (p) p.style.display = isPlaying ? 'none' : '';
    if (pa) pa.style.display = isPlaying ? '' : 'none';
  });
  // Keep the Deck widget's optional now-playing dock in sync with the same state.
  if (window.Deck && window.Deck.updateMedia) window.Deck.updateMedia();
}

// Topbar ✦ — reveal/activate the Chat atom (its own tile, or its tab if grouped),
// add it to the current page if hidden, then focus the input.
function openMediaChat() {
  if (typeof getDashboardLayout !== 'function') return;
  const layout = getDashboardLayout();
  const gid = window.DashboardTabGroups && window.DashboardTabGroups.widgetGroupOf(layout.groups || {}, 'chat');
  if (gid) {
    window.DashboardTabGroups.setGroupActive(gid, 'chat');
  } else if (window.DashboardGrid && layout.widgets.chat && !layout.widgets.chat.visible) {
    const page = (window.DashboardPager && window.DashboardPager.getCurrentPage && window.DashboardPager.getCurrentPage()) || 'dashboard';
    window.DashboardGrid.addWidgetToPage('chat', page);
  }
  const tile = document.querySelector('[data-dashboard-widget="chat"]');
  const sec = tile && tile.closest('.pager-page');
  if (sec && sec.dataset.page && window.DashboardPager) window.DashboardPager.goToPage(sec.dataset.page);
  const input = document.getElementById('ai-text-input');
  if (input) setTimeout(() => { try { input.focus(); } catch (e) { /* ignore */ } }, 0);
}

// ── Dynamic album-art accent ──────────────────────────────────────
// Extract one vibrant colour from the now-playing cover (album-theme.js) and feed
// it to two consumers: the UI theme (settings.js applies it as a runtime accent
// override) and the RGB LEDs (server bridge). Each side has its own user toggle —
// the theme via dynamicAlbumTheme, the LEDs via the musicAlbum lighting effect —
// so this just supplies the colour and lets each consumer honour its setting. An
// empty thumb clears both back to their defaults.
let _albumAccentThumb = '';
let _lastAlbumLedHex = null; // de-dupe identical LED pushes across media ticks

// `pair` is { accent, led, ledPalette } from album-theme.js, or null. The UI
// theme gets the readability-clamped variant; the LEDs get the full-vividness
// variant of the same hue (the clamped accent rendered as a washed-out pastel
// on RGB LEDs, which made every cover look alike) plus the 2-3 colour palette
// the bridge spreads across each device's LEDs as a gradient.
function applyAlbumColor(pair) {
  if (typeof setDynamicAccent === 'function') setDynamicAccent(pair ? pair.accent : null);
  pushAlbumToLighting(pair);
  // Same colours the LEDs get: the waveform is tinted by the cover it sits under.
  if (window.MediaViz) window.MediaViz.setPalette(pair);
}

// Best-effort push of the cover colour(s) to the lighting bridge. The server
// ignores it when the bridge is off or the musicAlbum effect is disabled, so
// it's safe to send unconditionally; we only skip repeats of the same colours.
function pushAlbumToLighting(pair) {
  // The dashboard feeds the LEDs; a layer window showing the same cover would send it twice.
  if (typeof isLayerPage === 'function' && isLayerPage()) return;
  const color = (pair && pair.led) || null;
  const palette = (pair && Array.isArray(pair.ledPalette) && pair.ledPalette.length >= 2) ? pair.ledPalette : null;
  const key = color ? color + '|' + (palette ? palette.join(',') : '') : null;
  if (key === _lastAlbumLedHex) return;
  _lastAlbumLedHex = key;
  try {
    fetch('/api/lighting/album', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(color ? { color, palette } : { clear: true }),
    });
  } catch (e) { /* lighting is best-effort; never block media UI */ }
}

// ── Late-thumbnail retry ──────────────────────────────────────────
// Windows often publishes the cover art a beat AFTER the track metadata, so the
// update that announces a new song frequently carries no thumbnail yet — the
// tile shows no cover and the album accent/LEDs fall back to defaults until the
// next unrelated refresh. When a *playing* track has no art, re-fetch a couple
// of times (past the server's media cache window) to pick up the late cover.
let _thumbRetryKey = '';
let _thumbRetryCount = 0;
let _thumbRetryTimer = null;

function retryLateThumbnail(trackKey, thumb, playing) {
  if (thumb || !playing || !trackKey || trackKey === '|') {
    _thumbRetryKey = thumb ? trackKey : '';
    _thumbRetryCount = 0;
    if (_thumbRetryTimer) { clearTimeout(_thumbRetryTimer); _thumbRetryTimer = null; }
    return;
  }
  if (trackKey !== _thumbRetryKey) { _thumbRetryKey = trackKey; _thumbRetryCount = 0; }
  if (_thumbRetryCount >= 2 || _thumbRetryTimer) return;
  _thumbRetryCount++;
  _thumbRetryTimer = setTimeout(() => {
    _thumbRetryTimer = null;
    fetchMedia();
  }, 2000);
}

function updateAlbumAccent(thumb) {
  if (!thumb) { _albumAccentThumb = ''; applyAlbumColor(null); return; }
  if (thumb === _albumAccentThumb) return; // same cover, already applied
  _albumAccentThumb = thumb;
  if (typeof extractAlbumAccent !== 'function') { applyAlbumColor(null); return; }
  extractAlbumAccent(thumb).then(pair => {
    if (thumb === _albumAccentThumb) applyAlbumColor(pair); // ignore stale covers
  });
}

// Re-run extraction for the current cover — used when a feature is toggled on.
function refreshAlbumAccent() {
  const thumb = (mediaData && mediaData.thumbnail) || _lastThumb || '';
  _albumAccentThumb = '';
  _lastAlbumLedHex = null;
  updateAlbumAccent(thumb);
}
