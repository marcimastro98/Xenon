'use strict';
// darwin-media.js — the pure half of the macOS now-playing bridge.
//
// What these lock is the CONTRACT, not the adapter: every field media.ps1
// defines and js/media.js reads has to come out of an adapter payload with the
// same name, the same unit (seconds) and the same playbackStatus vocabulary,
// because nothing above server.js knows which platform produced it.
//
// The fixture is written to the format the adapter documents (a line-delimited
// {type,diff,payload} envelope) rather than captured from a machine — this repo
// is developed on Windows. Re-capture it on a real Mac with:
//   /usr/bin/perl mediaremote-adapter.pl <framework> stream --no-diff --micros \
//     > darwin-mediaremote-stream.txt
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const dm = require('../darwin-media.js');

const here = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(join(here, 'fixtures', 'darwin-mediaremote-stream.txt'), 'utf8')
  .split(/\r?\n/);

test('parseStreamLine: keeps data envelopes and ignores everything else', () => {
  const parsed = lines.map((l) => dm.parseStreamLine(l));
  // The adapter's own diagnostics share stdout with the stream; a line that is
  // not a data envelope must never be guessed at.
  assert.equal(parsed[0], null, 'plain text line');
  assert.equal(parsed[lines.length - 1], null, 'trailing empty line');
  const frames = parsed.filter(Boolean);
  assert.equal(frames.length, 4);
  assert.equal(frames[0].diff, false);
  assert.equal(frames[1].diff, true);   // reported, so the host can refuse it
  assert.equal(frames[0].payload.title, 'Kiara');
  assert.deepEqual(frames[3].payload, {});
});

test('parseStreamLine: malformed and foreign lines are dropped, never thrown on', () => {
  for (const bad of ['', '   ', 'not json', '{oops', '{"type":"other","payload":{}}', '[]', 'null']) {
    assert.equal(dm.parseStreamLine(bad), null, bad);
  }
});

test('shapeNowPlaying: a playing track carries every key the widget reads', () => {
  const { payload } = dm.parseStreamLine(lines[1]);
  const info = dm.shapeNowPlaying(payload, 0);
  assert.equal(info.active, true);
  assert.equal(info.app, 'Spotify');
  assert.equal(info.source, 'com.spotify.client');   // the AUMID's counterpart
  assert.equal(info.title, 'Kiara');
  assert.equal(info.artist, 'Bonobo');
  assert.equal(info.album, 'Black Sands');
  assert.equal(info.playbackStatus, 'Playing');      // liveMediaSnapshot tests this exact string
  assert.equal(info.duration, 249);                  // micros in, SECONDS out
  assert.equal(info.position, 45);
  assert.equal(info.thumbnail, 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAA=');
  // One now-playing client on macOS, so the picker shows one entry rather than
  // an empty list that reads as broken.
  assert.equal(info.sessions.length, 1);
  assert.equal(info.sessions[0].selected, true);
  assert.equal(info.sessions[0].activePlayback, true);
});

test('shapeNowPlaying: the position advances while playing and holds while paused', () => {
  const playing = dm.parseStreamLine(lines[1]).payload;
  const paused = dm.parseStreamLine(lines[3]).payload;
  // MediaRemote pushes on change only, so a payload held for 20s would report a
  // 20s-old position if it were passed straight through.
  assert.equal(dm.shapeNowPlaying(playing, 20000).position, 65);
  assert.equal(dm.shapeNowPlaying(paused, 20000).position, 61);
  assert.equal(dm.shapeNowPlaying(paused, 20000).playbackStatus, 'Paused');
  // …and it never runs past the end of the track.
  assert.equal(dm.shapeNowPlaying(playing, 10 * 60 * 1000).position, 249);
});

test('shapeNowPlaying: an empty payload is the same "nothing playing" media.ps1 returns', () => {
  for (const empty of [null, undefined, {}, dm.parseStreamLine(lines[4]).payload]) {
    const info = dm.shapeNowPlaying(empty, 0);
    assert.equal(info.active, false);
    assert.equal(info.playbackStatus, 'Closed');
    assert.equal(info.title, '');
    assert.equal(info.thumbnail, null);
    assert.equal(info.position, 0);
    assert.equal(info.duration, 0);
    assert.deepEqual(info.sessions, []);
  }
});

test('shapeNowPlaying: seconds are accepted when the adapter reports no micros', () => {
  const info = dm.shapeNowPlaying(
    { bundleIdentifier: 'com.apple.Music', playing: true, title: 'x', duration: 200, elapsedTime: 10 }, 0);
  assert.equal(info.duration, 200);
  assert.equal(info.position, 10);
  assert.equal(info.app, 'Music');
});

test('artworkUri: a data: URI is assembled only from validated parts', () => {
  // The result becomes an <img src>, so neither half may be interpolated raw.
  assert.equal(dm.artworkUri({ artworkMimeType: 'image/png', artworkData: 'AAAA' }),
    'data:image/png;base64,AAAA');
  const rejected = [
    { artworkMimeType: 'text/html', artworkData: 'AAAA' },              // not an image
    { artworkMimeType: 'image/png"><script>', artworkData: 'AAAA' },    // breaks out of the URI
    { artworkMimeType: 'image/png', artworkData: 'AA A' },              // not base64
    { artworkMimeType: 'image/png', artworkData: 'AAAA;url(evil)' },
    { artworkMimeType: '', artworkData: 'AAAA' },
    { artworkMimeType: 'image/png', artworkData: '' },
    { artworkMimeType: 'image/png', artworkData: 'A'.repeat(7 * 1024 * 1024) }, // absurd
  ];
  for (const p of rejected) assert.equal(dm.artworkUri(p), null, JSON.stringify(p).slice(0, 60));
});

test('appNameFor: known bundles get their real name, unknown ones a readable one', () => {
  assert.equal(dm.appNameFor('com.spotify.client'), 'Spotify');
  assert.equal(dm.appNameFor('com.apple.Music'), 'Music');
  assert.equal(dm.appNameFor('com.acme.SomePlayer'), 'SomePlayer');
  assert.equal(dm.appNameFor('weirdname'), 'Weirdname');
  assert.equal(dm.appNameFor(''), 'Media');
  assert.equal(dm.appNameFor(null), 'Media');
});

test('appNameFor: browser bundles keep the substring the client matches on', () => {
  // js/media.js decides a session is a browser by testing data.source against
  // /chrome|msedge|edge|firefox|brave|opera|vivaldi/i — the bundle ids satisfy
  // it as they are, which is why `source` is passed through unmodified.
  const BROWSER_SOURCE_RE = /chrome|msedge|edge|firefox|brave|opera|vivaldi/i;
  for (const id of ['com.google.Chrome', 'com.microsoft.edgemac', 'org.mozilla.firefox',
    'com.brave.Browser', 'com.operasoftware.Opera', 'com.vivaldi.Vivaldi']) {
    assert.ok(BROWSER_SOURCE_RE.test(id), id);
    assert.equal(dm.shapeNowPlaying({ bundleIdentifier: id, title: 't' }, 0).source, id);
  }
});

test('commandCode: only the three transport verbs map, and nothing else does', () => {
  assert.equal(dm.commandCode('playpause'), '2');
  assert.equal(dm.commandCode('next'), '4');
  assert.equal(dm.commandCode('previous'), '5');
  // An unknown verb must not fall through to a number — every id in the
  // adapter's table does something, including stop and seek.
  for (const bad of ['info', 'stop', 'seek', '', null, undefined, 'toString', '__proto__']) {
    assert.equal(dm.commandCode(bad), null, String(bad));
  }
});

test('createDarwinMedia: an absent adapter is a supported state, not an error', () => {
  const host = dm.createDarwinMedia({ dir: join(here, 'fixtures', 'no-such-adapter') });
  assert.equal(host.available(), false);
  // start() must be a no-op rather than a spawn attempt, and info() must answer
  // the empty shape — this is the path every Mac without the adapter takes.
  host.start();
  assert.equal(host.info().active, false);
  assert.equal(host.info().playbackStatus, 'Closed');
  host.stop();
});

test('createDarwinMedia: a command against an absent adapter rejects cleanly', async () => {
  const host = dm.createDarwinMedia({ dir: join(here, 'fixtures', 'no-such-adapter') });
  await assert.rejects(() => host.command('playpause'), /unavailable/);
  await assert.rejects(() => host.command('nope'), /unsupported media action/);
});
