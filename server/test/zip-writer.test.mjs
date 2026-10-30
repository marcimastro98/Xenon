// zip-writer.js: the bug report's .zip, read back with a reader that follows
// the format's own records (central directory → local header → data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writeZip, safeName, crc32, crc32Fallback } = require('../zip-writer.js');

function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'end record');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nlen = buf.readUInt16LE(at + 28);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nlen);
    assert.equal(buf.readUInt32LE(offset), 0x04034b50);
    assert.equal(buf.readUInt32LE(offset + 14), crc, `local crc of ${name}`);
    assert.equal(buf.readUInt32LE(offset + 18), csize, `local csize of ${name}`);
    const data = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const body = buf.subarray(data, data + csize);
    const raw = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    assert.equal(raw.length, size);
    assert.equal(crc32Fallback(raw), crc, `crc of ${name}`);
    out[name] = { raw, method };
    at += 46 + nlen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return out;
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-zip-'));
}

test('text is deflated, a video is stored, both read back byte for byte', async () => {
  const dir = tmp();
  try {
    const video = path.join(dir, 'clip.mp4');
    const big = Buffer.alloc(300000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 0xff;
    fs.writeFileSync(video, big);
    const log = path.join(dir, 'app.log');
    fs.writeFileSync(log, 'line\n'.repeat(5000));
    const out = path.join(dir, 'report.zip');
    const r = await writeZip(out, [
      { name: 'README.txt', data: 'Bug report\nàèì 日本\n' },
      { name: 'video.mp4', file: video },
      { name: 'logs/app.log', file: log },
    ]);
    assert.equal(r.count, 3);
    const buf = fs.readFileSync(out);
    assert.equal(r.bytes, buf.length);
    const z = readZip(buf);
    assert.equal(z['README.txt'].raw.toString('utf8'), 'Bug report\nàèì 日本\n');
    assert.equal(z['video.mp4'].method, 0);
    assert.ok(z['video.mp4'].raw.equals(big));
    assert.equal(z['logs/app.log'].method, 8);
    assert.equal(z['logs/app.log'].raw.toString(), 'line\n'.repeat(5000));
    assert.equal(fs.existsSync(out + '.part'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('names cannot leave the zip: no drive, no "..", no leading slash, no duplicates', async () => {
  assert.equal(safeName('..\\..\\Windows\\x.txt'), 'Windows/x.txt');
  assert.equal(safeName('/etc/passwd'), 'etc/passwd');
  assert.equal(safeName('C:\\x.txt'), 'x.txt');
  assert.equal(safeName('../'), '');
  const dir = tmp();
  try {
    const out = path.join(dir, 'r.zip');
    const r = await writeZip(out, [{ name: 'a.txt', data: '1' }, { name: './a.txt', data: '2' }, { name: '..', data: '3' }]);
    assert.equal(r.count, 1);
    assert.deepEqual(Object.keys(readZip(fs.readFileSync(out))), ['a.txt']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('past the size limit nothing is left on disk', async () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'big.mp4');
    fs.writeFileSync(f, Buffer.alloc(5000));
    const out = path.join(dir, 'r.zip');
    await assert.rejects(writeZip(out, [{ name: 'big.mp4', file: f }], { maxTotal: 1000 }), { code: 'too_big' });
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(out + '.part'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing file fails the zip instead of writing half of it', async () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'r.zip');
    await assert.rejects(writeZip(out, [{ name: 'x.txt', data: 'a' }, { name: 'gone.log', file: path.join(dir, 'nope.log') }]));
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the fallback CRC matches the standard one', () => {
  const b = Buffer.from('The quick brown fox jumps over the lazy dog');
  assert.equal(crc32Fallback(b), 0x414fa339);
  assert.equal(crc32(b), 0x414fa339);
  assert.equal(crc32Fallback(b.subarray(10), crc32Fallback(b.subarray(0, 10))), 0x414fa339);
});
