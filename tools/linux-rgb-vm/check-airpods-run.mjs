#!/usr/bin/env node
// Reads what an AirPods run left and prints one line per promise; exit 1 on any failure.
// node check-airpods-run.mjs <folder of the run>
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2];

const text = (file) => (fs.existsSync(path.join(DIR, file)) ? fs.readFileSync(path.join(DIR, file), 'utf8') : '');
const json = (file) => {
  try { return JSON.parse(text(file)); } catch { return {}; }
};
const scans = (file) => (text(file).match(/hci0 type \d discovering on/g) || []);

const none = json('read-none.json');
const connected = json('read-connected.json');
const off = json('read-off.json');
const gone = json('read-gone.json');
const named = (reading, name) => (reading.devices || []).find((device) => device.name === name);
const radio = text('btmon.log');

const CHECKS = [
  ['the pair really connected to bluetoothd', text('guest.log').includes('pair connected')],
  ['nothing connected: nothing listed, though the advert is in the air', none.devices?.length === 0],
  ['nothing connected: no scan was started', scans('pair-none.log').length === scans('pair-before.log').length],
  ['connected: the buds read 100', named(connected, 'AirPods Pro')?.percent === 100],
  ['connected: the case reads 70', named(connected, 'AirPods Pro case')?.percent === 70],
  ['connected: the buds say they charge, the case does not', named(connected, 'AirPods Pro')?.charging === true && named(connected, 'AirPods Pro case')?.charging === false],
  ['the radio scanned LE', /LE Set (Extended )?Scan Enable/.test(radio)],
  ['the radio ran no classic inquiry', !/Inquiry \(0x01\|0x0001\)/.test(radio)],
  ['the scan ended with the read', text('after-read.txt').includes('Discovering: no')],
  ['a reader killed mid-scan leaves no scan behind', text('during-kill.txt').includes('Discovering: yes') && text('after-kill.txt').includes('Discovering: no')],
  ['asking off: no AirPods listed', off.devices?.length === 0],
  ['after disconnecting: nothing listed', gone.devices?.length === 0],
];

let failed = 0;
for (const [promise, kept] of CHECKS) {
  console.log(`${kept ? 'ok  ' : 'FAIL'} ${promise}`);
  if (!kept) failed += 1;
}
if (failed) console.log(text('guest.log').slice(-3000));
console.log(`${CHECKS.length - failed}/${CHECKS.length}`);
process.exit(failed ? 1 : 0);
