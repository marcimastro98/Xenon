import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  readFailed, heardApp, heardMedia, reportedApps, nothingHeard, createEarshot, cacheLife, cachedReadUsable,
  createHeardPlayer, createMusicFact, afterPress, PAUSE_KEEPS_MS,
} = require('../media-read.js');

// The columns server.js reads from SoundVolumeView.
const F = { NAME: 0, TYPE: 1, DIR: 2, STATE: 7, PROC_PATH: 19, WINDOW_TITLE: 21 };

function row({ name = 'App', type = 'Application', dir = 'Render', state = 'Active', path = `C:\\Apps\\${name}.exe`, title = '' } = {}) {
  const r = new Array(22).fill('');
  r[F.NAME] = name; r[F.TYPE] = type; r[F.DIR] = dir; r[F.STATE] = state; r[F.PROC_PATH] = path; r[F.WINDOW_TITLE] = title;
  return r;
}

test('readFailed: an error beside "Unavailable" is a failed read, not silence', () => {
  assert.equal(readFailed({ active: false, playbackStatus: 'Unavailable', error: 'The operation has timed out.' }), true);
  assert.equal(readFailed({ active: false, playbackStatus: 'Unavailable' }), false);
  assert.equal(readFailed({ active: false, playbackStatus: 'Stopped', error: 'x' }), false);
  assert.equal(readFailed(null), false);
});

test('heardApp: any app with open sound counts, known player or not', () => {
  const spotify = row({ name: 'Spotify' });
  assert.equal(heardApp([spotify], F), spotify);
  const unknown = row({ name: 'Tiny Tape Deck', path: 'D:\\tools\\tape.exe' });
  assert.equal(heardApp([unknown], F), unknown);
});

test('heardApp: an app needs no window title to count', () => {
  const vlc = row({ name: 'VLC media player', path: 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', title: '' });
  assert.equal(heardApp([vlc], F), vlc);
});

test('heardApp: only an active output of an app', () => {
  assert.equal(heardApp([row({ state: 'Inactive' })], F), null);
  assert.equal(heardApp([row({ dir: 'Capture' })], F), null);
  assert.equal(heardApp([row({ type: 'Device' })], F), null);
  assert.equal(heardApp([], F), null);
});

test('heardApp: system sounds have no process, in any language', () => {
  assert.equal(heardApp([row({ name: 'Suoni di sistema', path: '' })], F), null);
  assert.equal(heardApp([row({ name: 'System Sounds', path: '' })], F), null);
});

test('heardApp: calls, stream mixers and our own pages are left out by process', () => {
  for (const path of [
    'C:\\Users\\x\\AppData\\Local\\Discord\\app-1.0\\Discord.exe',
    'C:\\Program Files\\Zoom\\bin\\Zoom.exe',
    'C:\\Apps\\ms-teams.exe',
    'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
    'C:\\Program Files\\Elgato\\WaveLink\\WaveLink.exe',
    'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\130\\msedgewebview2.exe',
  ]) assert.equal(heardApp([row({ path })], F), null, path);
});

test('heardApp: a left-out name means the process, not a word in the name', () => {
  const player = row({ name: 'Zoom Player', path: 'C:\\Program Files\\Zoom Player\\zplayer.exe' });
  assert.equal(heardApp([player], F), player);
});

test('heardApp: Linux rows carry the bare binary', () => {
  assert.equal(heardApp([row({ name: 'WEBRTC VoiceEngine', path: 'Discord' })], F), null);
  const mpv = row({ name: 'mpv', path: 'mpv' });
  assert.equal(heardApp([mpv], F), mpv);
});

test('heardApp: the running game and the apps told to skip do not count', () => {
  const game = row({ name: 'Rally', path: 'D:\\Games\\Rally\\Rally.exe' });
  assert.equal(heardApp([game], F, ['rally.exe']), null);
  assert.equal(heardApp([game], F, ['RALLY']), null);
  const player = row({ name: 'Spotify' });
  assert.equal(heardApp([game, player], F, ['Rally.exe']), player);
  assert.equal(heardApp([player], F, ['', null, undefined]), player);
});

test('reportedApps: every session Windows named, under both of its names', () => {
  const info = { sessions: [{ app: 'Spotify', source: 'Spotify.exe' }, { app: 'Chrome', source: 'chrome' }] };
  assert.deepEqual(reportedApps(info), ['Spotify', 'Spotify.exe', 'Chrome', 'chrome']);
  assert.deepEqual(reportedApps({}), []);
  assert.deepEqual(reportedApps(null), []);
});

test('heardMedia: reads as playing, so every surface treats it like any other player', () => {
  const m = heardMedia(row({ name: 'Spotify', title: 'Daft Punk - One More Time' }), F);
  assert.equal(m.active, true);
  assert.equal(m.playbackStatus, 'Playing');
  assert.equal(m.fallback, true);
  assert.equal(m.app, 'Spotify');
  assert.equal(m.source, 'Spotify');
  assert.equal(m.artist, 'Daft Punk');
  assert.equal(m.title, 'One More Time');
  assert.equal(m.position, 0);
  assert.equal(m.duration, 0);
});

test('heardMedia: the real app name, never a guess at the site', () => {
  const m = heardMedia(row({ name: 'Google Chrome', title: 'Lofi radio - YouTube - Google Chrome' }), F);
  assert.equal(m.app, 'Google Chrome');
  assert.equal(m.title, 'Lofi radio - YouTube');
  assert.equal(m.artist, '');
});

test('heardMedia: the app signing its own window is dropped from the title', () => {
  const title = (name, raw) => heardMedia(row({ name, title: raw }), F).title;
  assert.equal(title('VLC media player', 'Track 01.mp3 - VLC media player'), 'Track 01.mp3');
  assert.equal(title('Firefox', 'Some video — Mozilla Firefox'), 'Some video');
  assert.equal(title('foobar2000', 'Band - Song  [foobar2000]'), 'Band - Song');
  assert.equal(title('Microsoft Edge', 'Clip - Personal - Microsoft\u200b Edge'), 'Clip - Personal');
  assert.equal(title('Winamp', 'Band - Song'), 'Band - Song');
});

test('heardMedia: with no window title the app name stands in', () => {
  assert.equal(heardMedia(row({ name: 'VLC media player', title: '' }), F).title, 'VLC media player');
  assert.equal(heardMedia(row({ name: 'Winamp', title: ' - Winamp' }), F).title, 'Winamp');
});

test('heardMedia: a Store package id shows as its short name', () => {
  const m = heardMedia(row({ name: 'Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic' }), F);
  assert.equal(m.app, 'ZuneMusic');
  assert.equal(heardMedia(row({ name: '' }), F).app, 'Media');
});

test('nothingHeard: the failed shape keeps the reason', () => {
  const m = nothingHeard('timed out');
  assert.equal(m.active, false);
  assert.equal(m.playbackStatus, 'Unavailable');
  assert.equal(m.error, 'timed out');
});

test('earshot: one read is not enough, so a notification sound changes nothing', () => {
  const steady = createEarshot(F);
  const app = row({ name: 'Spotify' });
  assert.equal(steady([app], app), false);
  assert.equal(steady([app], app), true);
});

test('earshot: the same rows read twice are still one read', () => {
  const steady = createEarshot(F);
  const app = row({ name: 'Spotify' });
  const rows = [app];
  assert.equal(steady(rows, app), false);
  assert.equal(steady(rows, app), false);
  assert.equal(steady([app], app), true);
  assert.equal(steady(rows, app), true);
});

test('earshot: another app or silence starts over', () => {
  const steady = createEarshot(F);
  const one = row({ name: 'Spotify' });
  const two = row({ name: 'Winamp' });
  steady([one], one);
  assert.equal(steady([two], two), false);
  assert.equal(steady([two], two), true);
  assert.equal(steady([], null), false);
  assert.equal(steady([two], two), false);
});

test('cacheLife: a stand-in or a failed read is kept longer than a real read', () => {
  assert.equal(cacheLife({ playbackStatus: 'Playing' }, 1200), 1200);
  assert.equal(cacheLife({ playbackStatus: 'Stopped' }, 1200), 1200);
  assert.ok(cacheLife({ playbackStatus: 'Playing', fallback: true }, 1200) > 1200);
  assert.ok(cacheLife({ playbackStatus: 'Unavailable', error: 'x' }, 1200) > 1200);
  assert.equal(cacheLife(null, 1200), 1200);
});

test('cachedReadUsable: only a recent real read covers for a failed one', () => {
  const now = 100000;
  const real = { playbackStatus: 'Playing' };
  assert.equal(cachedReadUsable({ data: real, updatedAt: now - 2000 }, now), true);
  assert.equal(cachedReadUsable({ data: real, updatedAt: now - 60000 }, now), false);
  assert.equal(cachedReadUsable({ data: { playbackStatus: 'Playing', fallback: true }, updatedAt: now }, now), false);
  assert.equal(cachedReadUsable({ data: { playbackStatus: 'Unavailable', error: 'x' }, updatedAt: now }, now), false);
  assert.equal(cachedReadUsable({ data: null, updatedAt: now }, now), false);
});

// Spotify measured on a machine with a stuck media list: pausing turns its output row
// Inactive within a second, the row stays while the app is open, and the title goes.
const spotify = (state, title = 'Gotye - Somebody') => [row({ name: 'Spotify', state, title })];

function heardRig() {
  let at = 1000;
  const player = createHeardPlayer(F, { clock: () => at });
  return { player, wait: (ms) => { at += ms; }, read: (rows, skip) => player.read(rows, heardApp(rows, F, skip), skip) };
}

test('createHeardPlayer: a notification is not music, two reads of the same app are', () => {
  const { read } = heardRig();
  assert.equal(read(spotify('Active')), null);
  assert.equal(read(spotify('Active')).playbackStatus, 'Playing');
});

test('createHeardPlayer: a heard app that goes silent with its output open is paused', () => {
  const { read } = heardRig();
  read(spotify('Active'));
  read(spotify('Active'));
  const paused = read(spotify('Inactive', 'Spotify Premium'));
  assert.equal(paused.playbackStatus, 'Paused');
  assert.equal(paused.title, 'Somebody', 'the song stays, the window has lost it');
  assert.equal(paused.fallback, true);
});

test('createHeardPlayer: an app already heard is back at once when it plays again', () => {
  const { read } = heardRig();
  read(spotify('Active'));
  read(spotify('Active'));
  read(spotify('Inactive'));
  assert.equal(read(spotify('Active', 'Gotye - Next One')).title, 'Next One');
});

test('createHeardPlayer: a closed app is gone, and silence never lasts for ever', () => {
  const closed = heardRig();
  closed.read(spotify('Active'));
  closed.read(spotify('Active'));
  assert.equal(closed.read([]), null);
  assert.equal(closed.player.name(), '');
  const left = heardRig();
  left.read(spotify('Active'));
  left.read(spotify('Active'));
  left.wait(PAUSE_KEEPS_MS + 1);
  assert.equal(left.read(spotify('Inactive')), null);
  assert.equal(left.player.name(), 'spotify', 'Play still has somewhere to go');
});

test('createHeardPlayer: a sound from another app does not take the place of a paused song', () => {
  const { read } = heardRig();
  read(spotify('Active'));
  read(spotify('Active'));
  const ping = [...spotify('Inactive'), row({ name: 'Mail' })];
  assert.equal(read(ping).app, 'Spotify');
  assert.equal(read([...ping]).app, 'Mail', 'two reads and it is what plays now');
});

test('createHeardPlayer: an app the OS lists is the OS\'s to describe', () => {
  const { read } = heardRig();
  read(spotify('Active'));
  read(spotify('Active'));
  assert.equal(read(spotify('Inactive'), ['Spotify.exe']), null);
});

test('createMusicFact: a pause keeps the widget, so its Play button stays reachable', () => {
  let at = 0;
  const music = createMusicFact({ clock: () => at });
  assert.equal(music('Paused'), false, 'a song nobody played here is no music');
  assert.equal(music('Playing'), true);
  at = PAUSE_KEEPS_MS - 1;
  assert.equal(music('Paused'), true);
  at = PAUSE_KEEPS_MS + 1;
  assert.equal(music('Paused'), false);
  assert.equal(music('Playing'), true);
  assert.equal(music('Unavailable'), false, 'a player that closed takes it down at once');
});

test('afterPress: only a read from the sound is turned over, and it keeps the song', () => {
  const heard = { title: 'Somebody', playbackStatus: 'Playing', fallback: true };
  assert.deepEqual(afterPress(heard), { ...heard, playbackStatus: 'Paused' });
  assert.equal(afterPress({ ...heard, playbackStatus: 'Paused' }).playbackStatus, 'Playing');
  assert.equal(afterPress({ title: 'Listed', playbackStatus: 'Playing' }), null);
  assert.equal(afterPress(null), null);
});
