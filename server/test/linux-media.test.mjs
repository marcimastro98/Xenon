'use strict';
// linux-media.js — the pure half of now-playing on Linux.
//
// Same job as the darwin suite: lock the CONTRACT, not the tool. Every field
// media.ps1 defines and js/media.js reads has to come out of an MPRIS record
// with the same name, the same unit (seconds) and the same playbackStatus
// vocabulary, because nothing above server.js knows which platform produced it.
//
// The fixture is written to playerctl's documented `--follow --format` output
// (this repo is developed on Windows). Re-capture it on a real Linux desktop:
//   playerctl --follow --format \
//     '{{playerName}}\t{{status}}\t{{title}}\t{{artist}}\t{{album}}\t{{mpris:length}}\t{{position}}\t{{mpris:artUrl}}' \
//     metadata > linux-playerctl-follow.txt
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const lm = require('../linux-media.js');

const here = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(join(here, 'fixtures', 'linux-playerctl-follow.txt'), 'utf8').split(/\r?\n/);

test('parseFollowLine: keeps full records and drops playerctl chatter', () => {
  // "No players found" goes to stdout on some builds and must never be read as
  // a track: a record with fewer fields than the format asked for is not one.
  assert.equal(lm.parseFollowLine(lines[0]), null);
  assert.equal(lm.parseFollowLine(''), null);
  assert.equal(lm.parseFollowLine('   '), null);
  assert.equal(lm.parseFollowLine(null), null);
  const rec = lm.parseFollowLine(lines[1]);
  assert.equal(rec.player, 'spotify');
  assert.equal(rec.title, 'Kiara');
  assert.equal(rec.length, '249000000');
});

test('parseFollowLine: a record with no player name is not a record', () => {
  const T = '\t';
  assert.equal(lm.parseFollowLine(['', 'Playing', 't', 'a', 'b', '1', '0', ''].join(T)), null);
});

test('shapeNowPlaying: a playing track carries every key the widget reads', () => {
  const info = lm.shapeNowPlaying(lm.parseFollowLine(lines[1]), 0);
  assert.equal(info.active, true);
  assert.equal(info.app, 'Spotify');
  assert.equal(info.source, 'spotify');       // the bus name is the stable id
  assert.equal(info.title, 'Kiara');
  assert.equal(info.artist, 'Bonobo');
  assert.equal(info.playbackStatus, 'Playing'); // liveMediaSnapshot tests this exact string
  assert.equal(info.duration, 249);             // micros in, SECONDS out
  assert.equal(info.position, 45);
  assert.ok(info.thumbnail.startsWith('https://'));
  assert.equal(info.sessions.length, 1);
  assert.equal(info.sessions[0].selected, true);
});

test('shapeNowPlaying: the position advances while playing and holds while paused', () => {
  const playing = lm.parseFollowLine(lines[1]);
  const paused = lm.parseFollowLine(lines[2]);
  // --follow pushes on change only, so a record held for 20s would otherwise
  // report a 20s-old position.
  assert.equal(lm.shapeNowPlaying(playing, 20000).position, 65);
  assert.equal(lm.shapeNowPlaying(paused, 20000).position, 61);
  assert.equal(lm.shapeNowPlaying(paused, 20000).playbackStatus, 'Paused');
  // …and never past the end of the track.
  assert.equal(lm.shapeNowPlaying(playing, 10 * 60 * 1000).position, 249);
});

test('shapeNowPlaying: no player is the same "nothing playing" media.ps1 returns', () => {
  for (const empty of [null, undefined, {}, { player: '' }]) {
    const info = lm.shapeNowPlaying(empty, 0);
    assert.equal(info.active, false);
    assert.equal(info.playbackStatus, 'Closed');
    assert.equal(info.thumbnail, null);
    assert.equal(info.duration, 0);
    assert.deepEqual(info.sessions, []);
  }
});

test('unitDivisor: the unit is decided once from the track length, not per value', () => {
  // 500000 is a plausible half-second in microseconds AND a plausible position
  // in seconds, so a per-value guess is not safe. The length calibrates both.
  assert.equal(lm.unitDivisor('249000000'), 1e6);   // a real track in micros
  assert.equal(lm.unitDivisor('249'), 1);           // the same track in seconds
  assert.equal(lm.unitDivisor(''), 1e6);            // no length → trust the spec
  assert.equal(lm.unitDivisor('0'), 1e6);
  assert.equal(lm.unitDivisor('nonsense'), 1e6);
  // …and the calibration reaches the position, which is the point of it.
  const secs = { player: 'x', status: 'Playing', length: '249', position: '45' };
  const info = lm.shapeNowPlaying(secs, 0);
  assert.equal(info.duration, 249);
  assert.equal(info.position, 45);
});

test('shapeNowPlaying: a stream with no length still reports a position', () => {
  // A live stream or a video file with no mpris:length: duration 0 means the
  // widget hides the bar, but the elapsed time must still be right.
  const info = lm.shapeNowPlaying(lm.parseFollowLine(lines[4]), 0);
  assert.equal(info.duration, 0);
  assert.equal(info.active, true);
  assert.equal(info.app, 'VLC');
});

test('artUrl: only an http(s) artwork URL survives to the <img src>', () => {
  assert.equal(lm.artUrl('https://i.scdn.co/image/abc'), 'https://i.scdn.co/image/abc');
  assert.equal(lm.artUrl('http://example.org/a.png'), 'http://example.org/a.png');
  // A local player's file:// art cannot be served to the dashboard from here,
  // so it is dropped rather than emitted as a link the page fails to load.
  assert.equal(lm.artUrl('file:///home/me/.cache/art/cover.png'), null);
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA', '', null, 'ftp://x/y.png']) {
    assert.equal(lm.artUrl(bad), null, String(bad));
  }
  // …and the drop reaches the shaped payload, not just the helper.
  assert.equal(lm.shapeNowPlaying(lm.parseFollowLine(lines[5]), 0).thumbnail, null);
});

test('appNameFor: browser instances keep the substring the client matches on', () => {
  // js/media.js decides a session is a browser by testing data.source against
  // this. `chromium` had to be added there: it does not contain "chrome"
  // (chromi-um), so a Chromium MPRIS session was never recognised as a browser.
  const BROWSER_SOURCE_RE = /chrome|chromium|msedge|edge|firefox|brave|opera|vivaldi/i;
  const rec = lm.parseFollowLine(lines[3]);
  assert.ok(BROWSER_SOURCE_RE.test(rec.player));
  assert.equal(lm.shapeNowPlaying(rec, 0).source, rec.player);
  // The instance suffix is display noise, not identity.
  assert.equal(lm.appNameFor('chromium.instance2317'), 'Chromium');
  assert.equal(lm.appNameFor('firefox'), 'Firefox');
  assert.equal(lm.appNameFor('some-player'), 'Some-player');
  assert.equal(lm.appNameFor(''), 'Media');
  assert.equal(lm.appNameFor(null), 'Media');
});

test('shapeNowPlaying: an unknown status is Unknown, never passed through', () => {
  // MPRIS PlaybackStatus is a closed enum. A player that invents one must not
  // reach liveMediaSnapshot, which compares against 'Playing' exactly.
  const rec = { player: 'x', status: 'Buffering', length: '1000000', position: '0' };
  assert.equal(lm.shapeNowPlaying(rec, 0).playbackStatus, 'Unknown');
  assert.equal(lm.shapeNowPlaying({ ...rec, status: 'Stopped' }, 0).playbackStatus, 'Stopped');
});

test('commandArgs: transport verbs and absolute seek map to exact playerctl argv', () => {
  assert.deepEqual(lm.commandArgs('playpause'), ['play-pause']);
  assert.deepEqual(lm.commandArgs('next'), ['next']);
  assert.deepEqual(lm.commandArgs('previous'), ['previous']);
  // Every verb acts on the player the tile is SHOWING, never on whichever
  // playerctl's own default resolution picks: with Spotify playing and a
  // paused browser tab alive, an unscoped play-pause can hit the wrong app.
  assert.deepEqual(lm.commandArgs('playpause', undefined, 'spotify'),
    ['--player', 'spotify', 'play-pause']);
  assert.deepEqual(lm.commandArgs('next', undefined, 'chromium.instance2317'),
    ['--player', 'chromium.instance2317', 'next']);
  assert.deepEqual(lm.commandArgs('seek', 12.345678, 'spotify'),
    ['--player', 'spotify', 'position', '12.345678']);
  assert.deepEqual(lm.commandArgs('seek', 0), ['position', '0']);
  for (const bad of [-1, NaN, Infinity, 'nope', undefined]) {
    assert.equal(lm.commandArgs('seek', bad, 'spotify'), null, String(bad));
  }
  for (const bad of ['info', 'stop', 'open', '', null, undefined, 'toString', '__proto__']) {
    assert.equal(lm.commandArgs(bad), null, String(bad));
  }
});

test('createLinuxMedia: no playerctl is a supported state, not an error', () => {
  const host = lm.createLinuxMedia({ exe: '' });
  // An empty override falls back to a PATH lookup; on this machine there is no
  // playerctl, which is the path every Linux box without it takes.
  host.start();
  assert.equal(host.info().active, false);
  assert.equal(host.info().playbackStatus, 'Closed');
  host.stop();
});

test('createLinuxMedia: a command with no playerctl rejects cleanly', async () => {
  const host = lm.createLinuxMedia({ exe: '' });
  if (!host.available()) await assert.rejects(() => host.command('playpause'), /not installed/);
  assert.deepEqual(await host.command('seek', -1),
    { ok: false, error: 'bad_position', seekProtocol: 1 });
  await assert.rejects(() => host.command('nope'), /unsupported media action/);
});

test('FORMAT: the separator is a real tab, not the two-character escape', () => {
  // playerctl passes format text through verbatim. A backslash-t would arrive
  // as a backslash and every single line would fail to split.
  assert.ok(lm.FORMAT.includes('\t'));
  assert.ok(!lm.FORMAT.includes('\\t'));
  assert.equal(lm.FORMAT.split('\t').length, lm.FIELDS.length);
});
