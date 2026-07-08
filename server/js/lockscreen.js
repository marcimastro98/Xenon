'use strict';

let lockScreenTimer = null;
let _lockRafLastSecond = -1;

function getLockWidgetPrefs() {
  return normalizeLockWidgets(hubSettings && hubSettings.lockWidgets);
}

function toggleWidgetLockScreen() {
  const overlay = $('lockscreen-overlay');
  if (!overlay) return;
  if (overlay.hidden) openWidgetLockScreen();
  else closeWidgetLockScreen();
}

function _lockRafTick() {
  const overlay = $('lockscreen-overlay');
  if (!overlay || overlay.hidden) {
    lockScreenTimer = null;
    return;
  }
  const s = new Date().getSeconds();
  if (s !== _lockRafLastSecond) {
    _lockRafLastSecond = s;
    renderLockScreen();
  }
  lockScreenTimer = requestAnimationFrame(_lockRafTick);
}

function openWidgetLockScreen() {
  const overlay = $('lockscreen-overlay');
  if (!overlay) return;
  closeWeatherDetails();
  closeSettings();
  if ($('app-switcher') && !$('app-switcher').hidden) closeAppSwitcher();
  if ($('tab-switcher') && !$('tab-switcher').hidden) closeTabSwitcher();
  overlay.hidden = false;
  document.body.classList.add('lock-screen-active');
  _lockRafLastSecond = -1;
  renderLockScreen();
  if (lockScreenTimer) cancelAnimationFrame(lockScreenTimer);
  lockScreenTimer = requestAnimationFrame(_lockRafTick);
}

function closeWidgetLockScreen() {
  const overlay = $('lockscreen-overlay');
  if (overlay) overlay.hidden = true;
  document.body.classList.remove('lock-screen-active');
  if (lockScreenTimer) cancelAnimationFrame(lockScreenTimer);
  lockScreenTimer = null;
}

function refreshLockScreen() {
  const overlay = $('lockscreen-overlay');
  if (overlay && !overlay.hidden) renderLockScreen();
}

function renderLockScreen() {
  const overlay = $('lockscreen-overlay');
  if (!overlay || overlay.hidden) return;
  const prefs = getLockWidgetPrefs();
  const upcomingEvents = getLockUpcomingEvents();
  const mediaActive = prefs.media && hasLockMedia();
  const eventsActive = prefs.calendar && upcomingEvents.length > 0;
  const weatherActive = prefs.weather;
  const mediaWide = mediaActive && !eventsActive;
  const mediaOnly = mediaWide && !weatherActive;
  overlay.classList.toggle('no-clock', !prefs.clock);
  overlay.classList.toggle('media-wide', mediaWide);
  overlay.classList.toggle('media-only', mediaOnly);
  const grid = $('lockscreen-widgets');
  if (grid) {
    grid.classList.toggle('no-weather', !weatherActive);
    grid.classList.toggle('no-events', !eventsActive);
    grid.classList.toggle('no-media', !mediaActive);
    grid.classList.toggle('media-wide', mediaWide);
    grid.classList.toggle('media-only', mediaOnly);
  }
  setLockWidgetVisible('lock-clock-widget', prefs.clock);
  renderLockClock();
  renderLockWeather(weatherActive);
  renderLockMedia(mediaActive);
  renderLockEvents(eventsActive, upcomingEvents);
}

function getLockUpcomingEvents(limit = 3) {
  const now = Date.now();
  return calendarEvents
    .filter(event => Number.isFinite(Date.parse(event.startsAt)) && Date.parse(event.startsAt) >= now - 60000)
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))
    .slice(0, limit);
}

function hasLockMedia() {
  if (!hasActiveMedia()) return false;
  const status = String(mediaData.playbackStatus || '').toLowerCase();
  if (/closed|unavailable/.test(status)) return false;

  const app = String(mediaData.app || mediaData.source || '').trim();
  const title = cleanTitle(mediaData.title);
  const artist = String(mediaData.artist || mediaData.album || '').trim();
  if (title || artist) return true;
  return /spotify|youtube|chrome|edge|firefox|brave|opera|music|media player|itunes|vlc|tidal|deezer|apple/i.test(app);
}

function setLockWidgetVisible(id, visible) {
  const el = $(id);
  if (el) el.hidden = !visible;
}

function renderLockClock() {
  const now = new Date();
  const locale = t('locale');
  const is12h = clockUses12h();
  const h24 = now.getHours();
  const mins = now.getMinutes();
  const hours = is12h ? String(h24 % 12 || 12).padStart(2, '0') : String(h24).padStart(2, '0');
  const ampm = is12h ? (h24 < 12 ? 'AM' : 'PM') : '';
  const date = new Intl.DateTimeFormat(locale, {
    weekday: 'long', day: '2-digit', month: 'long'
  }).format(now);
  const hoursEl = $('lock-time-h');
  const minsEl = $('lock-time-m');
  const ampmEl = $('lock-time-ampm');
  const dateEl = $('lockscreen-date');
  if (hoursEl) updateLockClockPart(hoursEl, hours);
  if (minsEl) updateLockClockPart(minsEl, String(mins).padStart(2, '0'));
  if (ampmEl) ampmEl.textContent = ampm;
  if (dateEl) dateEl.textContent = date;
  const greetEl = $('lockscreen-greeting');
  if (greetEl) {
    const h = now.getHours();
    const key = h < 5 ? 'greet_night' : h < 12 ? 'greet_morning' : h < 18 ? 'greet_afternoon' : 'greet_evening';
    greetEl.textContent = t(key);
  }
}

function updateLockClockPart(element, value) {
  if (element.textContent === value) return;
  element.textContent = value;
  element.classList.remove('tick');
  void element.offsetWidth;
  element.classList.add('tick');
}

function classifyLockWeather(data) {
  return typeof classifyWeatherState === 'function' ? classifyWeatherState(data) : 'state-cloud';
}

function renderLockWeather(enabled) {
  const card = $('lock-weather-widget');
  if (!card) return;
  setLockWidgetVisible('lock-weather-widget', enabled);
  if (!enabled) return;

  const data = weatherData;
  const art = $('lock-weather-art');
  if (art) {
    const state = data && data.ok ? classifyLockWeather(data) : 'state-cloud';
    // At night the light source behind clouds/rain must be the moon, not the sun.
    const night = data && data.ok && typeof isWeatherNight === 'function'
      && isWeatherNight(data.sunrise, data.sunset);
    art.className = `lock-weather-art ${state}${night ? ' is-night' : ''}`;
  }

  if (!data || !data.ok) {
    $('lock-weather-place').textContent = t('weather_title');
    $('lock-weather-condition').textContent = t('weather_unavailable');
    $('lock-weather-temp').textContent = '--°';
    $('lock-weather-feels').textContent = '--';
    $('lock-weather-humidity').textContent = '--';
    $('lock-weather-wind').textContent = '--';
    card.classList.add('is-muted');
    return;
  }

  card.classList.toggle('is-muted', !!data.stale);
  $('lock-weather-place').textContent = data.location || t('weather_local');
  $('lock-weather-condition').textContent = data.condition || t('weather_title');
  $('lock-weather-temp').textContent = weatherDisplayValue(toDisplayTemp(data.tempC), '°');
  $('lock-weather-feels').textContent = weatherDisplayValue(toDisplayTemp(data.feelsC), '°');
  $('lock-weather-humidity').textContent = weatherDisplayValue(data.humidity, '%');
  $('lock-weather-wind').textContent = displayWind(data.windKph);
}

function renderLockMedia(enabled) {
  const card = $('lock-media-widget');
  if (!card) return;
  setLockWidgetVisible('lock-media-widget', enabled);
  if (!enabled) return;

  const cover = $('lock-media-cover');
  const app = localizeAppName(mediaData.app) || t('media');
  $('lock-media-app').textContent = app;
  $('lock-media-title').textContent = cleanTitle(mediaData.title) || t('media_unknown_title');
  $('lock-media-artist').textContent = mediaData.artist || mediaData.album || t('active_player');
  if (cover) {
    cover.classList.toggle('has-image', !!mediaData.thumbnail);
    cover.style.backgroundImage = mediaData.thumbnail ? `url("${mediaData.thumbnail}")` : '';
  }
  const playing = mediaData.playbackStatus === 'Playing';
  const play = $('lock-media-play');
  const pause = $('lock-media-pause');
  if (play) {
    play.hidden = false;
    play.style.display = playing ? 'none' : '';
  }
  if (pause) {
    pause.hidden = false;
    pause.style.display = playing ? '' : 'none';
  }
}

function renderLockEvents(enabled, upcoming = getLockUpcomingEvents()) {
  const card = $('lock-events-widget');
  const list = $('lock-events-list');
  if (!card || !list) return;
  setLockWidgetVisible('lock-events-widget', enabled);
  if (!enabled) {
    list.replaceChildren();
    const count = $('lock-events-count');
    if (count) count.textContent = '0';
    return;
  }

  const count = $('lock-events-count');
  if (count) count.textContent = String(upcoming.length);

  const fmt = new Intl.DateTimeFormat(t('locale'), {
    weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
  });
  list.replaceChildren(...upcoming.map(event => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'lock-event-item';
    item.onclick = () => {
      closeWidgetLockScreen();
      openDayModal(String(event.startsAt).slice(0, 10));
    };
    const dot = document.createElement('span');
    dot.className = 'lock-event-dot';
    const copy = document.createElement('span');
    copy.className = 'lock-event-copy';
    const title = document.createElement('span');
    title.className = 'lock-event-title';
    title.textContent = event.title || t('ph_title');
    const when = document.createElement('span');
    when.className = 'lock-event-when';
    when.textContent = fmt.format(new Date(event.startsAt));
    copy.append(title, when);
    item.append(dot, copy);
    return item;
  }));
}

function lockScreenMediaAction(event, action) {
  event.stopPropagation();
  mediaAction(action);
  setTimeout(refreshLockScreen, 850);
}

function openWeatherFromLockScreen() {
  closeWidgetLockScreen();
  toggleWeatherDetails();
}