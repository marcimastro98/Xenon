// The PC plays a Deck clip itself when no dashboard can (deck-sound-player.js):
// which player each OS tries, the volume, play/toggle/stop, and a player that
// is missing or cannot read the file handing it to the next.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDeckSoundPlayer, playersFor, volumeOf, MAX_CLIPS } = require('../deck-sound-player.js');

// A child process whose fate the test picks: 'play' keeps running (and says
// "playing" on stdout when asked), 'missing' is ENOENT, 'fail' exits 3.
function fakeSpawn(fates) {
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = opts.stdio[1] === 'pipe' ? new EventEmitter() : null;
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', null)); };
    spawned.push({ cmd, args, env: opts.env, child });
    const fate = typeof fates === 'function' ? fates(cmd) : fates;
    setImmediate(() => {
      if (fate === 'missing') child.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' }));
      else if (fate === 'fail') child.emit('exit', 3);
      else if (child.stdout) child.stdout.emit('data', 'playing\n');
    });
    return child;
  };
  return { spawn, spawned };
}

function player(platform, fates, extra = {}) {
  const fake = fakeSpawn(fates);
  const p = createDeckSoundPlayer({
    platform,
    resolveFile: async (raw) => (raw && !raw.includes('gone') ? raw : null),
    ffplay: async () => extra.ffplay || '',
    spawn: fake.spawn,
    graceMs: 5,
  });
  return { p, spawned: fake.spawned };
}

test('volume reads like the dashboard: 0-100, blank or bad is full', () => {
  assert.equal(volumeOf({ volume: 50 }), 0.5);
  assert.equal(volumeOf({ volume: '25,5' }), 0.255);
  assert.equal(volumeOf({ volume: '' }), 1, 'blank never mutes');
  assert.equal(volumeOf({ volume: 140 }), 1);
  assert.equal(volumeOf({}), 1);
});

test('each OS tries its own players, ffplay for what the system cannot read', () => {
  const win = playersFor('win32', 'C:\\s\\a.mp3', 0.5, '');
  assert.equal(win.length, 1);
  assert.equal(win[0].cmd, 'powershell.exe');
  assert.equal(win[0].env.XENON_SOUND_FILE, 'C:\\s\\a.mp3', 'the path travels in the environment');
  assert.ok(!win[0].args.join(' ').includes('a.mp3'), 'never inside the script');
  assert.deepEqual(playersFor('win32', 'C:\\s\\a.ogg', 1, ''), [], 'ogg needs ffplay on Windows');
  assert.equal(playersFor('win32', 'C:\\s\\a.ogg', 1, 'ffplay.exe')[0].cmd, 'ffplay.exe');
  assert.deepEqual(playersFor('darwin', '/s/a.m4a', 0.5, '')[0].args, ['-v', '0.5', '/s/a.m4a']);
  assert.deepEqual(playersFor('linux', '/s/a.ogg', 1, '').map((x) => x.cmd), ['pw-play', 'paplay']);
  assert.deepEqual(playersFor('linux', '/s/a.wav', 1, 'ffplay').map((x) => x.cmd), ['ffplay', 'pw-play', 'paplay', 'aplay']);
  assert.deepEqual(playersFor('linux', '/s/a.m4a', 1, ''), []);
});

test('a clip plays, and a second press starts it again from the top', async () => {
  const { p, spawned } = player('win32', 'play');
  assert.deepEqual(await p.play({ file: 'C:\\s\\a.mp3', volume: 40 }), { ok: true });
  assert.equal(spawned[0].env.XENON_SOUND_VOLUME, '0.4');
  assert.equal(await p.playing('C:\\s\\a.mp3'), true);
  await p.play({ file: 'C:\\s\\a.mp3' });
  assert.equal(spawned[0].child.killed, true, 'the first copy stopped');
  p.stop();
  assert.equal(spawned[1].child.killed, true, 'shutdown stops what plays');
});

test('toggle stops a playing clip, stop stops it, stop all stops every one', async () => {
  const { p, spawned } = player('darwin', 'play');
  await p.play({ file: '/s/a.mp3' });
  assert.deepEqual(await p.play({ file: '/s/a.mp3', mode: 'toggle' }), { ok: true });
  assert.equal(spawned.length, 1, 'toggle did not start another');
  assert.equal(await p.playing('/s/a.mp3'), false);
  await p.play({ file: '/s/a.mp3', mode: 'toggle' });
  assert.equal(spawned.length, 2, 'toggle on a silent clip plays it');
  assert.deepEqual(await p.play({ file: '/s/a.mp3', mode: 'stop' }), { ok: true });
  assert.equal(spawned[1].child.killed, true);
  await p.play({ file: '/s/b.mp3' });
  await p.play({ file: '/s/c.mp3' });
  p.stopAll();
  assert.ok(spawned.slice(2).every((s) => s.child.killed));
});

test('a missing file or format says so instead of staying silent', async () => {
  const { p } = player('win32', 'play');
  assert.deepEqual(await p.play({ file: 'C:\\gone.mp3' }), { ok: false, error: 'not_found' });
  assert.deepEqual(await p.play({ file: 'C:\\s\\a.opus' }), { ok: false, error: 'sound_format' });
  assert.deepEqual(await p.play({ file: 'C:\\gone.mp3', mode: 'stop' }), { ok: true }, 'nothing to stop is fine');
});

test('a player not installed, or unable to read the file, hands over to the next', async () => {
  const linux = player('linux', (cmd) => (cmd === 'pw-play' ? 'missing' : 'play'));
  assert.deepEqual(await linux.p.play({ file: '/s/a.ogg' }), { ok: true });
  assert.deepEqual(linux.spawned.map((s) => s.cmd), ['pw-play', 'paplay']);
  linux.p.stop();

  const win = player('win32', (cmd) => (cmd === 'powershell.exe' ? 'fail' : 'play'), { ffplay: 'ffplay.exe' });
  assert.deepEqual(await win.p.play({ file: 'C:\\s\\a.flac' }), { ok: true });
  assert.deepEqual(win.spawned.map((s) => s.cmd), ['powershell.exe', 'ffplay.exe']);
  win.p.stop();

  const none = player('linux', 'missing');
  assert.deepEqual(await none.p.play({ file: '/s/a.wav' }), { ok: false, error: 'sound_format' });
  const broken = player('darwin', 'fail');
  assert.deepEqual(await broken.p.play({ file: '/s/a.mp3' }), { ok: false, error: 'sound_failed' });
});

test('at most a few clips at once: the oldest makes room', async () => {
  const { p, spawned } = player('darwin', 'play');
  for (let i = 0; i <= MAX_CLIPS; i += 1) await p.play({ file: '/s/' + i + '.mp3' });
  assert.equal(spawned[0].child.killed, true);
  assert.equal(spawned.filter((s) => !s.child.killed).length, MAX_CLIPS);
  p.stop();
});
