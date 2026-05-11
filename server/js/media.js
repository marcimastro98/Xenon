'use strict';

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

function applyMedia(data) {
  mediaData = data;
  const panel = $('media-panel');
  const art = $('media-art');
  const bg = $('media-bg');
  panel.classList.remove('spotify', 'youtube');

  const active = data && data.active && (data.title || data.artist || data.app);
  if (!active) {
    refreshMediaEmpty();
    calendarAutoShown = true;
    showCalendar(true, true);
    updateCalendarMiniPlayer();
    return;
  }

  if (calendarAutoShown) {
    calendarAutoShown = false;
    showCalendar(false, true);
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
    const res = await fetch(SERVER + '/media');
    if (!res.ok) throw new Error('Media unavailable');
    const data = await res.json();
    applyMedia(data);
  } catch { }
  fetchingMedia = false;
}
