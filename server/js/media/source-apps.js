// The icons of the known players, working out which app or site is playing and its volume, the
// playback keys, and asking the engine what is playing.
'use strict';

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
// `chromium` is listed separately on purpose: it does NOT contain "chrome"
// (chromi-um), so the alternative above never matched it. It reaches this test
// as an MPRIS bus name on Linux, and as a process name on any platform where
// someone runs Chromium rather than Chrome.
const BROWSER_SOURCE_RE = /chrome|chromium|msedge|edge|firefox|brave|opera|vivaldi/i;
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
  // The best match, not the first: "msedge" is inside "msedgewebview2", the
  // process of Xenon's own window and of every other WebView2 app, so a first
  // match could follow a silent window and leave the Media wave flat while
  // YouTube played in Edge. Reported on Discord as "Media tile sound wave not
  // showing up any more". An exact process name wins over a partial one, and a
  // browser whose window names the service ("YouTube") wins over the rest.
  const score = (app) => {
    const proc = norm(app.proc);
    const name = norm(app.name);
    if (!candidates.some(token => token && (proc.includes(token) || name.includes(token)))) return 0;
    const exact = candidates.some(token => token && proc === token);
    const titled = !!(raw && app.win && String(app.win).toLowerCase().includes(raw));
    return 1 + (exact ? 2 : 0) + (titled ? 1 : 0);
  };
  let best = null;
  let bestScore = 0;
  for (const app of apps) {
    const s = score(app);
    if (s > bestScore) { best = app; bestScore = s; }
  }
  return best;
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
  // The visualiser draws the level of THIS process, so a Discord call or a game
  // never makes the music's waveform dance. `audiolevels` is keyed by process
  // name, which is exactly what the session carries.
  if (window.MediaViz) window.MediaViz.setSource(session ? session.proc : '');

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
      // Freeze or restart the shared clock with the optimistic state, so lyrics
      // stop on the tap rather than ~2 s later with the next host sample.
      const at = currentMediaPositionMs();
      mediaData.playbackStatus = playing ? 'Paused' : 'Playing';
      _mediaClock = { ..._mediaClock, posMs: at, at: performance.now(), playing: !playing, leads: [], epoch: _mediaClock.epoch + 1 };
      if (window.MediaProgress) window.MediaProgress.sync();
      updateCalendarMiniPlayer();
      syncLockMediaPlaybackIcon(!playing);
      if (typeof refreshLockScreen === 'function') refreshLockScreen();
    }
    const res = await fetch(SERVER + '/media/' + action, { method: 'POST' });
    if (!res.ok) throw new Error('Media action failed');
    setTimeout(fetchMedia, 800);
    // These SMTC actions never touch the Spotify provider — its cached snapshot
    // still holds the pre-action state. Have the Spotify strip re-read promptly so
    // the seek bar reflects the outcome (e.g. ◀ restarting a paused song at 0:00,
    // which is invisible via SMTC: Spotify freezes its timeline while paused).
    if (window.MediaSpotify && typeof window.MediaSpotify.poke === 'function') window.MediaSpotify.poke();
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
