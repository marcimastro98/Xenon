// user-folders.js: Documents, Pictures and Videos, OneDrive-aware on Windows.
// Pinned here: the registry value per folder, the redirected path when there
// is one, and the profile folder whenever the read fails or says nonsense.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { resolveUserFolder, replayRingDir } = require('../user-folders.js');

const regOut = (value, dir) => `\r\nHKEY_CURRENT_USER\\...\\Shell Folders\r\n    ${value}    REG_SZ    ${dir}\r\n`;

test('each folder reads its own shell-folder value, argv only', async () => {
  const seen = [];
  const execFile = (file, args, opts, cb) => { seen.push({ file, args, opts }); cb(null, regOut(args[3], 'D:\\OneDrive\\Immagini')); };
  assert.equal(await resolveUserFolder('pictures', { platform: 'win32', homedir: 'C:\\Users\\u', execFile }), 'D:\\OneDrive\\Immagini');
  assert.deepEqual(seen[0].args.slice(2), ['/v', 'My Pictures']);
  assert.equal(seen[0].file, 'reg');
  assert.equal(seen[0].opts.windowsHide, true);
  await resolveUserFolder('videos', { platform: 'win32', homedir: 'C:\\Users\\u', execFile });
  assert.equal(seen[1].args[3], 'My Video');
});

test('a failed or odd read falls back to the profile folder', async () => {
  const home = 'C:\\Users\\u';
  const fail = (_f, _a, _o, cb) => cb(new Error('no reg'));
  assert.equal(await resolveUserFolder('pictures', { platform: 'win32', homedir: home, execFile: fail }), path.join(home, 'Pictures'));
  const relative = (_f, args, _o, cb) => cb(null, regOut(args[3], 'Immagini'));
  assert.equal(await resolveUserFolder('pictures', { platform: 'win32', homedir: home, execFile: relative }), path.join(home, 'Pictures'));
  const throws = () => { throw new Error('spawn'); };
  assert.equal(await resolveUserFolder('videos', { platform: 'win32', homedir: home, execFile: throws }), path.join(home, 'Videos'));
});

test('macOS and Linux never run reg; Linux without user-dirs uses the profile folder', async () => {
  let called = false;
  const execFile = () => { called = true; };
  const missing = () => Promise.reject(new Error('ENOENT'));
  assert.equal(await resolveUserFolder('pictures', { platform: 'darwin', homedir: '/Users/u', execFile }), path.join('/Users/u', 'Pictures'));
  assert.equal(await resolveUserFolder('documents', { platform: 'linux', homedir: '/home/u', execFile, env: {}, readFile: missing }), path.join('/home/u', 'Documents'));
  assert.equal(called, false);
});

test('Linux reads the folders xdg-user-dirs named in the desktop language', async () => {
  const dirs = [
    '# This file is written by xdg-user-dirs-update',
    'XDG_DESKTOP_DIR="$HOME/Scrivania"',
    'XDG_PICTURES_DIR="$HOME/Immagini"',
    'XDG_VIDEOS_DIR="/mnt/media/Video"',
    'XDG_DOCUMENTS_DIR="$HOME/"',
  ].join('\n');
  const asked = [];
  const readFile = (file) => { asked.push(file); return Promise.resolve(dirs); };
  const opts = { platform: 'linux', homedir: '/home/u', env: {}, readFile };
  assert.equal(await resolveUserFolder('pictures', opts), path.normalize('/home/u/Immagini'));
  assert.equal(await resolveUserFolder('videos', opts), path.normalize('/mnt/media/Video'));
  // Set to the home itself = turned off: the profile folder, never the home.
  assert.equal(await resolveUserFolder('documents', opts), path.join('/home/u', 'Documents'));
  assert.equal(asked[0], path.join('/home/u', '.config', 'user-dirs.dirs'));
  await resolveUserFolder('pictures', { ...opts, env: { XDG_CONFIG_HOME: '/cfg' } });
  assert.equal(asked[3], path.join('/cfg', 'user-dirs.dirs'));
});

test('odd user-dirs values fall back to the profile folder', async () => {
  for (const line of ['XDG_PICTURES_DIR="Immagini"', 'XDG_PICTURES_DIR="$OTHER/x"', 'XDG_PICTURES_DIR=$HOME/x', '']) {
    const readFile = () => Promise.resolve(line);
    const got = await resolveUserFolder('pictures', { platform: 'linux', homedir: '/home/u', env: {}, readFile });
    assert.equal(got, path.join('/home/u', 'Pictures'), line);
  }
});

test('an unknown folder is refused', async () => {
  await assert.rejects(resolveUserFolder('system32', { platform: 'win32' }), /unknown folder/);
});

test('the replay ring is on disk: the cache folder on Linux, where /tmp is often memory', () => {
  const home = '/home/ana';
  assert.equal(replayRingDir({ platform: 'linux', homedir: home, env: {}, tmpdir: '/tmp' }),
    path.join(home, '.cache', 'xenon', 'Replay'));
  assert.equal(replayRingDir({ platform: 'linux', homedir: home, env: { XDG_CACHE_HOME: '/fast/cache' }, tmpdir: '/tmp' }),
    path.join('/fast/cache', 'xenon', 'Replay'));
  // A relative XDG_CACHE_HOME is ignored, as the spec says.
  assert.equal(replayRingDir({ platform: 'linux', homedir: home, env: { XDG_CACHE_HOME: 'cache' }, tmpdir: '/tmp' }),
    path.join(home, '.cache', 'xenon', 'Replay'));
  assert.equal(replayRingDir({ platform: 'win32', homedir: 'C:\Users\a', env: {}, tmpdir: 'C:\T' }),
    path.join('C:\T', 'Xenon Replay'));
  // macOS: the user's Caches folder, never /tmp.
  assert.equal(replayRingDir({ platform: 'darwin', homedir: '/Users/ana', env: {}, tmpdir: '/var/folders/x/T' }),
    path.join('/Users/ana', 'Library', 'Caches', 'Xenon', 'Replay'));
});
