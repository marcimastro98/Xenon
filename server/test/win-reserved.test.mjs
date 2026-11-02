import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isWindowsReservedName } = require('../win-reserved.js');
const FT = require('../file-transfer.js');
const sp = require('../sound-packs.js');
const ip = require('../icon-packs.js');

test('reserved device names in every form Windows treats as a device', () => {
  for (const n of ['con', 'CON', 'con.txt', 'con .txt', 'CON   .tar.gz', 'aux', 'nul.mp3', 'prn',
    'conin$', 'CONOUT$.log', 'com1', 'COM9.jpg', 'com¹', 'LPT².txt', 'lpt³', 'com0']) {
    assert.equal(isWindowsReservedName(n), true, n);
  }
  for (const n of ['console', 'con-x', 'icon', 'com10', 'lpt', 'nulls.txt', 'aux_1', 'xcon.txt']) {
    assert.equal(isWindowsReservedName(n), false, n);
  }
});

test('deliveryName prefixes the new forms too', () => {
  assert.equal(FT.deliveryName('con .txt'), '_con .txt');
  assert.equal(FT.deliveryName('COM¹.jpg'), '_COM¹.jpg');
  assert.equal(FT.deliveryName('CONIN$'), '_CONIN$');
  assert.equal(FT.deliveryName('console.txt'), 'console.txt');
});

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20, 1)]).toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 0)]).toString('base64');

test('sound pack clip ids cannot be reserved device names', () => {
  const pack = (clipId) => ({ manifest: { id: 'my-pack', name: 'P' }, clips: [{ id: clipId, ext: 'mp3', data: MP3 }] });
  assert.equal(sp.validateSoundPack(pack('ding')).ok, true);
  for (const id of ['con', 'aux', 'nul', 'com1', 'lpt9']) {
    assert.equal(sp.validateSoundPack(pack(id)).error, 'bad_clip_id', id);
  }
});

test('icon pack icon ids cannot be reserved device names', () => {
  const pack = (iconId) => ({ manifest: { id: 'my-icons', name: 'P' }, icons: [{ id: iconId, type: 'png', data: PNG }] });
  for (const id of ['con', 'prn', 'com3']) {
    assert.equal(ip.validateIconPack(pack(id)).error, 'bad_icon_id', id);
  }
  const ok = ip.validateIconPack(pack('home'));
  assert.notEqual(ok.error, 'bad_icon_id');
});
