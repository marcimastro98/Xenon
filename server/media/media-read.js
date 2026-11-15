'use strict';
// What "is something playing?" rests on when the OS media list has no answer. On Windows
// that list fails when its service wedges (every read times out), and many players never
// join it. The sound rows still name every app with an open output, so any app counts
// unless it is left out here for a reason that holds for that app.

// Process names without ".exe". A name means the process: Zoom the meeting app is out,
// Zoom Player is not.
const LEFT_OUT = new Set([
  // Calls: a voice is not music.
  'discord', 'discordptb', 'discordcanary', 'teamspeak', 'ts3client_win64', 'ts3client_win32', 'mumble',
  'skype', 'skypeapp', 'zoom', 'teams', 'ms-teams', 'slack', 'webex', 'ciscocollabhost', 'whatsapp',
  'telegram', 'signal', 'viber', 'element',
  // Mixers and capture tools: they hold a stream open whether or not anything sounds.
  'obs', 'obs64', 'streamlabs obs', 'wavelink', 'voicemeeter', 'voicemeeterpro', 'voicemeeter8', 'voicemeeter8x64',
  'steelseriessonar', 'nvidia broadcast', 'parsecd',
  // Ours and the system's: a page inside Xenon reports to the media list by itself.
  'msedgewebview2', 'audiodg', 'explorer',
]);

// A wedged service answers after its full timeout, so a stand-in is kept for a few seconds
// instead of being rebuilt on every tick.
const STAND_IN_LIFE_MS = 2500;
// A short failure hides behind the last real read; a long one must not leave a song
// showing after it ended.
const REAL_READ_COVERS_MS = 10000;
// A pause is not the end of the music: for this long the song stays on screen, and a
// widget shown "when there is music" stays too, or its Play button would go with it.
const PAUSE_KEEPS_MS = 5 * 60 * 1000;
// Longer than a row takes to change (1 s measured) plus the rows' own reuse.
const PRESS_HOLDS_MS = 3500;

function readFailed(data) {
  return Boolean(data && data.playbackStatus === 'Unavailable' && data.error);
}

function processName(value) {
  return String(value || '').split(/[\\/]/).pop().replace(/\.exe$/i, '').trim().toLowerCase();
}

/** The first app with sound open, or null. `skip` names processes that do not count. */
function heardApp(rows, F, skip = []) {
  const skipped = new Set(skip.filter(Boolean).map(processName));
  return rows.find((row) => {
    if (row[F.TYPE] !== 'Application' || row[F.DIR] !== 'Render' || row[F.STATE] !== 'Active') return false;
    // No process is the system's own sounds, whatever this Windows calls them.
    const name = processName(row[F.PROC_PATH]);
    return Boolean(name) && !LEFT_OUT.has(name) && !skipped.has(name);
  }) || null;
}

/** The apps the OS listed in a read that says nothing plays: they are paused, not playing. */
function reportedApps(info) {
  const sessions = (info && Array.isArray(info.sessions)) ? info.sessions : [];
  return sessions.flatMap((session) => [session.app, session.source]);
}

function appName(name) {
  const text = String(name || '').trim();
  if (!text) return 'Media';
  // Publisher.Name_hash!AppId
  const pkg = text.match(/^(?:[^.]+\.)+([^._!]+)[_!]/);
  return pkg ? pkg[1] : text;
}

// "Track.mp3 - VLC media player", "Song [foobar2000]", "Clip — Mozilla Firefox".
function withoutAppSign(title, app) {
  const signed = title.match(/^(.*)(?:(?:^|\s)[-–—]\s+|\s\[)(.+?)\]?$/);
  if (!signed) return title;
  const sign = signed[2].trim().toLowerCase();
  const name = app.toLowerCase();
  return (name.includes(sign) || sign.includes(name)) ? signed[1].trim() : title;
}

function titleParts(rawTitle, app) {
  const title = withoutAppSign(String(rawTitle || '').replace(/​/g, '').trim(), app) || app;
  // Only Spotify's window is known to read "Artist - Title".
  if (/spotify/i.test(app) && title.includes(' - ')) {
    const [artist, ...rest] = title.split(' - ');
    return { artist: artist.trim(), title: rest.join(' - ').trim() };
  }
  return { artist: '', title };
}

/** A heard app as a media read. It says Playing: sound is coming out, and every surface
 *  then treats it like any other player. `fallback` says the controls may not reach it. */
function heardMedia(row, F) {
  const app = appName(row[F.NAME]);
  const { title, artist } = titleParts(row[F.WINDOW_TITLE], app);
  return { active: true, app, source: app, title, artist, album: '', playbackStatus: 'Playing', thumbnail: null, position: 0, duration: 0, fallback: true };
}

function nothingHeard(error) {
  return { active: false, app: '', source: '', title: '', artist: '', album: '', playbackStatus: 'Unavailable', thumbnail: null, position: 0, duration: 0, error };
}

/** True once the same app was heard on two reads in a row: a notification is one read.
 *  Rows reused from a recent read are not a second read. */
function createEarshot(F) {
  let seen = null;
  let name = '';
  let steady = false;
  return (rows, app) => {
    if (rows === seen) return steady;
    const next = app ? processName(app[F.PROC_PATH]) : '';
    steady = next !== '' && next === name;
    seen = rows;
    name = next;
    return steady;
  };
}

function outputOpen(rows, F, name) {
  return rows.some((row) => row[F.TYPE] === 'Application' && row[F.DIR] === 'Render' && processName(row[F.PROC_PATH]) === name);
}

/** The sound rows as a player. Remembers the last app heard: an app that goes silent with
 *  its output open has paused, and it is the one the buttons reach, playing or not. */
function createHeardPlayer(F, { clock = Date.now } = {}) {
  const earshot = createEarshot(F);
  let last = null;
  return {
    read(rows, app, skip = []) {
      const steady = earshot(rows, app);
      const name = app ? processName(app[F.PROC_PATH]) : '';
      if (app && (steady || (last && last.name === name))) {
        last = { name, media: heardMedia(app, F), at: clock() };
        return last.media;
      }
      if (last && !outputOpen(rows, F, last.name)) last = null;
      if (!last || clock() - last.at >= PAUSE_KEEPS_MS) return null;
      // Listed by the OS, the app has a better read than this one.
      if (skip.filter(Boolean).map(processName).includes(last.name)) return null;
      return { ...last.media, playbackStatus: 'Paused' };
    },
    name: () => (last ? last.name : ''),
  };
}

/** "Is there music?" from a read's status, with a pause counting for a while. */
function createMusicFact({ clock = Date.now } = {}) {
  let playedAt = -Infinity;
  return (status) => {
    if (status === 'Playing') { playedAt = clock(); return true; }
    return status === 'Paused' && clock() - playedAt < PAUSE_KEEPS_MS;
  };
}

/** A read from the sound after its app was told play or pause, or null if it was not one.
 *  The sound takes a second to change: read at once, the button would jump back. */
function afterPress(data) {
  if (!data || data.fallback !== true) return null;
  return { ...data, playbackStatus: data.playbackStatus === 'Playing' ? 'Paused' : 'Playing' };
}

function cacheLife(data, normalMs) {
  return (data && (data.fallback === true || readFailed(data))) ? STAND_IN_LIFE_MS : normalMs;
}

function cachedReadUsable(cache, now) {
  const { data, updatedAt } = cache;
  if (!data || data.fallback === true || readFailed(data)) return false;
  return now - updatedAt < REAL_READ_COVERS_MS;
}

module.exports = {
  readFailed, heardApp, heardMedia, reportedApps, nothingHeard, createEarshot, createHeardPlayer, createMusicFact,
  afterPress, cacheLife, cachedReadUsable, PAUSE_KEEPS_MS, PRESS_HOLDS_MS,
};
