// POST /pump/picture (server/pump-screen/picture.js): a picture of the person's own for a
// pump's Picture face, kept under a name made on the PC, with the pump pictures no screen
// uses any more cleared on the next upload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createPictureUpload, usedPictures, GRACE_MS } = require('../pump-screen/picture.js');

const BOUNDARY = 'xenonpumptest';
function request(name, type, data = Buffer.from('GIF89a')) {
  const head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="asset"; filename="${name}"\r\n` + (type ? `Content-Type: ${type}\r\n` : '') + '\r\n';
  const req = Readable.from([Buffer.concat([Buffer.from(head), data, Buffer.from(`\r\n--${BOUNDARY}--\r\n`)])]);
  req.headers = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
  return req;
}

function response() {
  const res = { status: 200, body: null };
  res.writeHead = (s) => { res.status = s; };
  res.end = (b) => { res.body = JSON.parse(b); };
  return res;
}

async function send(upload, req) {
  const res = response();
  await upload(req, res, { json: (b) => { res.body = b; } });
  return res;
}

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-pump-picture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const noScreens = { ready: async () => ({ screens: {} }) };

test('a GIF is kept under a name made here and answered as its /uploads/ address', async (t) => {
  const dir = folder(t);
  const upload = createPictureUpload({ store: noScreens, dir, clock: () => 1700000000000 });
  const res = await send(upload, request('../../my cat.gif', 'image/gif'));
  assert.equal(res.body.ok, true);
  assert.match(res.body.url, /^\/uploads\/pump-1700000000000-[0-9a-f]{1,8}\.gif$/);
  assert.equal(res.body.type, 'image/gif');
  assert.deepEqual(fs.readdirSync(dir), [res.body.url.slice('/uploads/'.length)], 'the name sent never reaches the disk');
  assert.equal(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'), 'GIF89a');
  const webm = await send(upload, request('loop.webm', 'video/webm'));
  assert.match(webm.body.url, /\.webm$/);
  assert.equal((await send(upload, request('photo', 'image/png'))).body.url.endsWith('.png'), true, 'the type stands in for a missing extension');
});

test('anything that is not a picture this face shows is refused, and nothing is written', async (t) => {
  const dir = folder(t);
  const upload = createPictureUpload({ store: noScreens, dir });
  for (const [name, type] of [['tool.exe', 'application/octet-stream'], ['page.html', 'text/html'], ['cat.png', 'text/html'], ['clip.mp4', 'video/mp4'], ['face.svg', 'image/svg+xml']]) {
    const res = await send(upload, request(name, type));
    assert.deepEqual([res.status, res.body], [400, { ok: false, error: 'bad_type' }], name);
  }
  const broken = Readable.from([Buffer.from('no parts')]);
  broken.headers = { 'content-type': 'text/plain' };
  assert.deepEqual((await send(upload, broken)).body, { ok: false, error: 'bad_request' });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('the pictures a screen shows are found on its usual face and its moments', () => {
  const model = { screens: {
    a: { base: { face: 'picture', items: ['/uploads/pump-1-a.gif', 'art:tide'] }, moments: [{ show: { face: 'picture', items: ['/uploads/pump-2-b.png'] } }, { show: { face: 'clock' } }] },
    b: { base: { face: 'sensors' }, moments: [] },
  } };
  assert.deepEqual([...usedPictures(model)].sort(), ['pump-1-a.gif', 'pump-2-b.png']);
  assert.deepEqual([...usedPictures(null)], []);
});

test('an upload clears the old pump pictures no screen uses, and nothing else', async (t) => {
  const dir = folder(t);
  const now = Date.now();
  const old = (name) => {
    fs.writeFileSync(path.join(dir, name), 'x');
    fs.utimesSync(path.join(dir, name), new Date(now - GRACE_MS - 60000), new Date(now - GRACE_MS - 60000));
  };
  old('pump-1-used.gif');
  old('pump-2-gone.gif');
  old('background-3.png');
  old('slideshow-4.gif');
  fs.writeFileSync(path.join(dir, 'pump-5-young.png'), 'x');
  old('pump-6-pinned.gif');
  const store = { ready: async () => ({ screens: { pump: { base: { face: 'picture', items: ['/uploads/pump-1-used.gif'] }, moments: [] } } }) };
  const pinned = () => [{ face: 'picture', items: ['/uploads/pump-6-pinned.gif'] }];
  const res = await send(createPictureUpload({ store, dir, pinned, clock: () => now }), request('new.gif', 'image/gif'));
  await new Promise((r) => setTimeout(r, 100));
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ['background-3.png', res.body.url.slice(9), 'pump-1-used.gif', 'pump-5-young.png', 'pump-6-pinned.gif', 'slideshow-4.gif'].sort(), 'a pinned picture stays too');
});
