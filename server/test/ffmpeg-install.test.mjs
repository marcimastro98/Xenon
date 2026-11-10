// FFmpeg from the app (server/ffmpeg-install/): the 5.1.0 setup no longer adds
// it. The download is pinned by SHA-256, a mismatch leaves nothing behind, only
// ffmpeg.exe and ffplay.exe land in server/ffmpeg/bin, and two clicks run one
// install. Downloads and unpacking are faked: nothing leaves this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../ffmpeg-install/ffmpeg-install.js');
const { createFfmpegInstall, ffmpegPresent } = mod;

const BYTES = Buffer.from('not really a zip');
const PIN = createHash('sha256').update(BYTES).digest('hex');

function rig(t, over = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'xenon-ffmpeg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = { download: 0, extract: [] };
  const inst = createFfmpegInstall({
    serverDir: dir,
    platform: 'win32',
    getFfmpegPath: () => path.join(dir, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    sha256: PIN,
    download: async (url, dest, onProgress) => {
      calls.download += 1;
      calls.url = url;
      onProgress(BYTES.length, BYTES.length);
      writeFileSync(dest, BYTES);
    },
    extract: async (zip, out, members) => {
      calls.extract.push(members);
      for (const m of members) writeFileSync(path.join(out, path.basename(m)), 'exe ' + path.basename(m));
    },
    ...over,
  });
  return { dir, inst, calls, bin: path.join(dir, 'ffmpeg', 'bin') };
}

test('the pin is one exact https build and its SHA-256', () => {
  assert.match(mod.FFMPEG_URL, /^https:\/\/github\.com\/GyanD\/codexffmpeg\/releases\/download\/9\.0\.2\/ffmpeg-9\.0\.2-essentials_build\.zip$/);
  assert.match(mod.FFMPEG_SHA256, /^[0-9a-f]{64}$/);
  assert.ok(mod.FFMPEG_URL.includes(mod.FFMPEG_VERSION) && mod.ZIP_BIN.includes(mod.FFMPEG_VERSION), 'bumped together');
  assert.deepEqual([...mod.KEEP], ['ffmpeg.exe', 'ffplay.exe']);
});

test('installs only ffmpeg and ffplay into server/ffmpeg/bin and cleans up', async (t) => {
  const { dir, inst, calls, bin } = rig(t);
  assert.equal(inst.status().installed, false);
  const res = await inst.install();
  assert.deepEqual(res, { ok: true, installed: true });
  assert.equal(calls.url, mod.FFMPEG_URL);
  assert.deepEqual(calls.extract, [[mod.ZIP_BIN + 'ffmpeg.exe', mod.ZIP_BIN + 'ffplay.exe']]);
  assert.equal(readFileSync(path.join(bin, 'ffmpeg.exe'), 'utf8'), 'exe ffmpeg.exe');
  assert.ok(existsSync(path.join(bin, 'ffplay.exe')));
  assert.equal(existsSync(path.join(dir, 'ffmpeg', '.download')), false, 'no zip left behind');
  assert.equal(inst.status().installed, true);
});

test('bytes that do not match the pin are deleted and nothing is unpacked', async (t) => {
  const { dir, inst, calls, bin } = rig(t, { sha256: 'a'.repeat(64) });
  const res = await inst.install();
  assert.equal(res.ok, false);
  assert.equal(res.error, 'install_failed');
  assert.match(res.message, /checksum mismatch/);
  assert.equal(calls.extract.length, 0);
  assert.equal(existsSync(path.join(bin, 'ffmpeg.exe')), false);
  assert.equal(existsSync(path.join(dir, 'ffmpeg', '.download', 'ffmpeg.zip')), false);
  assert.match(inst.status().error, /checksum mismatch/, 'the error is there for Settings to read');
});

test('two clicks run one install', async (t) => {
  const { inst, calls } = rig(t);
  const [a, b] = await Promise.all([inst.install(), inst.install()]);
  assert.deepEqual(a, b);
  assert.equal(calls.download, 1);
});

test('nothing is downloaded when FFmpeg is already there, or off Windows', async (t) => {
  const { inst, calls, bin } = rig(t);
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'ffmpeg.exe'), 'x');
  assert.deepEqual(await inst.install(), { ok: true, alreadyInstalled: true });
  const mac = rig(t, { platform: 'darwin' });
  assert.deepEqual(await mac.inst.install(), { ok: false, error: 'unsupported_platform' });
  assert.equal(mac.inst.status().supported, false);
  assert.equal(calls.download + mac.calls.download, 0);
});

test('a bare name counts as present only when it is on PATH', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xenon-ffmpeg-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(ffmpegPresent('ffmpeg.exe', { PATH: dir }), false);
  writeFileSync(path.join(dir, 'ffmpeg.exe'), 'x');
  assert.equal(ffmpegPresent('ffmpeg.exe', { PATH: dir }), true);
  assert.equal(ffmpegPresent(path.join(dir, 'nope.exe'), {}), false);
  assert.equal(ffmpegPresent('', {}), false);
});
