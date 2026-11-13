// Paints what is playing into every media tile, and keeps the playback clock between two readings.
'use strict';

let _lastThumb = '';
let _lastThumbKey = '';

function mf(root, name) { return root.querySelector('[data-mf="' + name + '"]'); }
function eachMedia(fn) {
  if (window.DashboardGrid && window.DashboardGrid.forEachInstance) window.DashboardGrid.forEachInstance('media', fn);
}
// Update ONE media tile instance's display from a prepared context object.
function applyMediaInto(root, ctx) {
  root.classList.remove('spotify', 'youtube', 'twitch');
  root.classList.toggle('is-empty', !!ctx.empty);
  const app = mf(root, 'media-app'), title = mf(root, 'media-title'), artist = mf(root, 'media-artist');
  const art = mf(root, 'media-art'), bg = mf(root, 'media-bg');
  const pi = mf(root, 'play-icon'), pa = mf(root, 'pause-icon');
  if (ctx.empty) {
    // Minimal on purpose: no app name and no hint on screen. The title stays for
    // screen readers, hidden by the CSS without moving the controls.
    if (app) app.textContent = '';
    if (title) title.textContent = t('media_empty_title');
    if (artist) artist.textContent = '';
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

// ── Shared playback clock ─────────────────────────────────────────
// Hosts report whole seconds (`position`) and, when new enough, the unrounded
// `positionMs`. A whole-second sample is never fresher than the host's own last
// timeline update plus the server cache: measured on Windows with Spotify, those
// trail the real position by 0 to 2 s in a sawtooth.
// Consumers that need sub-second timing (lyrics) read currentMediaPositionMs(),
// a local clock run from the FRESHEST recent sample (the upper envelope of the
// last few), so lag never drags it backwards. A sample far behind the clock is
// a seek back; one ahead simply lifts it. `epoch` changes whenever the clock
// moves by a real step (seek, pause, track) and never for envelope noise.
const MEDIA_CLOCK_WINDOW = 6;          // samples kept for the envelope
const MEDIA_CLOCK_BACK_MS = 3000;      // further behind than the worst lag: a seek
const MEDIA_CLOCK_CREEP_MS = 40;       // most the clock may fall back per sample
const MEDIA_CLOCK_STEP_MS = 1000;      // a move this large is a new epoch
const MEDIA_CLOCK_SEEK_HOLD_MS = 2500; // how long a sample may still predate our seek
let _mediaClock = { src: null, key: '', posMs: 0, at: 0, playing: false, durMs: 0, leads: [], epoch: 0, holdUntil: 0 };

// Pure: the clock after one host sample taken at `now`.
function mediaClockStep(clock, sample, now) {
  const { key, posMs, playing } = sample;
  const projected = mediaClockAt(clock, now);
  // Right after our own seek a sample may still carry the old spot.
  if (now < clock.holdUntil && key === clock.key && Math.abs(posMs - projected) >= MEDIA_CLOCK_STEP_MS) {
    return { ...clock, src: sample.src };
  }
  const lead = posMs - now;
  let leads = [lead];
  if (key === clock.key && playing && clock.playing && projected - posMs < MEDIA_CLOCK_BACK_MS) {
    leads = clock.leads.concat(lead).slice(-MEDIA_CLOCK_WINDOW);
  }
  let posNow = now + (playing ? Math.max(...leads) : lead);
  // The freshest sample leaving the window must not pull the clock back in
  // one step; it creeps down instead, which also bleeds off rounding that ran
  // it slightly ahead.
  if (leads.length > 1 && posNow < projected) posNow = Math.max(posNow, projected - MEDIA_CLOCK_CREEP_MS);
  const next = { ...sample, posMs: posNow, at: now, leads, epoch: clock.epoch, holdUntil: 0 };
  const stepped = key !== clock.key || playing !== clock.playing
    || Math.abs(mediaClockAt(next, now) - projected) >= MEDIA_CLOCK_STEP_MS;
  if (stepped) next.epoch = clock.epoch + 1;
  return next;
}

function mediaClockAt(c, now) {
  const ms = c.posMs + (c.playing ? now - c.at : 0);
  return c.durMs ? Math.min(c.durMs, ms) : ms;
}

function syncMediaClock(data) {
  // applyMedia re-runs on a language change or layout rebuild with the SAME
  // object; its position is seconds old by then and must not move the clock.
  if (data && data === _mediaClock.src) return;
  // positionMs is the unrounded twin newer hosts send; whole seconds otherwise.
  const exactMs = Number(data && data.positionMs);
  const sample = {
    src: data,
    key: data ? `${data.title || ''}|${data.artist || data.album || ''}` : '',
    posMs: Math.max(0, Number.isFinite(exactMs) ? exactMs : (Number(data && data.position) || 0) * 1000),
    durMs: Math.max(0, Number(data && data.duration) || 0) * 1000,
    playing: !!(data && data.active && data.playbackStatus === 'Playing'),
  };
  _mediaClock = mediaClockStep(_mediaClock, sample, performance.now());
}

// Where playback is now, in ms, between host samples. Paused = frozen.
function currentMediaPositionMs() {
  return mediaClockAt(_mediaClock, performance.now());
}

// Changes when the clock jumps (seek, pause/play, new track), not when it drifts.
function mediaClockEpoch() {
  return _mediaClock.epoch;
}

// A seek we asked for lands on the host a moment before its next sample says
// so; move the clock now so the lyrics follow the tap instead of the old spot.
function noteMediaSeek(ms) {
  const now = performance.now();
  _mediaClock = { ..._mediaClock, posMs: Math.max(0, ms), at: now, leads: [], epoch: _mediaClock.epoch + 1, holdUntil: now + MEDIA_CLOCK_SEEK_HOLD_MS };
}

function applyMedia(data) {
  syncMediaClock(data);
  mediaData = data;
  renderMediaSourcePicker(data);
  // False while the tile is transiently detached (tab-group build) or simply not
  // on this dashboard. The topbar now-playing segment must survive both, so the
  // guard is applied per-consumer below instead of returning early here.
  const hasPanel = !!$('media-panel');

  const active = data && data.active && (data.title || data.artist || data.app);
  if (!active) {
    refreshMediaEmpty(); // also clears the topbar segment
    if (!hasPanel) return;
    // The agenda is calendar.js, absent from the light layer page.
    if (typeof showCalendar === 'function') {
      calendarAutoShown = preferredMediaView() !== 'calendar';
      showCalendar(true, true);
    }
    updateCalendarMiniPlayer();
    mediaAutoTab();
    updateMediaChatPreview();
    return;
  }

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
    // Whole seconds off the SMTC timeline, so every player reports them, not
    // just Spotify. 0/0 means "no timeline" (live streams, radio) — consumers
    // must treat that as "no progress to show", not as "at the start".
    position: Number(data.position) || 0,
    duration: Number(data.duration) || 0,
    isSpotify: /spotify/i.test(app), isYoutube: /youtube/i.test(app), isTwitch: /twitch/i.test(app),
  };
  // Topbar/island now-playing first: it is a surface of its own and works with
  // no media tile on the dashboard (js/topbar-media.js).
  if (window.TopbarMedia) window.TopbarMedia.sync(ctx);
  // Lyrics live in the Media tile AND in their own widget, so they follow the
  // track even when no Media tile is on this dashboard.
  if (window.MediaLyrics) window.MediaLyrics.sync();
  if (window.LyricsCore) window.LyricsCore.sync();
  if (window.LyricsStage) window.LyricsStage.sync();
  if (!hasPanel) return;

  if (calendarAutoShown) {
    calendarAutoShown = false;
    showCalendar(preferredMediaView() === 'calendar', true);
  }
  mediaAutoTab();

  eachMedia(root => applyMediaInto(root, ctx));

  updateAlbumAccent(thumb);
  syncLockMediaPlaybackIcon(playing);
  updateCalendarMiniPlayer();
  updateMediaChatPreview();
  updateMediaSource();
  if (window.MediaSpotify) window.MediaSpotify.sync();
  if (window.MediaProgress) window.MediaProgress.sync();
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
  if (window.TopbarMedia) window.TopbarMedia.sync(null); // hide the topbar segment
  if (window.MediaLyrics) window.MediaLyrics.sync();
  if (window.LyricsCore) window.LyricsCore.sync();
  if (window.LyricsStage) window.LyricsStage.sync();
  if (!$('media-panel')) return; // media tile transiently detached
  eachMedia(root => applyMediaInto(root, { empty: true }));
  syncLockMediaPlaybackIcon(false);
  updateMediaSource();
  if (window.MediaSpotify) window.MediaSpotify.sync();
  if (window.MediaProgress) window.MediaProgress.sync();
}
