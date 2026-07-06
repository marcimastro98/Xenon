'use strict';

const MEDIA_SOURCE_STORAGE_KEY = 'xeneonedge.mediaSource.v1';
let preferredMediaSource = normalizeMediaSource(localStorage.getItem(MEDIA_SOURCE_STORAGE_KEY));

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

function renderMediaSourcePicker(data) {
  const picker = $('media-source-picker');
  const select = $('media-source-select');
  if (!picker || !select) return;

  const sessions = Array.isArray(data && data.sessions) ? data.sessions.filter(isActiveMediaSession) : [];
  const uniqueSessions = [];
  const seenSources = new Set();
  sessions.forEach(session => {
    const source = normalizeMediaSource(session && session.source);
    if (!source || seenSources.has(source)) return;
    seenSources.add(source);
    uniqueSessions.push({ ...session, source });
  });

  picker.hidden = uniqueSessions.length < 2;
  if (picker.hidden) {
    if (preferredMediaSource && !seenSources.has(preferredMediaSource)) {
      preferredMediaSource = '';
      localStorage.removeItem(MEDIA_SOURCE_STORAGE_KEY);
      postPreferredMediaSource('');
    }
    return;
  }

  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = t('media_source_auto');
  const options = [auto, ...uniqueSessions.map(session => {
    const option = document.createElement('option');
    option.value = session.source;
    option.textContent = mediaSessionLabel(session);
    return option;
  })];

  select.replaceChildren(...options);
  select.value = seenSources.has(preferredMediaSource) ? preferredMediaSource : '';
  syncMediaSourceSelectLabel(select);
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

function setPreferredMediaSource(source) {
  const next = normalizeMediaSource(source);
  if (next === preferredMediaSource) return;
  preferredMediaSource = next;
  if (preferredMediaSource) localStorage.setItem(MEDIA_SOURCE_STORAGE_KEY, preferredMediaSource);
  else localStorage.removeItem(MEDIA_SOURCE_STORAGE_KEY);
  postPreferredMediaSource(preferredMediaSource);
  fetchMedia();
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
// playing → Riproduzione, idle → Chat.
// Seeded media-group nicety: auto-select Riproduzione/Chat by playback state.
function mediaAutoTab() {
  if (window._mediaTabUserPicked) return; // user manually chose a tab — don't fight them
  if (typeof getDashboardLayout !== 'function' || !window.DashboardTabGroups) return;
  const layout = getDashboardLayout();
  const g = layout.groups && layout.groups['media-group'];
  if (!g || !g.autoTabByMedia) return;
  const playing = typeof hasActiveMedia === 'function' && hasActiveMedia();
  const want = playing ? 'media' : 'chat';
  if (g.members.includes(want) && g.active !== want) window.DashboardTabGroups.setGroupActive('media-group', want, false);
}

function _aiHasKey() {
  return !!(typeof hubSettings === 'object' && hubSettings && hubSettings.geminiApiKey);
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
  mirrorChatCopies();
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
  document.querySelectorAll('[data-chatf="pane"]').forEach(pane => {
    if (pane === primaryPane) return; // primary keeps the live session
    syncChatCopyPane(pane);
  });
}

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

  let row = pane.querySelector('[data-chatf="mirror-input"]');
  if (!row) { row = buildChatCopyInput(); pane.appendChild(row); }
  row.hidden = srcInputRow ? srcInputRow.hidden : !hasKey;

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
  send.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
  send.addEventListener('click', () => sendChatFromCopy(input));
  row.append(input, send);
  return row;
}

function sendChatFromCopy(input) {
  const text = (input.value || '').trim();
  if (!text) return;
  input.value = '';
  if (typeof aiSendMessage === 'function') aiSendMessage(text, false); // shared session, no TTS
}

// Chat visibility is now governed by the layout (the chat atom / its group), not
// a Media-tile tab. Kept as no-ops for any legacy caller.
function applyMediaChatVisibility() { /* no-op — chat is its own atom now */ }
function hideMediaChat() { /* no-op — hide/extract the Chat atom via Layout mode */ }

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

let _lastThumb = '';
let _lastThumbKey = '';

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
}

// Best-effort push of the cover colour(s) to the lighting bridge. The server
// ignores it when the bridge is off or the musicAlbum effect is disabled, so
// it's safe to send unconditionally; we only skip repeats of the same colours.
function pushAlbumToLighting(pair) {
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

function mf(root, name) { return root.querySelector('[data-mf="' + name + '"]'); }
function eachMedia(fn) {
  if (window.DashboardGrid && window.DashboardGrid.forEachInstance) window.DashboardGrid.forEachInstance('media', fn);
}
// Update ONE media tile instance's display from a prepared context object.
function applyMediaInto(root, ctx) {
  root.classList.remove('spotify', 'youtube', 'twitch');
  const app = mf(root, 'media-app'), title = mf(root, 'media-title'), artist = mf(root, 'media-artist');
  const art = mf(root, 'media-art'), bg = mf(root, 'media-bg');
  const pi = mf(root, 'play-icon'), pa = mf(root, 'pause-icon');
  if (ctx.empty) {
    if (app) app.textContent = t('media');
    if (title) title.textContent = t('media_empty_title');
    if (artist) artist.textContent = t('media_empty_sub');
    if (art) { art.classList.remove('has-image'); art.style.backgroundImage = ''; }
    root.classList.remove('has-image');
    if (bg) bg.style.backgroundImage = '';
    if (pi) pi.style.display = '';
    if (pa) pa.style.display = 'none';
    return;
  }
  if (ctx.isSpotify) root.classList.add('spotify');
  if (ctx.isYoutube) root.classList.add('youtube');
  if (ctx.isTwitch) root.classList.add('twitch');
  if (app) app.textContent = ctx.app;
  if (title) title.textContent = ctx.title;
  if (artist) artist.textContent = ctx.artist;
  if (ctx.thumb) {
    if (art) { art.classList.add('has-image'); art.style.backgroundImage = `url("${ctx.thumb}")`; }
    root.classList.add('has-image');
    if (bg) bg.style.backgroundImage = `url("${ctx.thumb}")`;
  } else {
    if (art) { art.classList.remove('has-image'); art.style.backgroundImage = ''; }
    root.classList.remove('has-image');
    if (bg) bg.style.backgroundImage = '';
  }
  if (pi) pi.style.display = ctx.playing ? 'none' : '';
  if (pa) pa.style.display = ctx.playing ? '' : 'none';
}

function applyMedia(data) {
  mediaData = data;
  renderMediaSourcePicker(data);
  if (!$('media-panel')) return; // media tile transiently detached (tab-group build)

  const active = data && data.active && (data.title || data.artist || data.app);
  if (!active) {
    refreshMediaEmpty();
    calendarAutoShown = preferredMediaView() !== 'calendar';
    showCalendar(true, true);
    updateCalendarMiniPlayer();
    mediaAutoTab();
    updateMediaChatPreview();
    return;
  }

  if (calendarAutoShown) {
    calendarAutoShown = false;
    showCalendar(preferredMediaView() === 'calendar', true);
  }
  mediaAutoTab();

  // Browser playback only tells us the host browser via SMTC — resolve the real
  // service (Twitch/YouTube/…) so the badge, mini-player and chat preview agree.
  // track=true keeps the identity across tab focus changes (background-tab case).
  data.app = refineBrowserApp(data, true);
  const app = localizeAppName(data.app) || t('media');
  const trackKey = `${data.title || ''}|${data.artist || data.album || ''}`;
  if (data.thumbnail) { _lastThumb = data.thumbnail; _lastThumbKey = trackKey; }
  else if (trackKey !== _lastThumbKey) { _lastThumb = ''; }
  const thumb = data.thumbnail || _lastThumb;
  // Broadcast ticks strip the thumbnail for an unchanged track (server saves the
  // ~100KB base64). Backfill the resolved art onto the shared mediaData so every
  // direct consumer — lockscreen cover, mini-player, deck media face, the SDK
  // stream relay — keeps showing it instead of clearing on each stripped tick.
  data.thumbnail = thumb;
  const playing = data.playbackStatus === 'Playing';
  retryLateThumbnail(trackKey, thumb, playing);
  const ctx = {
    empty: false, app,
    title: cleanTitle(data.title) || t('media_unknown_title'),
    artist: data.artist || data.album || '',
    thumb, playing,
    isSpotify: /spotify/i.test(app), isYoutube: /youtube/i.test(app), isTwitch: /twitch/i.test(app),
  };
  eachMedia(root => applyMediaInto(root, ctx));

  updateAlbumAccent(thumb);
  syncLockMediaPlaybackIcon(playing);
  updateCalendarMiniPlayer();
  updateMediaChatPreview();
  updateMediaSource();
  if (window.MediaSpotify) window.MediaSpotify.sync();
}

function hasActiveMedia() {
  return !!(mediaData && mediaData.active && (mediaData.title || mediaData.artist || mediaData.app));
}

function updateCalendarMiniPlayer() {
  const mini = $('calendar-mini-player');
  if (!mini) return;
  if (!calendarMode || !hasActiveMedia()) {
    mini.classList.remove('show');
    const cover = $('mini-media-cover');
    if (cover) {
      cover.classList.remove('has-image');
      cover.style.backgroundImage = '';
    }
    return;
  }
  const title = cleanTitle(mediaData.title) || localizeAppName(mediaData.app) || t('now_playing');
  $('mini-media-title').textContent = title;
  $('mini-media-sub').textContent = [mediaData.artist || mediaData.album, localizeAppName(mediaData.app)].filter(Boolean).join(' - ') || t('active_player');
  const cover = $('mini-media-cover');
  if (cover) {
    cover.classList.toggle('has-image', !!mediaData.thumbnail);
    cover.style.backgroundImage = mediaData.thumbnail ? `url("${mediaData.thumbnail}")` : '';
  }
  const playing = mediaData.playbackStatus === 'Playing';
  $('mini-play-icon').style.display = playing ? 'none' : '';
  $('mini-pause-icon').style.display = playing ? '' : 'none';
  syncLockMediaPlaybackIcon(playing);
  mini.classList.add('show');
}

function refreshMediaEmpty() {
  renderMediaSourcePicker(null);
  _lastThumb = '';
  _lastThumbKey = '';
  updateAlbumAccent(''); // no media → restore the user's saved accent
  if (!$('media-panel')) return; // media tile transiently detached
  eachMedia(root => applyMediaInto(root, { empty: true }));
  syncLockMediaPlaybackIcon(false);
  updateMediaSource();
  if (window.MediaSpotify) window.MediaSpotify.sync();
}

// ── Source icon + per-app volume ──────────────────────────────────
// Official brand marks for the most common sources; for any other app the real
// icon extracted from its executable (via the matched audio session) is used.
const MEDIA_BRAND_ICONS = {
  spotify: { cls: 'brand-spotify', svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.6 14.42a.62.62 0 0 1-.86.2c-2.35-1.43-5.3-1.76-8.79-.96a.62.62 0 1 1-.28-1.2c3.82-.88 7.09-.5 9.73 1.1.29.18.38.56.2.86Zm1.23-2.73a.78.78 0 0 1-1.07.25c-2.69-1.65-6.79-2.13-9.97-1.17a.78.78 0 0 1-.45-1.49c3.63-1.1 8.15-.56 11.24 1.33.36.22.48.7.25 1.07Zm.11-2.86C14.83 8.94 9.5 8.76 6.4 9.7a.94.94 0 1 1-.54-1.8c3.56-1.08 9.45-.86 13.18 1.36a.94.94 0 1 1-.96 1.62Z"/></svg>' },
  youtube: { cls: 'brand-youtube', svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23 12s0-3.18-.4-4.7a2.5 2.5 0 0 0-1.77-1.77C19.31 5.13 12 5.13 12 5.13s-7.31 0-8.83.4A2.5 2.5 0 0 0 1.4 7.3C1 8.82 1 12 1 12s0 3.18.4 4.7a2.5 2.5 0 0 0 1.77 1.77c1.52.4 8.83.4 8.83.4s7.31 0 8.83-.4a2.5 2.5 0 0 0 1.77-1.77C23 15.18 23 12 23 12Zm-13.4 3.02V8.98L15.27 12 9.6 15.02Z"/></svg>' },
  // Official brand marks (simple-icons) for the most common browser sources.
  twitch: { cls: 'brand-twitch', svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/></svg>' },
  soundcloud: { cls: 'brand-soundcloud', svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.999 14.165c-.052 1.796-1.612 3.169-3.4 3.169h-8.18a.68.68 0 0 1-.675-.683V7.862a.747.747 0 0 1 .452-.724s.75-.513 2.333-.513a5.364 5.364 0 0 1 2.763.755 5.433 5.433 0 0 1 2.57 3.54c.282-.08.574-.121.868-.12.884 0 1.73.358 2.347.992s.948 1.49.922 2.373ZM10.721 8.421c.247 2.98.427 5.697 0 8.672a.264.264 0 0 1-.53 0c-.395-2.946-.22-5.718 0-8.672a.264.264 0 0 1 .53 0ZM9.072 9.448c.285 2.659.37 4.986-.006 7.655a.277.277 0 0 1-.55 0c-.331-2.63-.256-5.02 0-7.655a.277.277 0 0 1 .556 0Zm-1.663-.257c.27 2.726.39 5.171 0 7.904a.266.266 0 0 1-.532 0c-.38-2.69-.257-5.21 0-7.904a.266.266 0 0 1 .532 0Zm-1.647.77a26.108 26.108 0 0 1-.008 7.147.272.272 0 0 1-.542 0 27.955 27.955 0 0 1 0-7.147.275.275 0 0 1 .55 0Zm-1.67 1.769c.421 1.865.228 3.5-.029 5.388a.257.257 0 0 1-.514 0c-.21-1.858-.398-3.549 0-5.389a.272.272 0 0 1 .543 0Zm-1.655-.273c.388 1.897.26 3.508-.01 5.412-.026.28-.514.283-.54 0-.244-1.878-.347-3.54-.01-5.412a.283.283 0 0 1 .56 0Zm-1.668.911c.4 1.268.257 2.292-.026 3.572a.257.257 0 0 1-.514 0c-.241-1.262-.354-2.312-.023-3.572a.283.283 0 0 1 .563 0Z"/></svg>' },
};
const MEDIA_GENERIC_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 17.5a2.5 2.5 0 1 1-2.5-2.5c.35 0 .68.07.97.18L7.5 6.2 18 4v8.5a2.5 2.5 0 1 1-1.5-2.29V6.2L9 7.6v9.9Z"/></svg>';

// A media source maps to one or more candidate audio-session process names.
const BROWSER_TOKENS = ['chrome', 'msedge', 'firefox', 'opera', 'brave', 'vivaldi'];
const MEDIA_APP_PROC_TOKENS = {
  spotify: ['spotify'],
  youtube: BROWSER_TOKENS,
  twitch: BROWSER_TOKENS,
  soundcloud: BROWSER_TOKENS,
  chrome: ['chrome'],
  edge: ['msedge'],
  firefox: ['firefox'],
  brave: ['brave'],
  opera: ['opera'],
  vivaldi: ['vivaldi'],
  tidal: ['tidal'],
  deezer: ['deezer', 'chrome', 'msedge'],
  vlc: ['vlc'],
};

// SMTC reports only the host browser for web playback — never the site. When the
// source is a browser we resolve the real service from the browser audio
// session's window title (Twitch/YouTube/SoundCloud all set it), falling back to
// the SMTC title/album, and finally to naming the browser itself (shown with its
// own icon) rather than guessing "YouTube" for everything.
const BROWSER_SOURCE_RE = /chrome|msedge|edge|firefox|brave|opera|vivaldi/i;
const MEDIA_SITE_PATTERNS = [
  { re: /\byoutube\b/i, app: 'YouTube' },
  { re: /\btwitch\b/i, app: 'Twitch' },
  { re: /soundcloud/i, app: 'SoundCloud' },
  { re: /\bspotify\b/i, app: 'Spotify' },
];
const BROWSER_LABELS = [
  { re: /msedge|edge/i, app: 'Edge' },
  { re: /chrome/i, app: 'Chrome' },
  { re: /firefox/i, app: 'Firefox' },
  { re: /brave/i, app: 'Brave' },
  { re: /opera/i, app: 'Opera' },
  { re: /vivaldi/i, app: 'Vivaldi' },
];

function browserMediaSessions() {
  const apps = (typeof audioData !== 'undefined' && audioData && Array.isArray(audioData.speakerApps)) ? audioData.speakerApps : [];
  return apps.filter(a => BROWSER_SOURCE_RE.test(String(a.proc || '')));
}

// The window title only reveals the ACTIVE browser tab, so a stream playing in a
// background tab would lose its identity. SMTC metadata, however, keeps reporting
// the tab that's actually playing — so once we've identified a stream while it
// was focused we remember it (keyed by its SMTC identity) and keep showing that
// service for as long as the same stream plays. One slot is enough: a single
// active track is the norm, and the picker enumeration passes track=false.
let _browserSiteMemo = { key: '', app: '' };
function browserStreamKey(data) {
  // source + a stable discriminator (channel/artist, else the track title) so a
  // Twitch stream or a given video keeps one key across tab focus changes.
  return String(data.source || '') + '|' + String(data.artist || data.title || '');
}

// Resolve what a browser-sourced media session is actually playing. Non-browser
// sources (Spotify app, media players) are returned untouched. `track` enables
// the background-tab memory (on for the live badge, off for picker enumeration
// so transient rows can't pollute the remembered stream).
function refineBrowserApp(data, track) {
  if (!data || !BROWSER_SOURCE_RE.test(String(data.source || ''))) return (data && data.app) || '';
  const sessions = browserMediaSessions();
  const haystack = sessions.map(s => String(s.win || ''))
    .concat([String(data.title || ''), String(data.album || '')]);
  for (const pattern of MEDIA_SITE_PATTERNS) {
    if (haystack.some(text => text && pattern.re.test(text))) {
      if (track) _browserSiteMemo = { key: browserStreamKey(data), app: pattern.app };
      return pattern.app;
    }
  }
  // Detection failed — e.g. the stream moved to a background tab and the window
  // title now shows a different page. If it's the same stream we identified while
  // focused, keep naming that service instead of falling back to the browser.
  if (track && _browserSiteMemo.app && _browserSiteMemo.key === browserStreamKey(data)) {
    return _browserSiteMemo.app;
  }
  // Site genuinely unknown → name the browser itself; its real icon resolves downstream.
  const probe = (sessions.length ? String(sessions[0].proc || '') : '') || String(data.source || '');
  for (const browser of BROWSER_LABELS) if (browser.re.test(probe)) return browser.app;
  return data.app || '';
}

function mediaBrandIcon(app) {
  const raw = String(app || '').toLowerCase();
  for (const key in MEDIA_BRAND_ICONS) {
    if (raw.includes(key)) return MEDIA_BRAND_ICONS[key];
  }
  return null;
}

// Find the speaker audio session that belongs to the current media source, so
// its volume can be controlled directly from the media tile.
function findMediaAppSession() {
  if (!hasActiveMedia()) return null;
  const apps = (audioData && Array.isArray(audioData.speakerApps)) ? audioData.speakerApps : [];
  if (!apps.length) return null;
  const raw = String(mediaData.app || '').toLowerCase().trim();
  if (!raw) return null;
  let tokens = [];
  for (const key in MEDIA_APP_PROC_TOKENS) {
    if (raw.includes(key)) { tokens = MEDIA_APP_PROC_TOKENS[key]; break; }
  }
  const candidates = tokens.concat([raw, raw.replace(/\s+/g, '')]);
  const norm = value => String(value || '').toLowerCase().replace(/\.exe$/, '');
  return apps.find(app => {
    const proc = norm(app.proc);
    const name = norm(app.name);
    return candidates.some(token => token && (proc.includes(token) || name.includes(token)));
  }) || null;
}

function updateMediaSourceIcon(session) {
  const el = $('media-app-icon');
  if (!el) return;
  el.className = 'media-app-icon';
  const brand = mediaBrandIcon(mediaData && mediaData.app);
  if (brand) { el.classList.add(brand.cls); el.innerHTML = brand.svg; return; }
  if (session && session.icon) {
    // Build via DOM so the icon string can never break out of the attribute.
    el.classList.add('has-img');
    el.textContent = '';
    const img = document.createElement('img');
    img.src = session.icon;
    img.alt = '';
    el.appendChild(img);
    return;
  }
  el.innerHTML = MEDIA_GENERIC_ICON;
}

let _mediaVolSession = null;
let _mediaVolTouch = 0;
let _mediaVolDebounce = null;

// Refresh the source badge icon + the per-app volume control. Called on every
// media update and on every audio update so the slider stays in sync.
function updateMediaSource() {
  const session = findMediaAppSession();
  _mediaVolSession = session;
  updateMediaSourceIcon(session);

  const wrap = $('media-volume');
  if (!wrap) return;
  if (!session) { wrap.hidden = true; return; }
  wrap.hidden = false;
  wireMediaVolume();

  const slider = $('media-vol-slider');
  const val = $('media-vol-val');
  const muteBtn = $('media-vol-mute');
  const busy = document.activeElement === slider || (Date.now() - _mediaVolTouch < 1500);
  if (slider && !busy) {
    slider.value = session.volume;
    slider.style.background = (typeof appMixSliderBg === 'function') ? appMixSliderBg(session.volume) : '';
    if (val) val.textContent = session.volume + '%';
  }
  wrap.classList.toggle('muted', !!session.muted);
  if (muteBtn) muteBtn.classList.toggle('active', !!session.muted);
}

function wireMediaVolume() {
  if (wireMediaVolume.done) return;
  const slider = $('media-vol-slider');
  const muteBtn = $('media-vol-mute');
  if (!slider) return;
  wireMediaVolume.done = true;
  slider.addEventListener('input', () => {
    const level = parseInt(slider.value, 10);
    _mediaVolTouch = Date.now();
    const val = $('media-vol-val');
    if (val) val.textContent = level + '%';
    slider.style.background = (typeof appMixSliderBg === 'function') ? appMixSliderBg(level) : '';
    const wrap = $('media-volume');
    if (wrap) wrap.classList.remove('muted');
    if (!_mediaVolSession) return;
    const id = _mediaVolSession.id;
    const proc = _mediaVolSession.proc || '';
    clearTimeout(_mediaVolDebounce);
    _mediaVolDebounce = setTimeout(() => {
      fetch(SERVER + '/audio/app/volume', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, level, proc }),
      }).catch(() => {});
    }, 120);
  });
  if (muteBtn) muteBtn.addEventListener('click', () => {
    if (!_mediaVolSession) return;
    const nowMuted = !muteBtn.classList.contains('active');
    muteBtn.classList.toggle('active', nowMuted);
    const wrap = $('media-volume');
    if (wrap) wrap.classList.toggle('muted', nowMuted);
    _mediaVolTouch = Date.now();
    fetch(SERVER + '/audio/app/mute', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: _mediaVolSession.id, muted: nowMuted, proc: _mediaVolSession.proc || '' }),
    }).catch(() => {});
  });
}

async function mediaAction(action) {
  try {
    if (action === 'playpause' && mediaData) {
      const playing = mediaData.playbackStatus === 'Playing';
      eachMedia(root => {
        const pi = mf(root, 'play-icon'); if (pi) pi.style.display = playing ? '' : 'none';
        const pa = mf(root, 'pause-icon'); if (pa) pa.style.display = playing ? 'none' : '';
      });
      mediaData.playbackStatus = playing ? 'Paused' : 'Playing';
      updateCalendarMiniPlayer();
      syncLockMediaPlaybackIcon(!playing);
      if (typeof refreshLockScreen === 'function') refreshLockScreen();
    }
    const res = await fetch(SERVER + '/media/' + action, { method: 'POST' });
    if (!res.ok) throw new Error('Media action failed');
    setTimeout(fetchMedia, 800);
  } catch { }
}

async function fetchMedia() {
  if (fetchingMedia) return;
  fetchingMedia = true;
  try {
    const res = await fetch(mediaSourceRequestUrl());
    if (!res.ok) throw new Error('Media unavailable');
    const data = await res.json();
    applyMedia(data);
  } catch { }
  fetchingMedia = false;
}
