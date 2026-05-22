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
    return;
  }

  if (calendarAutoShown) {
    calendarAutoShown = false;
    showCalendar(preferredMediaView() === 'calendar', true);
  }

  const app = localizeAppName(data.app) || t('media');
  $('media-app').textContent = app;
  $('media-title').textContent = cleanTitle(data.title) || t('media_unknown_title');
  $('media-artist').textContent = data.artist || data.album || '';

  if (/spotify/i.test(app)) panel.classList.add('spotify');
  if (/youtube/i.test(app)) panel.classList.add('youtube');

  if (data.thumbnail) {
    art.classList.add('has-image');
    art.style.backgroundImage = `url("${data.thumbnail}")`;
    panel.classList.add('has-image');
    bg.style.backgroundImage = `url("${data.thumbnail}")`;
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
