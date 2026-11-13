// Issue #145: a Deck key that switches to "Kopfhörer" (headphones on a German
// Windows) did nothing, with no error. The device list from SoundVolumeView was
// read as latin1 while the tool wrote another encoding, so "ö" arrived as "Ã¶"
// and /SetDefault was handed a device that does not exist. Every German user
// has a device with an umlaut out of the box, and names in Japanese, Korean,
// Polish or Czech could not survive an ANSI export at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolveOutputDevice, pickToggleDevice, pickFirstConnected } from '../actions/registry.js';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { UTF8_EXPORT, decodeCsv, repairMojibake } = require('../svv-text.js');
const SERVER = engineSource();

const KOPF = 'Realtek(R) Audio\\Device\\Kopfhörer\\Render';
const NAMES = ['Kopfhörer', 'Lautsprecher (Gerät)', 'Słuchawki', 'Sluchátka ř', 'ヘッドホン', '헤드폰', '耳机', 'Écouteurs'];

// ── Reading the export ──────────────────────────────────────────────────────

test('the export asks SoundVolumeView for UTF-8 instead of trusting a default', () => {
  assert.deepEqual(UTF8_EXPORT, ['/SaveFileEncoding', '3']);
  assert.match(SERVER, /execFile\(SVV, \[\.\.\.svvText\.UTF8_EXPORT, '\/scomma', csv, '\/AvoidPrompts'\]/);
  assert.match(SERVER, /svvText\.decodeCsv\(await fs\.promises\.readFile\(csv\)\)/);
  assert.doesNotMatch(SERVER, /readFile\(csv, 'latin1'\)/, 'latin1 turns ö into Ã¶');
});

test('every name survives a UTF-8 export, with or without a BOM', () => {
  for (const name of NAMES) {
    const line = `"${name}","Device","Render"`;
    assert.equal(decodeCsv(Buffer.from(line, 'utf8')), line);
    assert.equal(decodeCsv(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(line, 'utf8')])), line);
  }
});

test('a UTF-16 export is read too, in either byte order', () => {
  const line = '"Kopfhörer","ヘッドホン"';
  const le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(line, 'utf16le')]);
  assert.equal(decodeCsv(le), line);
  const be = Buffer.from(Buffer.from(line, 'utf16le'));
  be.swap16();
  assert.equal(decodeCsv(Buffer.concat([Buffer.from([0xFE, 0xFF]), be])), line);
});

test('an ANSI export from an older setup still reads its Western names', () => {
  // cp1252 and latin1 agree on ö ä ü ß é: 0xF6 is not valid UTF-8 on its own.
  assert.equal(decodeCsv(Buffer.from('"Kopfhörer"', 'latin1')), '"Kopfhörer"');
});

// ── Keys saved before the fix ───────────────────────────────────────────────

test('a name misread as latin1 is recognised for what it was', () => {
  for (const name of NAMES) {
    const misread = Buffer.from(name, 'utf8').toString('latin1');
    if (misread === name) continue;
    assert.equal(repairMojibake(misread), name, name);
  }
});

test('a correct name is never "repaired" into something else', () => {
  for (const name of [...NAMES, 'Speakers', 'NVIDIA High Definition Audio', '', null]) {
    assert.equal(repairMojibake(name), null, String(name));
  }
});

test('a key saved with the misread name switches to the real device', () => {
  const live = [
    { id: KOPF, name: 'Kopfhörer', isDefault: false },
    { id: 'NVIDIA\\Device\\Lautsprecher\\Render', name: 'Lautsprecher', isDefault: true },
  ];
  const saved = Buffer.from(KOPF, 'utf8').toString('latin1');     // what the old list showed
  assert.equal(resolveOutputDevice(KOPF, live).id, KOPF);
  assert.equal(resolveOutputDevice(saved, live).id, KOPF);
  assert.equal(pickToggleDevice(saved, live[1].id, live).id, KOPF);
  assert.equal(pickFirstConnected([saved], live).id, KOPF);
});

test('the repair never reaches past the live output list', () => {
  // The safety rule stays: only a device in the OUTPUT list resolves, so a
  // microphone id, misread or not, still cannot be switched to.
  const mic = 'Realtek(R) Audio\\Device\\Mikrofon für Kopfhörer\\Capture';
  const live = [{ id: KOPF, name: 'Kopfhörer' }];
  assert.equal(resolveOutputDevice(Buffer.from(mic, 'utf8').toString('latin1'), live), null);
  assert.equal(resolveOutputDevice('Something\\Ã¶\\Render', live), null);
});
