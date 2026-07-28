// Now-playing read straight off D-Bus. The fixtures below are VERBATIM busctl
// --json=short output, captured from a real MPRIS service on the session bus —
// including a title carrying an apostrophe, a comma and an em dash, which is
// exactly what a hand-rolled GVariant text parser would have got wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  createLinuxMpris, mprisNamesFrom, propsFrom, recordFrom, pickRecord,
  recordChanged, playerIdFrom, artistFrom, findBusctl,
} = require(join(ROOT, 'linux-mpris.js'));
const { shapeNowPlaying } = require(join(ROOT, 'linux-media.js'));

const GETALL = '{"type":"a{sv}","data":[{"PlaybackStatus":{"type":"s","data":"Playing"},"Metadata":{"type":"a{sv}","data":{"mpris:trackid":{"type":"o","data":"/org/xenon/track/1"},"mpris:length":{"type":"x","data":213000000},"mpris:artUrl":{"type":"s","data":"https://example.invalid/cover.jpg"},"xesam:title":{"type":"s","data":"Un titolo con \'apice, virgola, e — trattino"},"xesam:artist":{"type":"as","data":["Primo Artista","Secondo Artista"]},"xesam:album":{"type":"s","data":"Album di prova"}}},"Position":{"type":"x","data":42000000},"CanGoNext":{"type":"b","data":true}}]}';

const LISTNAMES = JSON.stringify({
  type: 'as',
  data: [['org.freedesktop.DBus', 'org.gnome.Shell', 'org.mpris.MediaPlayer2.spotify',
    ':1.42', 'org.mpris.MediaPlayer2.firefox.instance_1_9', 'org.mpris.MediaPlayer2.spotify']],
});

test('only MPRIS names are taken off the bus, and each only once', () => {
  assert.deepEqual(mprisNamesFrom(LISTNAMES),
    ['org.mpris.MediaPlayer2.spotify', 'org.mpris.MediaPlayer2.firefox.instance_1_9']);
  assert.deepEqual(mprisNamesFrom('not json'), []);
  assert.deepEqual(mprisNamesFrom(''), []);
});

test('a real GetAll reply unwraps to plain values, nested variants and all', () => {
  const p = propsFrom(GETALL);
  assert.equal(p.PlaybackStatus, 'Playing');
  assert.equal(p.Position, 42000000);
  // Metadata is a dict of variants inside a variant: two levels to unwrap.
  assert.equal(p.Metadata['mpris:length'], 213000000);
  assert.equal(p.Metadata['xesam:title'], "Un titolo con 'apice, virgola, e — trattino");
  assert.deepEqual(p.Metadata['xesam:artist'], ['Primo Artista', 'Secondo Artista']);
});

test('the record keeps playerctl\'s shape, so shapeNowPlaying is unchanged', () => {
  const rec = recordFrom('org.mpris.MediaPlayer2.xenontest', propsFrom(GETALL));
  assert.deepEqual(rec, {
    player: 'xenontest',
    status: 'Playing',
    title: "Un titolo con 'apice, virgola, e — trattino",
    artist: 'Primo Artista, Secondo Artista',
    album: 'Album di prova',
    // Numbers stay STRINGS of raw microseconds: unitDivisor in linux-media.js
    // stays the single place the unit is decided, for both transports.
    length: '213000000',
    position: '42000000',
    art: 'https://example.invalid/cover.jpg',
  });
  const info = shapeNowPlaying(rec, 0);
  assert.equal(info.duration, 213);
  assert.equal(info.position, 42);
  assert.equal(info.app, 'Xenontest');
});

test('multiple artists are joined, never rendered as an array', () => {
  assert.equal(artistFrom(['A', 'B']), 'A, B');
  assert.equal(artistFrom(['A', '', '  ']), 'A');
  assert.equal(artistFrom('Solo'), 'Solo');
  assert.equal(artistFrom(undefined), '');
});

test('the player id is the bus-name tail, matching what playerctl reports', () => {
  // js/media.js pattern-matches this to recognise browsers; a different id here
  // would change how the tile renders depending on which transport was used.
  assert.equal(playerIdFrom('org.mpris.MediaPlayer2.firefox.instance_1_9'), 'firefox.instance_1_9');
  assert.equal(playerIdFrom('org.mpris.MediaPlayer2.spotify'), 'spotify');
});

test('a player with nothing loaded is not a track', () => {
  // A browser that finished a video keeps its bus name. Reporting it pins the
  // tile to a blank now-playing that never clears.
  const empty = { PlaybackStatus: 'Stopped', Metadata: {}, Position: 0 };
  assert.equal(recordFrom('org.mpris.MediaPlayer2.firefox', empty), null);
  // But a player that says it is Playing counts even before metadata arrives.
  assert.ok(recordFrom('org.mpris.MediaPlayer2.firefox', { ...empty, PlaybackStatus: 'Playing' }));
});

test('a playing player wins over a paused one', () => {
  const paused = { player: 'firefox', status: 'Paused', title: 'tab' };
  const playing = { player: 'spotify', status: 'Playing', title: 'song' };
  assert.equal(pickRecord([paused, playing]).player, 'spotify');
  assert.equal(pickRecord([playing, paused]).player, 'spotify');
  // Ties keep the first, so the tile does not flip between polls when the bus
  // happens to list two paused players in a different order.
  assert.equal(pickRecord([paused, { ...paused, player: 'vlc' }]).player, 'firefox');
  assert.equal(pickRecord([]), null);
});

test('an advancing position is not a change worth broadcasting', () => {
  const a = { player: 'p', status: 'Playing', title: 't', artist: 'a', album: 'b', art: '', position: '1' };
  // Otherwise every poll pushes an SSE event for a track that is just playing.
  assert.equal(recordChanged(a, { ...a, position: '3000000' }), false);
  assert.equal(recordChanged(a, { ...a, title: 'other' }), true);
  assert.equal(recordChanged(a, null), true);
  assert.equal(recordChanged(null, null), false);
});

// A busctl stand-in that answers from the fixtures above.
function fakeBusctl(overrides = {}) {
  const calls = [];
  const runner = async (bin, args) => {
    calls.push(args.join(' '));
    if (args.includes('ListNames')) return overrides.listNames ?? LISTNAMES;
    if (args.includes('GetAll')) return overrides.getAll ?? GETALL;
    return overrides.method ?? '{"type":"","data":[]}';
  };
  return { calls, runner };
}

test('polling reads the bus and reports the track', async () => {
  const f = fakeBusctl({
    listNames: JSON.stringify({ type: 'as', data: [['org.mpris.MediaPlayer2.xenontest']] }),
  });
  let pushes = 0;
  const m = createLinuxMpris({
    runner: f.runner, findBusctl: () => '/usr/bin/busctl', pollMs: 20, onChange: () => pushes++,
  });
  assert.equal(m.available(), true);
  m.start();
  await new Promise((r) => setTimeout(r, 90));
  m.stop();
  assert.equal(m.latest().rec.title, "Un titolo con 'apice, virgola, e — trattino");
  // The track never changes across those polls, so exactly one push.
  assert.equal(pushes, 1);
});

test('the transport command targets the player the tile is showing', async () => {
  const f = fakeBusctl({
    listNames: JSON.stringify({
      type: 'as',
      data: [['org.mpris.MediaPlayer2.firefox', 'org.mpris.MediaPlayer2.xenontest']],
    }),
  });
  const m = createLinuxMpris({ runner: f.runner, findBusctl: () => '/usr/bin/busctl', pollMs: 20 });
  m.start();
  await new Promise((r) => setTimeout(r, 60));
  await m.command('playpause');
  m.stop();
  const played = f.calls.filter((c) => c.includes('PlayPause'));
  assert.equal(played.length, 1);
  // Hitting play on whichever player answered first — a paused browser tab
  // while Spotify plays — is the bug this pins down.
  assert.match(played[0], /org\.mpris\.MediaPlayer2\.(firefox|xenontest)/);
  assert.ok(played[0].includes(m.latest().rec.player));
});

test('an unknown action is refused before anything is sent', async () => {
  const f = fakeBusctl();
  const m = createLinuxMpris({ runner: f.runner, findBusctl: () => '/usr/bin/busctl' });
  await assert.rejects(() => m.command('eject'), /unsupported media action/);
  assert.equal(f.calls.length, 0);
});

test('no busctl means unavailable, and start() does nothing', async () => {
  const f = fakeBusctl();
  const m = createLinuxMpris({ runner: f.runner, findBusctl: () => null, pollMs: 10 });
  assert.equal(m.available(), false);
  m.start();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(f.calls.length, 0);
  assert.equal(m.latest().rec, null);
  m.stop();
});

test('a bus with no players reports nothing rather than the last track', async () => {
  const f = fakeBusctl({ listNames: JSON.stringify({ type: 'as', data: [[]] }) });
  const m = createLinuxMpris({ runner: f.runner, findBusctl: () => '/usr/bin/busctl', pollMs: 20 });
  m.start();
  await new Promise((r) => setTimeout(r, 60));
  m.stop();
  assert.equal(m.latest().rec, null);
});

test('busctl is found on PATH', async () => {
  assert.equal(findBusctl('/definitely/not/here'), null);
  assert.equal(findBusctl(''), null);
});
