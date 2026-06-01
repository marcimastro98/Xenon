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
  const app = localizeAppName(session.app) || session.app || session.source || t('media');
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

function setMediaTab(tab, fromUser = true) {
  const isChat = tab === 'chat';
  if (fromUser) _mediaTabUserPicked = true;
  const play = document.getElementById('media-pane-play');
  const chat = document.getElementById('media-pane-chat');
  const btnPlay = document.getElementById('media-tab-play');
  const btnChat = document.getElementById('media-tab-chat');
  if (play) play.hidden = isChat;
  if (chat) chat.hidden = !isChat;
  if (btnPlay) { btnPlay.classList.toggle('active', !isChat); btnPlay.setAttribute('aria-selected', String(!isChat)); }
  if (btnChat) { btnChat.classList.toggle('active', isChat); btnChat.setAttribute('aria-selected', String(isChat)); }
  document.getElementById('media-panel')?.classList.toggle('media-chat-mode', isChat);
  updateMediaChatPreview();
  if (isChat) {
    if (typeof _aiRenderWelcomeIfEmpty === 'function') _aiRenderWelcomeIfEmpty();
    const input = document.getElementById('ai-text-input');
    if (input && fromUser) setTimeout(() => { try { input.focus(); } catch {} }, 0);
  }
}

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
  const inputRow = document.querySelector('.ai-input-row');
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
function mediaAutoTab() {
  if (_mediaTabUserPicked) return;
  const playing = typeof hasActiveMedia === 'function' && hasActiveMedia();
  setMediaTab(playing ? 'play' : 'chat', false);
}

function _aiHasKey() {
  return !!(typeof hubSettings === 'object' && hubSettings && hubSettings.geminiApiKey);
}

// Show the "AI unavailable" notice + hide the chat log/input when no API key is set.
function updateMediaChatKeyState() {
  const hasKey = _aiHasKey();
  const notice = document.getElementById('media-chat-nokey');
  const chat = document.getElementById('ai-chat');
  const inputRow = document.querySelector('.ai-input-row');
  if (notice) notice.hidden = hasKey;
  if (chat) chat.hidden = !hasKey;
  if (inputRow) inputRow.hidden = !hasKey;
}

// Hide/show the whole Chat tab in the Media tile (persisted via aiChatHidden).
function applyMediaChatVisibility() {
  const hidden = !!(typeof hubSettings === 'object' && hubSettings && hubSettings.aiChatHidden === true);
  const tabs = document.querySelector('.media-tabs');
  const tabChat = document.getElementById('media-tab-chat');
  if (tabChat) tabChat.hidden = hidden;
  if (tabs) tabs.hidden = hidden;
  if (hidden) setMediaTab('play', false);
}

function hideMediaChat() {
  if (typeof hubSettings === 'object' && hubSettings) {
    hubSettings.aiChatHidden = true;
    if (typeof saveHubSettings === 'function') saveHubSettings();
  }
  applyMediaChatVisibility();
}

// Mini now-playing preview shown at the top of the Chat tab while music plays.
function updateMediaChatPreview() {
  const np = document.getElementById('media-chat-np');
  if (!np) return;
  const playing = typeof hasActiveMedia === 'function' && hasActiveMedia();
  const chatMode = !!document.getElementById('media-panel')?.classList.contains('media-chat-mode');
  np.hidden = !(playing && chatMode);
  if (!playing) return;
  const cover = document.getElementById('media-chat-np-cover');
  const title = document.getElementById('media-chat-np-title');
  const artist = document.getElementById('media-chat-np-artist');
  const thumb = mediaData && mediaData.thumbnail;
  if (cover) {
    cover.style.backgroundImage = thumb ? `url("${thumb}")` : '';
    cover.classList.toggle('has-image', !!thumb);
  }
  if (title) title.textContent = (mediaData && cleanTitle(mediaData.title)) || t('media_unknown_title');
  if (artist) artist.textContent = (mediaData && (mediaData.artist || mediaData.album)) || '';
  const isPlaying = mediaData && mediaData.playbackStatus === 'Playing';
  const p = document.getElementById('np-play-icon');
  const pa = document.getElementById('np-pause-icon');
  if (p) p.style.display = isPlaying ? 'none' : '';
  if (pa) pa.style.display = isPlaying ? '' : 'none';
}

// Topbar ✦ — reveal the chat (undo a previous hide) and switch to it.
function openMediaChat() {
  if (typeof hubSettings === 'object' && hubSettings && hubSettings.aiChatHidden) {
    hubSettings.aiChatHidden = false;
    if (typeof saveHubSettings === 'function') saveHubSettings();
    applyMediaChatVisibility();
  }
  setMediaTab('chat');
}

let _lastThumb = '';
let _lastThumbKey = '';

function applyMedia(data) {
  mediaData = data;
  renderMediaSourcePicker(data);
  const panel = $('media-panel');
  const art = $('media-art');
  const bg = $('media-bg');
  panel.classList.remove('spotify', 'youtube');

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

  const app = localizeAppName(data.app) || t('media');
  $('media-app').textContent = app;
  $('media-title').textContent = cleanTitle(data.title) || t('media_unknown_title');
  $('media-artist').textContent = data.artist || data.album || '';

  if (/spotify/i.test(app)) panel.classList.add('spotify');
  if (/youtube/i.test(app)) panel.classList.add('youtube');

  // SMTC occasionally drops the album art for a refresh or two; reuse the last
  // known thumbnail for the SAME track so the cover doesn't flash to "No media".
  const trackKey = `${data.title || ''}|${data.artist || data.album || ''}`;
  if (data.thumbnail) { _lastThumb = data.thumbnail; _lastThumbKey = trackKey; }
  else if (trackKey !== _lastThumbKey) { _lastThumb = ''; }
  const thumb = data.thumbnail || _lastThumb;

  if (thumb) {
    art.classList.add('has-image');
    art.style.backgroundImage = `url("${thumb}")`;
    panel.classList.add('has-image');
    bg.style.backgroundImage = `url("${thumb}")`;
  } else {
    art.classList.remove('has-image');
    art.style.backgroundImage = '';
    panel.classList.remove('has-image');
    bg.style.backgroundImage = '';
  }

  const playing = data.playbackStatus === 'Playing';
  $('play-icon').style.display = playing ? 'none' : '';
  $('pause-icon').style.display = playing ? '' : 'none';
  syncLockMediaPlaybackIcon(playing);
  updateCalendarMiniPlayer();
  updateMediaChatPreview();
  updateMediaSource();
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
  const panel = $('media-panel');
  const art = $('media-art');
  const bg = $('media-bg');
  panel.classList.remove('spotify', 'youtube');
  $('media-app').textContent = t('media');
  $('media-title').textContent = t('media_empty_title');
  $('media-artist').textContent = t('media_empty_sub');
  art.classList.remove('has-image');
  art.style.backgroundImage = '';
  panel.classList.remove('has-image');
  bg.style.backgroundImage = '';
  $('play-icon').style.display = '';
  $('pause-icon').style.display = 'none';
  syncLockMediaPlaybackIcon(false);
  updateMediaSource();
}

// ── Source icon + per-app volume ──────────────────────────────────
// Official brand marks for the most common sources; for any other app the real
// icon extracted from its executable (via the matched audio session) is used.
const MEDIA_BRAND_ICONS = {
  spotify: { cls: 'brand-spotify', svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.6 14.42a.62.62 0 0 1-.86.2c-2.35-1.43-5.3-1.76-8.79-.96a.62.62 0 1 1-.28-1.2c3.82-.88 7.09-.5 9.73 1.1.29.18.38.56.2.86Zm1.23-2.73a.78.78 0 0 1-1.07.25c-2.69-1.65-6.79-2.13-9.97-1.17a.78.78 0 0 1-.45-1.49c3.63-1.1 8.15-.56 11.24 1.33.36.22.48.7.25 1.07Zm.11-2.86C14.83 8.94 9.5 8.76 6.4 9.7a.94.94 0 1 1-.54-1.8c3.56-1.08 9.45-.86 13.18 1.36a.94.94 0 1 1-.96 1.62Z"/></svg>' },
  youtube: { cls: 'brand-youtube', svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23 12s0-3.18-.4-4.7a2.5 2.5 0 0 0-1.77-1.77C19.31 5.13 12 5.13 12 5.13s-7.31 0-8.83.4A2.5 2.5 0 0 0 1.4 7.3C1 8.82 1 12 1 12s0 3.18.4 4.7a2.5 2.5 0 0 0 1.77 1.77c1.52.4 8.83.4 8.83.4s7.31 0 8.83-.4a2.5 2.5 0 0 0 1.77-1.77C23 15.18 23 12 23 12Zm-13.4 3.02V8.98L15.27 12 9.6 15.02Z"/></svg>' },
};
const MEDIA_GENERIC_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 17.5a2.5 2.5 0 1 1-2.5-2.5c.35 0 .68.07.97.18L7.5 6.2 18 4v8.5a2.5 2.5 0 1 1-1.5-2.29V6.2L9 7.6v9.9Z"/></svg>';

// A media source maps to one or more candidate audio-session process names.
const MEDIA_APP_PROC_TOKENS = {
  spotify: ['spotify'],
  youtube: ['chrome', 'msedge', 'firefox', 'opera', 'brave', 'vivaldi'],
  chrome: ['chrome'],
  edge: ['msedge'],
  firefox: ['firefox'],
  tidal: ['tidal'],
  deezer: ['deezer', 'chrome', 'msedge'],
  soundcloud: ['chrome', 'msedge', 'firefox'],
  vlc: ['vlc'],
};

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
  if (session && session.icon) { el.classList.add('has-img'); el.innerHTML = `<img src="${session.icon}" alt="">`; return; }
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
    clearTimeout(_mediaVolDebounce);
    _mediaVolDebounce = setTimeout(() => {
      fetch(SERVER + '/audio/app/volume', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, level }),
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
      body: JSON.stringify({ id: _mediaVolSession.id, muted: nowMuted }),
    }).catch(() => {});
  });
}

async function mediaAction(action) {
  try {
    if (action === 'playpause' && mediaData) {
      const playing = mediaData.playbackStatus === 'Playing';
      $('play-icon').style.display = playing ? '' : 'none';
      $('pause-icon').style.display = playing ? 'none' : '';
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
